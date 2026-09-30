// Admin view of coupons that exist in GHL (GLOBAL + MAIN), plus assigning GHL-origin
// coupons to affiliates and crediting past unassigned GHL orders.
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const affiliateStore = require('../utils/affiliateStore');

function errorMessage(err) {
    return err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to fetch GHL coupons';
}

/** Redemption in the shape shared by the usage endpoint and the assign/credit responses. */
function toUsageRedemption(r, locationKeyById) {
    return {
        id: r.id,
        source: r.source,
        status: r.status,
        email: r.email || null,
        fullName: r.fullName || null,
        currency: r.currency,
        baseAmount: r.baseAmount,
        discountAmount: r.discountAmount,
        commissionBase: r.commissionBase,
        affiliateFeeAmount: r.affiliateFeeAmount,
        affiliateEmail: r.affiliateEmail || null,
        createdAt: r.createdAt,
        ghlOrderId: r.ghlOrderId,
        isTest: r.isTest,
        ghlLocationKey: (r.ghlLocationId && locationKeyById.get(r.ghlLocationId)) || null
    };
}

function locationKeyMap() {
    return new Map(ghlService.getTrackedLocations().map((l) => [l.locationId, l.key]));
}

/** Live coupon lists from each tracked location; a failing location becomes an error string, never a throw. */
async function loadLiveGhlCoupons() {
    const locations = ghlService.getTrackedLocations();
    const errors = [];
    const settled = await Promise.all(locations.map(async (location) => {
        try {
            const listed = await ghlService.listCouponsForLocation(location);
            return { location, byCode: new Map(listed.coupons.map((c) => [couponStore.toCouponCode(c.code), c])) };
        } catch (err) {
            errors.push(`${location.key} (${location.locationId}): ${errorMessage(err)}`);
            return { location, byCode: null };
        }
    }));
    return { locations, live: settled, errors };
}

function locationStatus(coupon, entry) {
    const { location, byCode } = entry;
    if (!byCode) return { status: 'unknown', ghlCouponId: null };
    const found = byCode.get(coupon.code);
    if (found) return { status: String(found.status || 'active').toLowerCase(), ghlCouponId: found.id || null };
    const syncState = coupon.ghlSync?.[location.key]?.status;
    return { status: syncState === 'pending' || syncState === 'error' ? syncState : 'missing', ghlCouponId: null };
}

/** GHL percentage discountValue -> fraction (0..1); any other discount type -> 0. */
function ghlDiscountFraction(ghlCoupon) {
    if (ghlCoupon.discountType !== 'percentage') return 0;
    return Math.min(1, Math.max(0, (Number(ghlCoupon.discountValue) || 0) / 100));
}

/** Stand-in (not persisted) for a coupon that exists in GHL but not in our DB yet. */
function ghlOnlyCoupon(code, ghlCoupon) {
    return { code, origin: 'ghl', type: 'general', discountPercent: ghlDiscountFraction(ghlCoupon), affiliateFeePercent: 0, affiliateEmail: '', ghlSync: null };
}

async function usageCounts(codes) {
    if (codes.length === 0) return new Map();
    const { rows } = await pool.query(
        `SELECT code,
                COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'paid' AND source = 'ghl' AND affiliate_email IS NULL)::int AS unassigned_count
         FROM coupon_redemptions WHERE code = ANY($1::text[]) AND is_test = false GROUP BY code`,
        [codes]
    );
    return new Map(rows.map((r) => [r.code, { paidCount: r.paid_count, unassignedCount: r.unassigned_count }]));
}

async function buildItems(coupons, ctx) {
    const [counts, affiliates] = await Promise.all([usageCounts(coupons.map((c) => c.code)), affiliateStore.listAffiliates()]);
    const affiliatesByEmail = new Map(affiliates.map((a) => [a.email.toLowerCase(), a]));

    return coupons.map((coupon) => {
        let affiliate = null;
        if (coupon.type === 'affiliate') {
            const email = coupon.affiliateEmail || coupon.affiliate?.email;
            if (email) {
                const known = affiliatesByEmail.get(email.toLowerCase());
                affiliate = { email, name: known ? `${known.firstName} ${known.lastName}`.trim() : (coupon.affiliate?.name || '') };
            }
        }
        return {
            code: coupon.code,
            origin: coupon.origin,
            type: coupon.type,
            discountPercent: coupon.discountPercent,
            affiliateFeePercent: coupon.affiliateFeePercent,
            affiliate,
            locations: ctx.live.map((entry) => ({
                key: entry.location.key,
                locationId: entry.location.locationId,
                ...locationStatus(coupon, entry)
            })),
            usage: counts.get(coupon.code) || { paidCount: 0, unassignedCount: 0 }
        };
    });
}

// GET /api/admin/ghl-coupons
exports.list = async (req, res) => {
    try {
        const [ctx, allCoupons] = await Promise.all([loadLiveGhlCoupons(), couponStore.listCoupons()]);
        if (ctx.locations.length === 0) ctx.errors.push('No GHL location is configured');

        const included = allCoupons.filter((c) =>
            c.origin === 'ghl' || c.ghlSync || ctx.live.some((entry) => entry.byCode?.has(c.code)));

        // Hand-made GHL coupons no order has used yet: not in our DB, but assignable.
        const knownCodes = new Set(allCoupons.map((c) => c.code));
        const ghlOnly = new Map();
        for (const entry of ctx.live) {
            for (const [code, ghlCoupon] of entry.byCode || []) {
                if (code && !knownCodes.has(code) && !ghlOnly.has(code)) ghlOnly.set(code, ghlOnlyCoupon(code, ghlCoupon));
            }
        }
        res.json({ coupons: await buildItems([...included, ...ghlOnly.values()], ctx), errors: ctx.errors });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list GHL coupons' });
    }
};

async function itemFor(coupon) {
    const ctx = await loadLiveGhlCoupons();
    return (await buildItems([coupon], ctx))[0];
}

// POST /api/admin/ghl-coupons/:code/assign
exports.assign = async (req, res) => {
    try {
        const code = couponStore.toCouponCode(req.params.code);
        let coupon = await couponStore.findCoupon(code);

        // Not in our DB: it may still be a hand-made coupon that exists in GHL.
        let discovered = null;
        if (!coupon) {
            const ctx = await loadLiveGhlCoupons();
            const foundAt = ctx.live.filter((entry) => entry.byCode?.has(code));
            if (foundAt.length === 0) return res.status(404).json({ error: 'Coupon not found' });
            discovered = { ghlCoupon: foundAt[0].byCode.get(code), locationIds: foundAt.map((entry) => entry.location.locationId) };
        }

        const email = String(req.body?.affiliateEmail || '').trim();
        if (!email) return res.status(400).json({ error: 'affiliateEmail is required' });
        const affiliate = await affiliateStore.findAffiliateByEmail(email);
        if (!affiliate) return res.status(400).json({ error: 'No affiliate is registered with that email' });

        let feePercent = affiliateStore.AFFILIATE_FEE_PERCENT;
        const rawFee = req.body?.affiliateFeePercent;
        if (rawFee !== undefined && rawFee !== null && rawFee !== '') {
            feePercent = Number(rawFee);
            if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 1) {
                return res.status(400).json({ error: 'affiliateFeePercent must be a number between 0 and 1' });
            }
        }

        if (coupon && coupon.type === 'affiliate' && coupon.origin === 'local') {
            return res.status(400).json({ error: 'This affiliate coupon is tied to its affiliate and cannot be reassigned' });
        }

        if (discovered) {
            // Same creation the order importer does for an unseen code.
            await couponStore.createGhlDiscoveredCoupon({
                code, discountPercent: ghlDiscountFraction(discovered.ghlCoupon), locationId: discovered.locationIds[0]
            });
            for (const locationId of discovered.locationIds.slice(1)) await couponStore.addGhlLocationToCoupon(code, locationId);
            coupon = await couponStore.findCoupon(code);
        }

        await couponStore.setCouponAffiliation(coupon.code, { type: 'affiliate', affiliateEmail: affiliate.email, affiliateFeePercent: feePercent });
        const updated = await couponStore.findCoupon(coupon.code);
        const keyById = locationKeyMap();
        const creditable = (await couponStore.listCreditableRedemptions(coupon.code)).map((r) => toUsageRedemption(r, keyById));
        res.json({ coupon: await itemFor(updated), creditable });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to assign coupon' });
    }
};

// POST /api/admin/ghl-coupons/:code/credit-past
exports.creditPast = async (req, res) => {
    try {
        const coupon = await couponStore.findCoupon(req.params.code);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        if (coupon.type !== 'affiliate' || !coupon.affiliateEmail) {
            return res.status(409).json({ error: 'Coupon has no affiliate assigned - assign one first' });
        }

        let redemptionIds = null;
        const ids = req.body?.redemptionIds;
        if (ids !== undefined && ids !== null) {
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
                return res.status(400).json({ error: 'redemptionIds must be an array of strings' });
            }
            redemptionIds = ids;
        }

        const credited = await couponStore.creditRedemptions(coupon.code, {
            affiliateEmail: coupon.affiliateEmail,
            feePercent: coupon.affiliateFeePercent,
            redemptionIds
        });

        const totalsByCurrency = {};
        for (const r of credited) {
            const bucket = totalsByCurrency[r.currency] || (totalsByCurrency[r.currency] = { commission: 0 });
            bucket.commission = Number((bucket.commission + r.affiliateFeeAmount).toFixed(2));
        }
        res.json({ credited: credited.length, totalsByCurrency });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to credit past redemptions' });
    }
};

// POST /api/admin/ghl-coupons/:code/unassign
exports.unassign = async (req, res) => {
    try {
        const coupon = await couponStore.findCoupon(req.params.code);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        if (coupon.origin !== 'ghl') {
            return res.status(400).json({ error: 'Only GHL-discovered coupons can be unassigned' });
        }
        await couponStore.setCouponAffiliation(coupon.code, { type: 'general', affiliateEmail: null });
        res.json({ coupon: await itemFor(await couponStore.findCoupon(coupon.code)) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to unassign coupon' });
    }
};

exports.toUsageRedemption = toUsageRedemption;
exports.locationKeyMap = locationKeyMap;
