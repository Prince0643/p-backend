// controllers/embedController.js
// Public embed API. Never trusts client pricing or redirect URLs.
const { findProduct } = require('../utils/productCatalog');
const { resolveLegalLinks } = require('../utils/legalLinks');
const couponStore = require('../utils/couponStore');
const { computePricing } = require('../utils/pricing');
const { createPaymentIntent } = require('./paymentController');
const { getCheckoutMethodTypes } = require('../utils/paymongoMethodTypes');
const { getCardInstallmentOptions } = require('../utils/cardInstallments');

const money = (n) => Number(Number(n).toFixed(2));
const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

function billingOf(product) {
    return {
        type: product.billing.type,
        interval: product.billing.type === 'recurring' ? product.billing.interval || 'monthly' : null
    };
}

// Only fetches by id (never by name) so the public surface can't be used to enumerate.
async function lookupProduct(rawId) {
    const productId = str(rawId, 120);
    if (!productId) return { status: 400, error: 'productId is required' };
    const product = await findProduct({ productId });
    if (!product) return { status: 404, error: 'Product not found' };
    return { product };
}

// Display-only hint: will the real checkout offer card installments for this product?
// Mirrors createPaymentIntent -> paymongoService: same helper, same method types
// (product default paymentMethod via getCheckoutMethodTypes), same amount (computePricing
// finalAmount = tax-inclusive and including any setup fee, using the product's source - which also covers admin
// test-mode checkouts, as they run the same path). Deliberately PRE-coupon: coupons are
// entered later and the line stays static (the setup fee IS counted). The PAYMONGO_FILTER_METHOD_TYPES capability
// filter is NOT applied (no PayMongo API call per config load): for 'all'/'qrph'/'card'
// we assume the merchant has card enabled. Server decides; the browser never does.
async function installmentsAvailableFor(product) {
    try {
        const paymentMethodTypes = await getCheckoutMethodTypes({
            paymentMethod: product.defaults.paymentMethod || 'all',
            enableCapabilityFilter: false
        });
        const { finalAmount } = computePricing({ product, source: product.defaults.source });
        return Boolean(getCardInstallmentOptions({
            paymentMethodTypes,
            amountPhp: finalAmount,
            currency: product.currency
        }));
    } catch (err) {
        console.error('Embed installments check failed:', err.message);
        return false;
    }
}

exports.getProduct = async (req, res) => {
    try {
        const found = await lookupProduct(req.params.id);
        if (found.error) return res.status(found.status).json({ error: found.error });
        const { product } = found;
        const { termsUrl, privacyUrl } = await resolveLegalLinks(product);
        res.json({
            product: {
                id: product.id,
                name: product.name,
                currency: product.currency,
                amountPhp: product.amountPhp,
                setupFeePhp: product.setupFeePhp,
                taxRate: computePricing({ product, source: product.defaults.source }).taxRate,
                billing: billingOf(product),
                displaySuffix: product.defaults.displaySuffix || '',
                termsUrl,
                privacyUrl,
                installmentsAvailable: await installmentsAvailableFor(product)
            }
        });
    } catch (err) {
        console.error('Embed product lookup error:', err);
        res.status(500).json({ error: 'Failed to load product' });
    }
};

exports.quote = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const found = await lookupProduct(body.productId);
        if (found.error) return res.status(found.status).json({ error: found.error });
        const { product } = found;

        const promoCode = str(body.promoCode, 50);
        let promo = null;
        let discountPercent = 0;
        if (promoCode) {
            // Read-only: same rules as checkout's reservation, but nothing is reserved.
            const result = await couponStore.validateCouponReadOnly({
                code: promoCode,
                productId: product.id,
                email: str(body.email, 254)
            });
            if (result.coupon) {
                discountPercent = result.coupon.discountPercent;
                promo = {
                    code: result.coupon.code,
                    applied: true,
                    message: `Promo code applied: ${money(discountPercent * 100)}% off`
                };
            } else {
                promo = { code: promoCode, applied: false, message: result.error || 'Invalid promo code', reason: result.reason };
            }
        }

        const pricing = computePricing({ product, source: product.defaults.source, discountPercent });
        const billing = billingOf(product);
        res.json({
            productId: product.id,
            name: product.name,
            currency: product.currency,
            billing,
            displaySuffix: product.defaults.displaySuffix || '',
            subtotal: money(pricing.catalogAmount),
            setupFee: money(pricing.setupFee),
            discountPercent,
            discountAmount: money(pricing.discountAmount),
            taxRate: pricing.taxRate,
            taxAmount: money(pricing.taxAmount),
            total: money(pricing.finalAmount),
            promo,
            renewal: billing.type === 'recurring'
                ? { amount: money(pricing.fullPriceAmount), interval: 'monthly' }
                : null
        });
    } catch (err) {
        console.error('Embed quote error:', err);
        res.status(500).json({ error: 'Failed to compute quote' });
    }
};

// Delegates to createPaymentIntent with a whitelisted body: client success/cancel URLs
// (open-redirect guard), amounts, source and paymentMethod are never taken from the
// request - URLs come from the product/env defaults, source/paymentMethod from the product.
exports.checkout = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const productId = str(body.productId, 120);
        const product = productId ? await findProduct({ productId }) : null;
        if (!product) {
            return res.status(400).json({ error: 'Invalid product. Add it in /admin/products first.' });
        }
        // Consent is required whenever any legal link resolves for this product. The links are
        // resolved here (never taken from the client) so the audit record holds what was shown.
        const { termsUrl, privacyUrl } = await resolveLegalLinks(product);
        const consentRequired = Boolean(termsUrl || privacyUrl);
        if (consentRequired && body.termsAccepted !== true) {
            const what = termsUrl && privacyUrl ? 'the Terms and Conditions and Privacy Policy' : termsUrl ? 'the Terms and Conditions' : 'the Privacy Policy';
            return res.status(400).json({ error: `Please agree to ${what} to continue.` });
        }
        // Server-set (never read from the request body) so direct API callers cannot forge it.
        req.legalConsent = consentRequired ? { acceptedAt: new Date().toISOString(), termsUrl, privacyUrl } : null;
        req.body = {
            fullName: str(body.fullName, 200),
            email: str(body.email, 254),
            mobile: str(body.mobile, 40),
            productId: product.id,
            promoCode: str(body.promoCode, 50),
            businessName: str(body.businessName, 200),
            notes: str(body.notes, 2000),
            campaign: str(body.campaign, 100),
            attributionRef: str(body.attributionRef, 50),
            // Admin-issued, short-lived TEST-mode token (see utils/testMode.js). Forwarded as-is:
            // createPaymentIntent verifies it (403 if invalid/expired); without one the checkout is live.
            testToken: str(body.testToken, 2000),
            referredBy: str(body.referredBy, 200),
            source: product.defaults.source,
            paymentMethod: product.defaults.paymentMethod
        };
        return await createPaymentIntent(req, res);
    } catch (err) {
        console.error('Embed checkout error:', err);
        res.status(500).json({ error: 'Failed to create payment intent', message: err.message });
    }
};
