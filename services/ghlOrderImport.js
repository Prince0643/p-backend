// services/ghlOrderImport.js
// Imports native GHL checkout orders from BOTH tracked GHL locations - GLOBAL ("Nexistry
// Core Global", USD) and MAIN. Every non-invoice order (live OR test, with or without a
// coupon) is mirrored into digital_solutions_transactions as type 'ghl_order' for the admin
// Solutions page; test rows are flagged is_test and excluded from revenue. The default
// GET /payments/orders listing already returns both live and test-mode orders (verified
// against the live API: no paymentMode param needed). Separately, into coupon_redemptions, EVERY paid, live, non-invoice
// order carrying a coupon code is recorded: buyers are always tracked, and the affiliate
// is credited (fee on subtotal - discount, pre-tax) only when the coupon has one. Codes
// we have never seen are auto-created as general, GHL-origin, non-local coupons.
// PayMongo (LOCAL) sales are also mirrored into MAIN as invoices (see paymentController.js)
// - those (sourceType 'invoice') must be skipped here or they'd be double-counted.
const pool = require('../db/pool');
const ghlService = require('./ghlService');
const couponStore = require('../utils/couponStore');
const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const { retryPendingPushes } = require('./ghlCouponPush');

const NON_BACKFILL_LOOKBACK_DAYS = 45;
const PAGE_LIMIT = 100;
// Fixed advisory lock key so overlapping scheduler runs/processes skip instead of racing.
const ADVISORY_LOCK_KEY = 837_412_905;

function emptyLocationSummary() {
    return {
        scanned: 0,
        imported: 0,
        refunded: 0,
        flagged: 0,
        couponsCreated: 0,
        unassigned: 0,
        wouldImport: 0,
        solutionsRecorded: 0,
        solutionsUpdated: 0,
        wouldRecordSolutions: 0,
        wouldCreateCoupons: [],
        skipped: { noCoupon: 0, invoice: 0, test: 0 },
        errors: []
    };
}

function emptySummary(errors = [], { dryRun = false } = {}) {
    return { ...emptyLocationSummary(), errors, dryRun, locations: {}, pushRetry: null };
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

/** Finite number or null (so `0` is preserved but missing/garbage falls through to the next source). */
function toNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

const round2 = (n) => Number(n.toFixed(2));

/** GHL paymentStatus -> Solutions status. Known values map 1:1; anything else keeps its raw lowercased value ('pending' when empty). */
function mapGhlPaymentStatus(paymentStatus) {
    const raw = String(paymentStatus || '').toLowerCase();
    if (!raw) return 'pending';
    if (raw === 'unpaid') return 'pending';
    return raw;
}

/** Lazily fetches (once per order) the order detail; shared by the Solutions and coupon paths. Throws on failure. */
function makeDetailLoader(client, order) {
    let pending = null;
    return () => {
        if (!pending) {
            pending = client
                .get(`/payments/orders/${order._id}`, { params: { altId: order.altId, altType: 'location' } })
                .then((res) => res.data?.data || res.data);
        }
        return pending;
    };
}

/**
 * Mirrors one non-invoice order into digital_solutions_transactions. The detail is only fetched
 * when the row is new or its status changed (e.g. paid -> refunded); an unchanged order costs
 * one indexed lookup.
 */
async function recordSolution(location, order, summary, getDetail, { dryRun }) {
    const transactionId = `ghl:${order._id}`;
    const status = mapGhlPaymentStatus(order.paymentStatus);
    const existing = await digitalSolutionsStore.getGhlOrderState(transactionId);

    if (dryRun) {
        if (!existing) summary.wouldRecordSolutions++;
        return;
    }
    if (existing && existing.status === status) return;

    let detail;
    try {
        detail = (await getDetail()) || {};
    } catch (err) {
        summary.errors.push(`Failed to fetch order detail for ${order._id}: ${err.response?.data?.message || err.message}`);
        return;
    }

    const amountSummary = detail.amountSummary || {};
    const contact = detail.contactSnapshot || {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const productNames = items.map((item) => item.name || item.product?.name).filter(Boolean);
    const subtotal = toNum(amountSummary.subtotal) ?? toNum(order.subtotal);
    const discount = toNum(amountSummary.discount) ?? toNum(order.discount);
    // GHL's amountSummary has no total field; the order-level `amount` is what the customer paid.
    const total = toNum(amountSummary.total) ?? toNum(detail.amount) ?? toNum(order.amount)
        ?? (subtotal !== null ? round2(subtotal - (discount || 0)) : null);
    const isTest = isTestOrder(order) || isTestOrder(detail);
    const code = couponStore.toCouponCode(order.couponCode || detail.coupon?.code);
    const contactName = contact.name || contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(' ');

    const { action } = await digitalSolutionsStore.upsertGhlOrder({
        orderId: order._id,
        customerEmail: contact.email || order.contactEmail || '',
        customerName: contactName || order.contactName || '',
        productName: productNames.join(', '),
        ghlProductIds: extractItemProductIds(detail),
        amount: total,
        currency: order.currency || detail.currency || 'USD',
        promoCode: code || null,
        status,
        ghlPaymentStatus: order.paymentStatus || detail.paymentStatus || null,
        createdAt: order.createdAt,
        isTest,
        ghlLocationId: order.altId || location.locationId,
        raw: {
            orderStatus: detail.status || order.status || null,
            paymentStatus: order.paymentStatus || detail.paymentStatus || null,
            liveMode: detail.liveMode ?? order.liveMode ?? null,
            markAsTest: detail.markAsTest ?? null,
            source: { type: detail.source?.type || order.sourceType || null, name: detail.source?.name || order.sourceName || null },
            couponCode: code || null,
            subtotal,
            discount,
            tax: toNum(amountSummary.tax),
            shipping: toNum(amountSummary.shipping),
            total,
            currency: order.currency || detail.currency || 'USD',
            items: items.map((item) => ({
                name: item.name || item.product?.name || null,
                productId: item.product?._id || item.product?.id || null,
                quantity: item.qty ?? null,
                price: toNum(item.price?.amount)
            })),
            contact: { id: contact.id || order.contactId || null, email: contact.email || order.contactEmail || null, name: contactName || order.contactName || null }
        }
    });
    if (action === 'created') summary.solutionsRecorded++;
    else summary.solutionsUpdated++;
}

/**
 * The affiliate credited for a coupon, or null: affiliate-type coupon with an
 * affiliate_email, or one linked from affiliates.coupon_code. General coupons earn no
 * affiliate credit.
 */
async function resolveAffiliateCoupon(coupon) {
    if (!coupon || coupon.type !== 'affiliate') return null;
    if (coupon.affiliateEmail) return { coupon, affiliateEmail: coupon.affiliateEmail };

    const { rows } = await pool.query('SELECT email FROM affiliates WHERE coupon_code = $1 LIMIT 1', [coupon.code]);
    if (rows[0]) return { coupon, affiliateEmail: rows[0].email };

    return null;
}

async function processPaidOrder(location, order, summary, getDetail, { dryRun }) {
    const code = couponStore.toCouponCode(order.couponCode);
    if (!code) {
        summary.skipped.noCoupon++;
        return;
    }

    // Idempotency: an already-recorded order needs neither a detail fetch nor an insert.
    const { rowCount: alreadyRecorded } = await pool.query('SELECT 1 FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
    if (alreadyRecorded) return;

    let detail;
    try {
        detail = await getDetail();
    } catch (err) {
        summary.errors.push(`Failed to fetch order detail for ${order._id}: ${err.response?.data?.message || err.message}`);
        return;
    }

    // markAsTest is only reliably present on the order detail, not the list item.
    if (detail && isTestOrder(detail)) {
        summary.skipped.test++;
        return;
    }

    let coupon = await couponStore.findCoupon(code);
    if (!coupon) {
        if (dryRun) {
            if (!summary.wouldCreateCoupons.includes(code)) summary.wouldCreateCoupons.push(code);
        } else {
            const ghlCoupon = detail?.coupon;
            const discountPercent = ghlCoupon?.discountType === 'percentage' ? (toNum(ghlCoupon.discountValue) || 0) / 100 : 0;
            const created = await couponStore.createGhlDiscoveredCoupon({ code, discountPercent, locationId: location.locationId });
            if (created) summary.couponsCreated++;
            coupon = await couponStore.findCoupon(code);
        }
    } else if (coupon.origin === 'ghl' && !dryRun) {
        await couponStore.addGhlLocationToCoupon(code, location.locationId);
    }

    if (dryRun) {
        summary.wouldImport++;
        return;
    }

    const amountSummary = detail?.amountSummary || {};
    const discount = toNum(amountSummary.discount) ?? toNum(order.discount) ?? 0;
    const subtotal = toNum(amountSummary.subtotal) ?? toNum(order.subtotal) ?? ((toNum(order.amount) || 0) + discount);
    const commissionBase = round2(Math.max(subtotal - discount, 0));

    const resolved = await resolveAffiliateCoupon(coupon);
    const affiliateFeeAmount = resolved ? round2(commissionBase * Number(coupon.affiliateFeePercent || 0)) : 0;

    const contact = detail?.contactSnapshot || {};
    const inserted = await couponStore.insertGhlRedemption({
        orderId: order._id,
        code,
        email: contact.email || order.contactEmail || '',
        fullName: contact.name || contact.fullName || order.contactName || '',
        baseAmount: subtotal,
        discountAmount: discount,
        commissionBase,
        affiliateFeeAmount,
        affiliateEmail: resolved ? resolved.affiliateEmail : null,
        currency: order.currency || detail?.currency || 'USD',
        createdAt: order.createdAt,
        ghlLocationId: order.altId || location.locationId,
        ghlProductIds: extractItemProductIds(detail)
    });

    if (inserted) {
        summary.imported++;
        if (!resolved) summary.unassigned++;
    }
}

async function processOrder(client, location, order, summary, opts) {
    summary.scanned++;

    const getDetail = makeDetailLoader(client, order);
    // Solutions mirror first (independent of the coupon rules below); a failure here must not block affiliate crediting.
    if (!isInvoiceSourced(order)) {
        try {
            await recordSolution(location, order, summary, getDetail, opts);
        } catch (err) {
            summary.errors.push(`Solutions record for order ${order._id}: ${err.message}`);
        }
    }

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

    const paymentStatus = String(order.paymentStatus || '').toLowerCase();

    if (paymentStatus === 'paid') {
        await processPaidOrder(location, order, summary, getDetail, opts);
        return;
    }

    // Refund handling only touches rows we already recorded (not_found is a no-op).
    if (opts.dryRun) return;

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
 * Lists orders for one GHL location. In non-backfill mode, orders older than the
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

async function importLocationOrders(location, { backfill, dryRun }) {
    const summary = emptyLocationSummary();
    try {
        const client = ghlService.createClient({ privateKey: location.privateKey, locationId: location.locationId, version: '2021-07-28' });
        for await (const order of iterateOrders(client, location, { backfill })) {
            try {
                await processOrder(client, location, order, summary, { dryRun });
            } catch (err) {
                summary.errors.push(`Order ${order._id}: ${err.message}`);
            }
        }
    } catch (err) {
        summary.errors.push(`Failed to list orders: ${err.response?.data?.message || err.message}`);
    }
    return summary;
}

const SUMMED_FIELDS = ['scanned', 'imported', 'refunded', 'flagged', 'couponsCreated', 'unassigned', 'wouldImport', 'solutionsRecorded', 'solutionsUpdated', 'wouldRecordSolutions'];

/**
 * Imports orders from both tracked locations (GLOBAL, MAIN). The top-level summary
 * aggregates both; `locations.<key>` has the per-location breakdown. A failure in one
 * location never stops the other. `dryRun` reads GHL but writes nothing.
 */
async function importGlobalOrders({ backfill = false, dryRun = false } = {}) {
    const locations = ghlService.getTrackedLocations();
    if (locations.length === 0) {
        return emptySummary(['No GHL location is configured (GHL_GLOBAL_LOCATION_ID / GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL, GHL_LOCATION_ID + GHL_PRIVATE_KEY)'], { dryRun });
    }

    const lockClient = await pool.connect();
    let haveLock = false;
    try {
        const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
        haveLock = Boolean(rows[0]?.locked);
        if (!haveLock) {
            return emptySummary(['Another GHL order import is already running, skipped this run'], { dryRun });
        }

        const summary = emptySummary([], { dryRun });

        if (!dryRun) {
            try {
                summary.pushRetry = await retryPendingPushes();
            } catch (err) {
                summary.errors.push(`Affiliate coupon push retry failed: ${err.message}`);
            }
        }

        for (const location of locations) {
            const locationSummary = await importLocationOrders(location, { backfill, dryRun });
            summary.locations[location.key] = { locationId: location.locationId, ...locationSummary };
            for (const field of SUMMED_FIELDS) summary[field] += locationSummary[field];
            for (const key of Object.keys(summary.skipped)) summary.skipped[key] += locationSummary.skipped[key];
            for (const code of locationSummary.wouldCreateCoupons) {
                if (!summary.wouldCreateCoupons.includes(code)) summary.wouldCreateCoupons.push(code);
            }
            summary.errors.push(...locationSummary.errors.map((e) => `[${location.key}] ${e}`));
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
