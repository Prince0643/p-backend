const affiliateStore = require('../utils/affiliateStore');
const couponStore = require('../utils/couponStore');
const { issueToken } = require('../utils/authToken');

// POST /api/affiliates/login (public)
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const affiliate = await affiliateStore.verifyAffiliateCredentials({ email, password });
        if (!affiliate) return res.status(401).json({ error: 'Invalid email or password' });

        const token = issueToken({ type: 'affiliate', id: affiliate.id, email: affiliate.email });
        res.json({ success: true, token, affiliate });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to log in' });
    }
};

// GET /api/affiliates/me (requires auth) - everything the self-service dashboard needs
// in one call: profile, linked coupon, and redemption/earnings history.
exports.me = async (req, res) => {
    try {
        const affiliate = req.affiliate;
        const coupon = affiliate.couponCode ? await couponStore.findCoupon(affiliate.couponCode) : null;
        const redemptions = affiliate.couponCode ? await couponStore.listRedemptions({ code: affiliate.couponCode }) : [];

        const paidRedemptions = redemptions.filter((r) => r.status === 'paid');
        const totalEarnings = paidRedemptions.reduce((sum, r) => sum + r.affiliateFeeAmount, 0);

        res.json({
            success: true,
            affiliate,
            coupon,
            redemptions,
            stats: {
                totalRedemptions: redemptions.length,
                paidRedemptions: paidRedemptions.length,
                totalEarnings: Number(totalEarnings.toFixed(2))
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load dashboard' });
    }
};

// PATCH /api/affiliates/me/payout (requires auth)
exports.updatePayout = async (req, res) => {
    try {
        const updated = await affiliateStore.updateAffiliatePayout(req.affiliate.id, req.body || {});
        res.json({ success: true, affiliate: updated });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update payout details' });
    }
};
