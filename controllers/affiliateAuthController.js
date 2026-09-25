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

// GET /api/affiliates/me/campaigns (requires auth) - read-only list of the logged-in
// affiliate's own active campaigns, so they can copy/share their links.
// listCampaigns already attaches full stats {paidCount, pendingCount, revenue, discountTotal,
// commissionTotal} via campaignStore.fetchCampaignStatsMap (one aggregate query, no N+1) - the
// affiliate dashboard only needs paidCount/commissionTotal from it, extra fields are harmless.
exports.myCampaigns = async (req, res) => {
    try {
        const affiliate = req.affiliate;
        if (!affiliate.couponCode) return res.json({ success: true, campaigns: [] });
        const campaigns = await campaignStore.listCampaigns({ couponCode: affiliate.couponCode, active: true });
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
