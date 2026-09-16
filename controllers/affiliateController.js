const affiliateStore = require('../utils/affiliateStore');
const couponStore = require('../utils/couponStore');

// Flat program-wide rates (see meeting decision: 15% customer discount / 10% affiliate
// commission for every affiliate, regardless of payout region).
const AFFILIATE_DISCOUNT_PERCENT = 0.15;
const AFFILIATE_FEE_PERCENT = 0.10;

function generateUniqueCouponCode(seed) {
    const base = String(seed || 'AFF').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'AFF';
    for (let i = 0; i < 10; i++) {
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
        const code = `${base}${suffix}`;
        if (!couponStore.findCoupon(code)) return code;
    }
    throw new Error('Failed to generate a unique coupon code, please retry');
}

// POST /api/affiliates/register (public)
exports.register = (req, res) => {
    try {
        const normalized = affiliateStore.normalizeAffiliate(req.body);

        if (affiliateStore.findAffiliateByEmail(normalized.email)) {
            return res.status(409).json({ error: 'This email is already registered as an affiliate' });
        }

        const couponCode = generateUniqueCouponCode(`${normalized.firstName}${normalized.lastName}`);

        // One-time-use: this code is meant to be shared with exactly one customer.
        couponStore.upsertCoupon({
            code: couponCode,
            discountPercent: AFFILIATE_DISCOUNT_PERCENT,
            affiliateFeePercent: AFFILIATE_FEE_PERCENT,
            affiliateEmail: normalized.email,
            active: true,
            maxRedemptions: 1,
            productIds: [],
            notes: `Auto-generated for affiliate ${normalized.firstName} ${normalized.lastName} (${normalized.email}) on registration`
        });

        const affiliate = affiliateStore.createAffiliate(normalized, couponCode);

        res.status(201).json({
            success: true,
            affiliateId: affiliate.id,
            couponCode: affiliate.couponCode,
            discountPercent: AFFILIATE_DISCOUNT_PERCENT,
            affiliateFeePercent: AFFILIATE_FEE_PERCENT
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to register affiliate' });
    }
};

// GET /api/admin/affiliates (admin)
exports.list = (req, res) => {
    try {
        const affiliates = affiliateStore.listAffiliates();
        res.json({ success: true, affiliates });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list affiliates' });
    }
};

// GET /api/admin/affiliates/:id (admin)
exports.getOne = (req, res) => {
    try {
        const affiliate = affiliateStore.findAffiliateById(req.params.id);
        if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });
        res.json({ success: true, affiliate });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get affiliate' });
    }
};
