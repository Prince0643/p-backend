const affiliateStore = require('../utils/affiliateStore');
const couponStore = require('../utils/couponStore');
const { issueToken } = require('../utils/authToken');
const ghlService = require('../services/ghlService');

// Flat program-wide rates (see meeting decision: 15% customer discount / 10% affiliate
// commission for every affiliate, regardless of payout region).
const AFFILIATE_DISCOUNT_PERCENT = 0.15;
const AFFILIATE_FEE_PERCENT = 0.10;

const COUPON_CODE_LENGTH = 6;
const COUPON_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Auto-generated affiliate coupons are a fixed 6-character random code - short and easy to share/type. */
async function generateUniqueCouponCode() {
    for (let i = 0; i < 10; i++) {
        let code = '';
        for (let j = 0; j < COUPON_CODE_LENGTH; j++) {
            code += COUPON_CODE_CHARS[Math.floor(Math.random() * COUPON_CODE_CHARS.length)];
        }
        if (!(await couponStore.findCoupon(code))) return code;
    }
    throw new Error('Failed to generate a unique coupon code, please retry');
}

// POST /api/affiliates/register (public)
exports.register = async (req, res) => {
    try {
        const normalized = affiliateStore.normalizeAffiliate(req.body);

        if (await affiliateStore.findAffiliateByEmail(normalized.email)) {
            return res.status(409).json({ error: 'This email is already registered as an affiliate' });
        }

        const couponCode = await generateUniqueCouponCode();

        // One-time-use: this code is meant to be shared with exactly one customer.
        await couponStore.upsertCoupon({
            code: couponCode,
            discountPercent: AFFILIATE_DISCOUNT_PERCENT,
            affiliateFeePercent: AFFILIATE_FEE_PERCENT,
            affiliateEmail: normalized.email,
            active: true,
            maxRedemptions: 1,
            productIds: [],
            notes: `Auto-generated for affiliate ${normalized.firstName} ${normalized.lastName} (${normalized.email}) on registration`
        });

        const affiliate = await affiliateStore.createAffiliate(normalized, couponCode);
        let ghlCoupon = null;
        if (ghlService.isConfigured()) {
            try {
                ghlCoupon = await ghlService.createCoupon({
                    name: `${normalized.firstName} ${normalized.lastName} Affiliate`,
                    code: couponCode,
                    discountPercent: AFFILIATE_DISCOUNT_PERCENT,
                    maxRedemptions: 1
                });
                console.log('GHL affiliate coupon created:', ghlCoupon?._id || ghlCoupon?.id || couponCode);
            } catch (ghlErr) {
                console.log('GHL affiliate coupon creation failed (non-fatal):', ghlErr.response?.data || ghlErr.message);
            }
        }

        // Auto-login: registering creates the account AND the login in one step, so
        // the new affiliate lands straight on their dashboard with no separate
        // "verify your email" step (no email-sending infra exists here).
        const token = issueToken({ type: 'affiliate', id: affiliate.id, email: affiliate.email });

        res.status(201).json({
            success: true,
            affiliateId: affiliate.id,
            couponCode: affiliate.couponCode,
            discountPercent: AFFILIATE_DISCOUNT_PERCENT,
            affiliateFeePercent: AFFILIATE_FEE_PERCENT,
            ghlCouponId: ghlCoupon?._id || ghlCoupon?.id || null,
            token
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to register affiliate' });
    }
};

// GET /api/admin/affiliates (admin)
exports.list = async (req, res) => {
    try {
        const affiliates = await affiliateStore.listAffiliates();
        res.json({ success: true, affiliates });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list affiliates' });
    }
};

// GET /api/admin/affiliates/:id (admin)
exports.getOne = async (req, res) => {
    try {
        const affiliate = await affiliateStore.findAffiliateById(req.params.id);
        if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });

        const coupon = affiliate.couponCode ? await couponStore.findCoupon(affiliate.couponCode) : null;
        res.json({ success: true, affiliate, coupon });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get affiliate' });
    }
};

// PATCH /api/admin/affiliates/:id/status (admin)
// Suspending/terminating an affiliate deactivates their coupon so it stops working
// immediately; reactivating flips it back on (still subject to its own redemption cap).
exports.updateStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const affiliate = await affiliateStore.setAffiliateStatus(req.params.id, status);
        if (!affiliate) return res.status(404).json({ error: 'Affiliate not found' });

        if (affiliate.couponCode) {
            const coupon = await couponStore.findCoupon(affiliate.couponCode);
            if (coupon) {
                await couponStore.upsertCoupon({ ...coupon, active: status === 'active' });
            }
        }

        res.json({ success: true, affiliate });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update affiliate status' });
    }
};
