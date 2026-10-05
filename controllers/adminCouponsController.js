const {
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    listRedemptions,
    markRedemptionsPaid,
    totalsByCurrencyForCoupon
} = require('../utils/couponStore');
const affiliateStore = require('../utils/affiliateStore');
const ghlService = require('../services/ghlService');
const { importGlobalOrders } = require('../services/ghlOrderImport');
const { pushCouponSafe, pushLimitPerCustomerSafe } = require('../services/ghlCouponPush');
const { toUsageRedemption, locationKeyMap } = require('./adminGhlCouponsController');

exports.list = async (req, res) => {
    try {
        const coupons = await listCoupons({ type: req.query.type });
        res.json({ success: true, coupons });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list coupons' });
    }
};

exports.listGhlLocations = async (req, res) => {
    try {
        const locations = ghlService.getConfiguredLocations().map(({ locationId, name }) => ({ locationId, name }));
        res.json({ locations });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list GHL locations' });
    }
};

exports.listGhlCoupons = async (req, res) => {
    try {
        const [ghlResult, affiliates] = await Promise.all([
            ghlService.listCouponsAcrossLocations({
                search: req.query.search,
                status: req.query.status
            }),
            affiliateStore.listAffiliates()
        ]);

        const affiliatesByCode = new Map(
            affiliates
                .filter((affiliate) => affiliate.couponCode)
                .map((affiliate) => [String(affiliate.couponCode).toUpperCase(), affiliate])
        );
        const coupons = ghlResult.coupons.map((coupon) => {
            const affiliate = affiliatesByCode.get(String(coupon.code || '').toUpperCase());
            return {
                ...coupon,
                affiliate: affiliate
                    ? {
                        id: affiliate.id,
                        name: `${affiliate.firstName} ${affiliate.lastName}`.trim(),
                        email: affiliate.email,
                        status: affiliate.status
                    }
                    : null
            };
        });

        res.json({
            success: true,
            coupons,
            locations: ghlResult.locations,
            errors: ghlResult.errors
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list GHL coupons' });
    }
};

exports.syncGhlCoupons = async (req, res) => {
    try {
        const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
        const coupons = await listCoupons();
        const result = await ghlService.syncCouponsToGhlLocations(coupons, { dryRun });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to sync coupons to GHL' });
    }
};

exports.getOne = async (req, res) => {
    try {
        const coupon = await findCoupon(req.params.code);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true, coupon });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get coupon' });
    }
};

exports.upsert = async (req, res) => {
    try {
        const code = req.params.code || req.body?.code;
        const existing = code ? await findCoupon(code) : null;

        // Admins manage GENERAL coupons only. Affiliate coupons are created exclusively
        // by the affiliate-registration flow, and once created, their type is fixed.
        if (!existing && req.body?.type === 'affiliate') {
            return res.status(400).json({ error: 'Admins cannot create affiliate coupons directly' });
        }
        if (existing && req.body?.type !== undefined && req.body.type !== existing.type) {
            return res.status(400).json({ error: `Cannot change coupon "${existing.code}" from type "${existing.type}"` });
        }

        const saved = await upsertCoupon({
            ...req.body,
            code,
            type: existing ? existing.type : (req.body?.type || 'general'),
            origin: undefined, // origin is set by the system, never by the request body
            // The affiliate link of a GHL-origin coupon is managed only via assign/unassign.
            ...(existing?.origin === 'ghl'
                ? { affiliateEmail: existing.affiliateEmail, affiliateFeePercent: existing.affiliateFeePercent }
                : {})
        });
        // Local affiliate coupons are mirrored to GHL GLOBAL + MAIN (non-fatal; failures
        // are recorded per location and retried by the scheduled import).
        if (saved.type === 'affiliate' && saved.origin === 'local') await pushCouponSafe(saved.code);
        // A GHL-origin general coupon gets its limit pushed to GHL only when the admin changed it.
        if (existing && saved.type === 'general' && saved.origin === 'ghl'
            && existing.maxRedemptionsPerCustomer !== saved.maxRedemptionsPerCustomer) {
            await pushLimitPerCustomerSafe(saved.code);
        }
        res.json({ success: true, coupon: saved });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save coupon' });
    }
};

exports.remove = async (req, res) => {
    try {
        const ok = await deleteCoupon(req.params.code);
        if (!ok) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true });
    } catch (err) {
        // deleteCoupon() throws a specific "Cannot delete coupon..." message when it's
        // blocked by real linked data (affiliate/redemptions/transactions) - that's a
        // conflict the admin can act on, not a server error.
        const isBlockedDelete = /^Cannot delete coupon/.test(err.message || '');
        res.status(isBlockedDelete ? 409 : 500).json({ error: err.message || 'Failed to delete coupon' });
    }
};

exports.listRedemptions = async (req, res) => {
    try {
        const { code, status, payout } = req.query;
        const redemptions = await listRedemptions({ code, status, payout });
        res.json({ success: true, redemptions });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list redemptions' });
    }
};

exports.markRedemptionsPaid = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids (array) is required' });
        }
        const result = await markRedemptionsPaid(ids);
        // `updated` kept as a count for backward compatibility with existing callers;
        // updatedIds/skippedIds give the detail (skipped = already paid out, or not a
        // customer-paid redemption yet).
        res.json({ success: true, updated: result.updated.length, updatedIds: result.updated, skippedIds: result.skipped });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to mark redemptions paid' });
    }
};

exports.importGhlOrders = async (req, res) => {
    try {
        const backfill = Boolean(req.body?.backfill);
        const summary = await importGlobalOrders({ backfill });
        res.json({ success: true, ...summary });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to import GHL orders' });
    }
};

// GET /api/admin/coupons/:code/usage - every redemption of a coupon (all statuses) plus
// per-currency totals over PAID ones.
exports.usage = async (req, res) => {
    try {
        const coupon = await findCoupon(req.params.code);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        const redemptions = await listRedemptions({ code: coupon.code });
        const keyById = locationKeyMap();
        res.json({
            code: coupon.code,
            redemptions: redemptions.map((r) => toUsageRedemption(r, keyById)),
            totalsByCurrency: totalsByCurrencyForCoupon(redemptions)
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load coupon usage' });
    }
};
