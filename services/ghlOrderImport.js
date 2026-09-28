// services/ghlOrderImport.js
// Imports native GHL checkout orders from the "Nexistry Core Global" GHL location
// (USD, GLOBAL sales channel) into coupon_redemptions, crediting affiliates for sales
// that never touch our PayMongo checkout. PayMongo (LOCAL) sales are also mirrored into
// GHL as invoices (see paymentController.js) - those must be skipped here or they'd be
// double-counted.
const pool = require('../db/pool');
const ghlService = require('./ghlService');
const couponStore = require('../utils/couponStore');

const NON_BACKFILL_LOOKBACK_DAYS = 45;
const PAGE_LIMIT = 100;
// Fixed advisory lock key so overlapping scheduler runs/processes skip instead of racing.
const ADVISORY_LOCK_KEY = 837_412_905;

function emptySummary(errors = []) {
    return {
        scanned: 0,
        imported: 0,
        refunded: 0,
        flagged: 0,
        skipped: { noCoupon: 0, invoice: 0, unknownCode: 0, noAffiliate: 0, test: 0 },
        errors
    };
}

function isInvoiceSourced(order) {
    const sourceType = String(order.sourceType || order.source?.type || '').toLowerCase();
    return sourceType === 'invoice';
}

function isTestOrder(order) {
    if (order.liveMode === false) return true;
    if (order.markAsTest === true) return true;
    return false;
}

function extractItemProductIds(detail) {
    const items = Array.isArray(detail?.items) ? detail.items : [];
    return items
        .map((item) => item.product?._id || item.product?.id || item.id)
        .filter(Boolean);
}

/**
 * Finds the single active GLOBAL campaign (if any) whose site sells one of the order's
 * item products. One campaign now applies to every affiliate (no per-campaign coupon
 * filter), so a match here credits the campaign for ANY affiliate-type coupon. Zero or
 * multiple matches -> null (the affiliate is still credited, just without campaign
 * attribution).
 */
async function findCampaignMatch(itemProductIds) {
    if (!Array.isArray(itemProductIds) || itemProductIds.length === 0) return null;
    const { rows } = await pool.query(
        `SELECT DISTINCT c.id
         FROM campaigns c
         JOIN campaign_sites s ON s.id = c.site_id AND s.active = true AND s.channel = 'global'
         JOIN campaign_site_products csp ON csp.site_id = s.id AND csp.kind = 'ghl' AND csp.ref = ANY($1::text[])
         WHERE c.active = true`,
        [itemProductIds]
    );
    return rows.length === 1 ? rows[0].id : null;
}

/**
 * Looks up the coupon + any linked affiliate for a code. Returns null if the coupon
 * doesn't exist, isn't an affiliate-type coupon (general coupons earn no affiliate
 * credit, even via a Global order), or has no linked affiliate.
 */
async function resolveAffiliateCoupon(code) {
    const coupon = await couponStore.findCoupon(code);
    if (!coupon) return null;
    if (coupon.type !== 'affiliate') return null;

    if (coupon.affiliateEmail) return { coupon, affiliateEmail: coupon.affiliateEmail };

    const { rows } = await pool.query('SELECT email FROM affiliates WHERE coupon_code = $1 LIMIT 1', [couponStore.toCouponCode(code)]);
    if (rows[0]) return { coupon, affiliateEmail: rows[0].email };

    return null;
}

async function processPaidOrder(client, order, summary, { coupon, affiliateEmail }) {
    let detail;
    try {
        const res = await client.get(`/payments/orders/${order._id}`, { params: { altId: order.altId, altType: 'location' } });
        detail = res.data?.data || res.data;
    } catch (err) {
        summary.errors.push(`Failed to fetch order detail for ${order._id}: ${err.response?.data?.message || err.message}`);
        return;
    }

    const itemProductIds = extractItemProductIds(detail);
    // Only reached for affiliate-type coupons (see resolveAffiliateCoupon) - general
    // coupons never attribute a campaign.
    const campaignId = await findCampaignMatch(itemProductIds);

    const contact = detail?.contactSnapshot || {};
    const email = contact.email || order.contactEmail || '';
    const fullName = contact.name || contact.fullName || order.contactName || '';

    const affiliateFeeAmount = Number((Number(order.amount || 0) * Number(coupon.affiliateFeePercent || 0)).toFixed(2));

    const inserted = await couponStore.insertGhlRedemption({
        orderId: order._id,
        code: order.couponCode,
        email,
        fullName,
        baseAmount: Number(order.amount) || 0,
        discountAmount: Number(detail?.amountSummary?.discount ?? order.discount ?? 0),
        affiliateFeeAmount,
        affiliateEmail,
        currency: order.currency || 'USD',
        createdAt: order.createdAt,
        campaignId,
        ghlLocationId: order.altId,
        ghlProductIds: itemProductIds
    });

    if (inserted) summary.imported++;
}

async function processOrder(client, order, summary) {
    summary.scanned++;

    if (!order.couponCode) {
        summary.skipped.noCoupon++;
        return;
    }
    if (isInvoiceSourced(order)) {
        summary.skipped.invoice++;
        return;
    }
    if (isTestOrder(order)) {
        summary.skipped.test++;
        return;
    }

    const resolved = await resolveAffiliateCoupon(order.couponCode);
    if (!resolved) {
        // Distinguish "coupon doesn't exist at all" from "coupon exists but has no affiliate"
        const coupon = await couponStore.findCoupon(order.couponCode);
        if (!coupon) summary.skipped.unknownCode++;
        else summary.skipped.noAffiliate++;
        return;
    }

    const paymentStatus = String(order.paymentStatus || '').toLowerCase();

    if (paymentStatus === 'paid') {
        await processPaidOrder(client, order, summary, resolved);
        return;
    }

    if (paymentStatus === 'refunded') {
        const result = await couponStore.applyGhlRefund(order._id);
        if (result.action === 'released') summary.refunded++;
        else if (result.action === 'flagged') summary.flagged++;
        return;
    }

    if (paymentStatus === 'partially_refunded') {
        const result = await couponStore.flagPartialRefund(order._id);
        if (result.action === 'flagged') summary.flagged++;
        return;
    }
}

/**
 * Lists orders for the Global location. In non-backfill mode, orders older than the
 * lookback window are skipped rather than imported (recent refunds still need
 * catching, so this can't just look at orders created since the last run) - but we
 * deliberately do NOT stop paginating on the first old order we see. GHL's documented
 * sort order for this endpoint isn't something we've verified from a live account, so
 * assuming newest-first and early-returning would silently import nothing forever if
 * it turns out to be oldest-first (or unsorted). Order volume here is tiny (a handful
 * of orders per location), so scanning every page every run is cheap; pagination still
 * ends normally once a short/empty page comes back.
 */
async function* iterateOrders(client, location, { backfill }) {
    const cutoff = backfill ? null : Date.now() - NON_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await client.get('/payments/orders', {
            params: { altId: location.locationId, altType: 'location', limit: PAGE_LIMIT, offset }
        });
        const page = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
        if (page.length === 0) return;

        for (const order of page) {
            if (cutoff !== null) {
                const createdAt = new Date(order.createdAt).getTime();
                if (Number.isFinite(createdAt) && createdAt < cutoff) continue;
            }
            yield order;
        }

        if (page.length < PAGE_LIMIT) return;
        offset += PAGE_LIMIT;
    }
}

async function importGlobalOrders({ backfill = false } = {}) {
    const location = ghlService.resolveGlobalLocation();
    if (!location) {
        return emptySummary(['Global GHL location is not configured (GHL_GLOBAL_LOCATION_ID / GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL)']);
    }

    const lockClient = await pool.connect();
    let haveLock = false;
    try {
        const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
        haveLock = Boolean(rows[0]?.locked);
        if (!haveLock) {
            return emptySummary(['Another GHL order import is already running, skipped this run']);
        }

        const summary = emptySummary();
        const client = ghlService.createClient({ privateKey: location.privateKey, locationId: location.locationId, version: '2021-07-28' });

        try {
            for await (const order of iterateOrders(client, location, { backfill })) {
                try {
                    await processOrder(client, order, summary);
                } catch (err) {
                    summary.errors.push(`Order ${order._id}: ${err.message}`);
                }
            }
        } catch (err) {
            summary.errors.push(`Failed to list orders: ${err.response?.data?.message || err.message}`);
        }

        return summary;
    } finally {
        if (haveLock) {
            await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
        }
        lockClient.release();
    }
}

module.exports = { importGlobalOrders };
