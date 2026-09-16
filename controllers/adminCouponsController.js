const {
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    listRedemptions,
    markRedemptionsPaid
} = require('../utils/couponStore');

exports.list = (req, res) => {
    try {
        const coupons = listCoupons();
        res.json({ success: true, coupons });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list coupons' });
    }
};

exports.getOne = (req, res) => {
    try {
        const coupon = findCoupon(req.params.code);
        if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true, coupon });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get coupon' });
    }
};

exports.upsert = (req, res) => {
    try {
        const saved = upsertCoupon({ ...req.body, code: req.params.code || req.body?.code });
        res.json({ success: true, coupon: saved });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save coupon' });
    }
};

exports.remove = (req, res) => {
    try {
        const ok = deleteCoupon(req.params.code);
        if (!ok) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete coupon' });
    }
};

exports.listRedemptions = (req, res) => {
    try {
        const { code, status } = req.query;
        const redemptions = listRedemptions({ code, status });
        res.json({ success: true, redemptions });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list redemptions' });
    }
};

exports.markRedemptionsPaid = (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids (array) is required' });
        }
        const updated = markRedemptionsPaid(ids);
        res.json({ success: true, updated });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to mark redemptions paid' });
    }
};
