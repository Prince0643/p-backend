const { getGlobalLegalLinks, setGlobalLegalLinks } = require('../utils/legalLinks');
const {
    getAffiliateDiscountsPerCustomer,
    setAffiliateDiscountsPerCustomer,
    normalizeAffiliateDiscountsPerCustomer
} = require('../utils/couponSettings');
const { pushAllAffiliateCouponsSafe } = require('../services/ghlCouponPush');

async function loadSettings() {
    return {
        ...(await getGlobalLegalLinks()),
        affiliateDiscountsPerCustomer: await getAffiliateDiscountsPerCustomer()
    };
}

exports.get = async (req, res) => {
    try {
        res.json({ success: true, settings: await loadSettings() });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load settings' });
    }
};

exports.update = async (req, res) => {
    let settings;
    let affiliateLimitChanged = false;
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const hasAffiliateLimit = body.affiliateDiscountsPerCustomer !== undefined;
        // Validate before writing anything, so a bad value never leaves a partial save.
        if (hasAffiliateLimit) normalizeAffiliateDiscountsPerCustomer(body.affiliateDiscountsPerCustomer);
        await setGlobalLegalLinks(body);
        if (hasAffiliateLimit) {
            const before = await getAffiliateDiscountsPerCustomer();
            const after = await setAffiliateDiscountsPerCustomer(body.affiliateDiscountsPerCustomer);
            affiliateLimitChanged = before !== after;
        }
        settings = await loadSettings();
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to save settings' });
    }
    res.json({ success: true, settings });
    // Non-blocking, non-fatal: sync GHL's limitPerCustomer on affiliate coupons to the new setting.
    if (affiliateLimitChanged) pushAllAffiliateCouponsSafe();
};
