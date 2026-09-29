const affiliateStore = require('../utils/affiliateStore');
const couponStore = require('../utils/couponStore');
const campaignStore = require('../utils/campaignStore');
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
        // Own-coupon redemptions plus any redemption credited to this affiliate's email
        // (e.g. a GHL coupon an admin assigned to them).
        const redemptions = await couponStore.listRedemptionsForAffiliate({ email: affiliate.email, couponCode: affiliate.couponCode });

        const paidRedemptions = redemptions.filter((r) => r.status === 'paid');
        const totalEarnings = paidRedemptions.reduce((sum, r) => sum + r.affiliateFeeAmount, 0);

        // Per-currency breakdown: LOCAL (PayMongo, PHP) and GLOBAL (GHL, USD) sales are
        // both credited to the same affiliate, so a single-currency total would mix
        // currencies. Derived from status='paid' rows only. `commission` == `earned`.
        const totalsByCurrency = couponStore.affiliateTotalsByCurrency(redemptions);

        res.json({
            success: true,
            affiliate,
            coupon,
            redemptions,
            totalsByCurrency,
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

// GET /api/affiliates/me/campaigns (requires auth) - read-only list of EVERY active
// campaign (on an active site), each carrying this affiliate's own personal link and
// stats filtered to their coupon code - campaigns apply to all affiliates automatically,
// including one who registers after the campaign was created. An affiliate with no
// coupon code yet gets an empty list.
exports.myCampaigns = async (req, res) => {
    try {
        const affiliate = req.affiliate;
        const campaigns = await campaignStore.listActiveCampaignsForAffiliate(affiliate);
        res.json({ success: true, campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load campaigns' });
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
