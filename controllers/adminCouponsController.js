const {
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    listRedemptions,
    markRedemptionsPaid
} = require('../utils/couponStore');
const affiliateStore = require('../utils/affiliateStore');
const ghlService = require('../services/ghlService');

exports.list = async (req, res) => {
    try {
        const coupons = await listCoupons();
        res.json({ success: true, coupons });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list coupons' });
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
        const coupons = await listCoupons();
        const result = await ghlService.syncCouponsToGhlLocations(coupons);
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
        const saved = await upsertCoupon({ ...req.body, code: req.params.code || req.body?.code });
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
        const { code, status } = req.query;
        const redemptions = await listRedemptions({ code, status });
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
        const updated = await markRedemptionsPaid(ids);
        res.json({ success: true, updated });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to mark redemptions paid' });
    }
};
