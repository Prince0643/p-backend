// controllers/paymentController.js
const paymongoService = require('../services/paymongoService');
const webhookService = require('../services/webhookService');
const ghlService = require('../services/ghlService');
const clockistryController = require('./clockistryController');
const { generateId, validateEmail, validateMobile } = require('../utils/helpers');
const { computePricing } = require('../utils/pricing');
const { getCheckoutMethodTypes } = require('../utils/paymongoMethodTypes');
const { findProduct } = require('../utils/productCatalog');
const { getScheduleId, setScheduleId } = require('../utils/ghlInvoiceScheduleStore');
const couponStore = require('../utils/couponStore');
const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const ghlStudentUsers = require('../services/ghlStudentUsers');
const { resolveCheckoutMode, respondModeError, testPayloadFlags } = require('../utils/testMode');

async function resolveCatalogProduct({ productId, productName }) {
    const byId = productId ? await findProduct({ productId }) : null;
    if (byId) return byId;
    const byName = productName ? await findProduct({ productName }) : null;
    if (byName) return byName;
    return null;
}

// Create payment intent
exports.createPaymentIntent = async (req, res) => {
    // Set once a coupon reservation is actually committed (finalizeCouponReservation
    // succeeds), so the catch block below knows to release it if anything after that
    // point fails - otherwise a one-time coupon would stay reserved forever for a
    // checkout that never actually got created. Declared outside the try block so
    // catch can see it.
    let reservedPaymentReference = null;

    try {
        // Live unless the request carries a valid admin-issued test token (403 if present but
        // invalid/expired, 503 if test mode isn't configured - never a silent fallback to live).
        let checkoutMode;
        try {
            checkoutMode = await resolveCheckoutMode(req);
        } catch (modeErr) {
            if (respondModeError(res, modeErr)) return;
            throw modeErr;
        }
        const { isTest, paymongo } = checkoutMode;

        // ✅ FIXED: Added paymentMethod and source to destructuring
        const {
            fullName,
            email,
            mobile,
            product,
            productId,
            successUrl: requestSuccessUrl,
            cancelUrl: requestCancelUrl,
            notes,
            businessName,
            setupType,
            timezone,
            experienceLevel,
            coachingGoals,
            targetClient,
            paymentMethod, // ✅ ADD THIS - was missing!
            source,        // ✅ ADD THIS - was missing!
            amount,        // ✅ ADD: Receive amount from frontend (with discount)
            discountAmount, // ✅ ADD: Receive discount amount
            promoCode,     // ✅ ADD: Receive promo code used
            referredBy,
            attributionRef,  // coupon code carried by the ref cookie/localStorage (nx-ref.js)
            metadata = {}
        } = req.body;

        let normalizedProduct = String(product || '').trim();

        // Validate required fields
        if (!fullName || !email || !mobile || (!productId && !normalizedProduct)) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['fullName', 'email', 'mobile', 'productId (or product)']
            });
        }

        // Validate email
        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Validate mobile
        if (!validateMobile(mobile)) {
            return res.status(400).json({ error: 'Invalid mobile number format' });
        }

        // Product lookup (catalog-backed)
        const catalogProduct = await resolveCatalogProduct({ productId, productName: normalizedProduct });
        if (!catalogProduct) {
            return res.status(400).json({ error: 'Invalid product. Add it in /admin/products first.' });
        }
        if (!normalizedProduct) normalizedProduct = catalogProduct.name;
        const productInfo = { amount: catalogProduct.amountPhp, currency: catalogProduct.currency };

        // Generate unique payment reference
        const paymentReference = generateId('PAY');

        // Pricing is always computed server-side from the catalog price + tax rate.
        // A discount is only applied when a valid, active, non-expired promo code is
        // supplied — the client-sent `amount`/`discountAmount` are never trusted for
        // pricing, only echoed back for display/logging. This closes the hole where a
        // client could set any `amount` up to the catalog max without a real coupon.
        //
        // For a coupon with maxRedemptions set, the slot is reserved (as a 'pending'
        // coupon_redemptions row) right here at checkout creation - not only recorded
        // after payment.paid fires - so a second concurrent checkout with the same
        // one-time coupon can't also pass validation before the first one pays.
        // beginCouponReservation locks the coupon row and holds that lock (via an open
        // transaction) until finalizeCouponReservation commits the pending row below.
        let appliedCoupon = null;
        let couponReservationClient = null;
        const normalizedPromoCode = promoCode ? String(promoCode).trim() : '';
        const normalizedAttributionRef = attributionRef ? String(attributionRef).trim() : '';
        const effectivePromoCode = normalizedPromoCode || normalizedAttributionRef;
        // An explicitly typed promoCode must still hard-fail checkout on an invalid code
        // (existing behavior, preserved below). A ref carried in via nx-ref.js is best-effort:
        // if it doesn't resolve to a valid/active/eligible coupon, checkout just proceeds
        // without a discount instead of blocking the customer. nx-ref.js auto-fills the
        // #promoCode field with the ref when it's empty, so a request whose promoCode is
        // simply an echo of attributionRef (the customer never typed anything themselves)
        // must be treated as the soft ref path too - only a promoCode that actually
        // *differs* from the ref represents something the customer explicitly typed.
        const isExplicitlyTypedPromoCode = Boolean(normalizedPromoCode)
            && (!normalizedAttributionRef || couponStore.toCouponCode(normalizedPromoCode) !== couponStore.toCouponCode(normalizedAttributionRef));

        if (effectivePromoCode) {
            const reservation = await couponStore.beginCouponReservation({
                code: effectivePromoCode,
                productId: catalogProduct.id,
                email,
                isTest
            });
            if (!reservation.coupon) {
                if (isExplicitlyTypedPromoCode) {
                    return res.status(400).json({ error: reservation.error || 'Invalid promo code' });
                }
                console.log('Attribution ref rejected, proceeding without discount:', reservation.error);
            } else {
                appliedCoupon = reservation.coupon;
                couponReservationClient = reservation.client;
            }
        }

        // Shared with the embed quote endpoint (utils/pricing.js). fullPriceAmount is the
        // full (undiscounted) catalog price, taxed the same way: recurring renewals bill at
        // it (the discount only applies to the first payment) - stashed in payment metadata
        // below for the GHL invoice schedule created after payment.paid.
        const {
            taxRate,
            discountAmount: serverDiscountAmount,
            baseAmount,
            taxAmount,
            finalAmount,
            fullPriceAmount
        } = computePricing({
            product: catalogProduct,
            source,
            discountPercent: appliedCoupon ? appliedCoupon.discountPercent : 0
        });

        if (appliedCoupon && couponReservationClient) {
            // computePricing's baseAmount is already the post-discount, pre-tax amount
            // (catalog - discount), which is the commission basis.
            const commissionBase = baseAmount;
            const affiliateFeeAmount = Number((commissionBase * appliedCoupon.affiliateFeePercent).toFixed(2));
            await couponStore.finalizeCouponReservation(couponReservationClient, {
                code: appliedCoupon.code,
                paymentReference,
                productId: catalogProduct.id,
                email,
                fullName,
                baseAmount,
                discountAmount: serverDiscountAmount,
                commissionBase,
                affiliateFeeAmount,
                affiliateEmail: appliedCoupon.affiliateEmail || referredBy || '',
                currency: productInfo.currency,
                isTest
            });
            // finalizeCouponReservation already committed + released the client above.
            // Track the reference so the catch block can release the hold if anything
            // after this point (PayMongo call, etc.) fails.
            reservedPaymentReference = paymentReference;
        }

        console.log('Computed server-side pricing:', {
            catalogAmount: productInfo.amount,
            promoCode: appliedCoupon?.code || 'none',
            serverDiscountAmount,
            baseAmount,
            taxAmount,
            finalAmount
        });

        // Log what we received for debugging
        console.log('Received payment request:', {
            fullName,
            email,
            mobile,
            product: normalizedProduct,
            paymentMethod,
            source,
            frontendAmount: amount,
            frontendDiscountAmount: discountAmount,
            promoCode: normalizedPromoCode
        });

        // FIXED: Flatten metadata - include paymentMethod and source
        const flattenedMetadata = {
            // Required fields
            fullName: String(fullName || ''),
            email: String(email || ''),
            mobile: String(mobile || ''),
            product: String(normalizedProduct || ''),
            productId: String(catalogProduct?.id || productId || ''),
            paymentReference: String(paymentReference || ''),

            baseAmount: String(baseAmount),
            taxRate: String(taxRate),
            taxAmount: String(taxAmount),
            totalAmount: String(finalAmount),

            // ADD: Discount information (server-computed, not client-trusted)
            discountAmount: String(serverDiscountAmount || 0),
            promoCode: String(appliedCoupon?.code || ''),

            // Full (undiscounted, taxed) price - used to bill recurring renewals at full
            // price even when the first payment was discounted (see the GHL invoice
            // schedule creation in handlePaymentSuccess below).
            fullPriceAmount: String(fullPriceAmount),

            // ADD: Referral information
            referredBy: String(referredBy || ''),

            // Optional fields
            notes: String(notes || ''),
            businessName: String(businessName || ''),
            setupType: String(setupType || ''),
            timezone: String(timezone || ''),
            experienceLevel: String(experienceLevel || ''),
            coachingGoals: String(coachingGoals || ''),
            targetClient: String(targetClient || ''),

            // ✅ ADDED: These were missing!
            paymentMethod: String(paymentMethod || 'gcash'),
            source: String(source || 'nexistry_academy'),

            // Timestamp
            timestamp: new Date().toISOString()
        };

        // Remove any empty values that PayMongo might reject
        Object.keys(flattenedMetadata).forEach(key => {
            if (flattenedMetadata[key] === '' || flattenedMetadata[key] === 'undefined' || flattenedMetadata[key] === 'null') {
                delete flattenedMetadata[key];
            }
        });

        // Log the metadata being sent to PayMongo
        console.log('Sending to PayMongo with metadata:', flattenedMetadata);

        // Create PayMongo payment intent with flattened metadata
        // NOTE: If you only pass ['qrph'], the checkout page will only show the QRPh scan option.
        // To show the e-wallet + online banking list (GCash/GrabPay/Maya/ShopeePay/BPI/UnionBank),
        // you must include those method types in the checkout session.
        const selectedPaymentMethod = paymentMethod || 'qrph';
        const enableCapabilityFilter = String(process.env.PAYMONGO_FILTER_METHOD_TYPES || '').toLowerCase() === 'true';

        const paymentMethods = await getCheckoutMethodTypes({
            paymentMethod: selectedPaymentMethod,
            paymongoService: paymongo,
            enableCapabilityFilter
        });

        console.log('Payment method selected:', selectedPaymentMethod, 'checkout types:', paymentMethods);

        const catalogSuccessUrl = catalogProduct?.defaults?.successUrl;
        const catalogCancelUrl = catalogProduct?.defaults?.cancelUrl;

        const coreSuccessUrlDefault = 'https://nexistrycoreph.nexistrydigitalsolutions.com/product-thank-you-page-703324-971918-441701';
        const coreCancelUrlDefault = 'https://nexistrycoreph.nexistrydigitalsolutions.com/ph-ver-753092';

        const successUrl = requestSuccessUrl
            || catalogSuccessUrl
            || (source === 'nexistry_core_ph' ? (process.env.NX_CORE_FRONTEND_SUCCESS_URL || coreSuccessUrlDefault) : undefined);

        const failureUrl = (source === 'nexistry_core_ph')
            ? (process.env.NX_CORE_FRONTEND_FAILURE_URL || process.env.FRONTEND_FAILURE_URL)
            : undefined;

        const cancelUrl = requestCancelUrl
            || catalogCancelUrl
            || (source === 'nexistry_core_ph' ? coreCancelUrlDefault : undefined);

        // Some PayMongo method types may be eligible for Checkout, but not accepted in PaymentIntent's
        // `payment_method_allowed` field. Keep a conservative allowlist for PaymentIntent, while
        // still offering the full set in Checkout Session `payment_method_types`.
        const checkoutMethodTypes = paymentMethods;
        const paymentIntentAllowed = paymentMethods
            // PayMongo PaymentIntent `payment_method_allowed` does not accept brankas_* capability identifiers.
            // These are only attempted in Checkout Session `payment_method_types` behind a feature flag.
            .filter((m) => !String(m).startsWith('brankas_'))
            // Normalize UBP capability to DOB for PaymentIntent allowlist.
            .map((m) => (m === 'dob_ubp' ? 'dob' : m));

        const paymentIntent = await paymongo.createPaymentIntent({
            amount: finalAmount,
            currency: productInfo.currency,
            description: `${normalizedProduct} - ${fullName}${appliedCoupon ? ` (Promo: ${appliedCoupon.code})` : ''}`,
            paymentMethodAllowed: paymentIntentAllowed,
            paymentMethodTypes: checkoutMethodTypes,
            metadata: flattenedMetadata,
            successUrl,
            failureUrl,
            cancelUrl
        });

        console.log('Payment intent created:', paymentIntent.id);

        await digitalSolutionsStore.recordTransaction({
            type: 'academy_product',
            transactionId: paymentReference,
            customerEmail: email,
            customerName: fullName,
            productId: catalogProduct.id,
            productName: normalizedProduct,
            amount: finalAmount,
            currency: productInfo.currency,
            promoCode: appliedCoupon?.code,
            source,
            status: 'initiated',
            isTest,
            paymongoPaymentIntentId: paymentIntent.id
        });

        // Send to LeadConnector webhook - include paymentMethod and source
        await webhookService.sendToLeadConnector({
            fullName,
            email,
            mobile,
            product: normalizedProduct,
            amount: finalAmount,
            currency: productInfo.currency,
            paymentReference,
            baseAmount: baseAmount,
            taxRate: taxRate,
            taxAmount: taxAmount,
            discountAmount: serverDiscountAmount,
            promoCode: appliedCoupon?.code || '',
            notes,
            businessName,
            setupType,
            timezone,
            experienceLevel,
            coachingGoals,
            targetClient,
            paymentMethod, // ✅ Now included
            source,        // ✅ Now included
            referredBy: referredBy || '',
            status: 'payment_initiated',
            paymentIntentId: paymentIntent.id,
            checkoutUrl: paymentIntent.attributes.checkout_url,
            timestamp: new Date().toISOString(),
            ...testPayloadFlags(isTest)
        }).catch(err => console.log('LeadConnector webhook error:', err.message));

        // Return payment details to frontend
        res.status(200).json({
            success: true,
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.attributes.client_secret,
            checkoutUrl: paymentIntent.attributes.checkout_url,
            paymentReference,
            amount: finalAmount,
            baseAmount: baseAmount,
            taxRate: taxRate,
            taxAmount: taxAmount,
            discountAmount: serverDiscountAmount,
            promoCode: appliedCoupon?.code || '',
            currency: productInfo.currency,
            // Test checkouts are flagged so the caller can show its TEST MODE banner; live
            // responses are unchanged.
            ...(isTest ? { testMode: true } : {})
        });

    } catch (error) {
        console.error('Payment intent creation error:', error);
        if (reservedPaymentReference) {
            await couponStore.releaseReservation(reservedPaymentReference).catch((releaseErr) => {
                console.error('Failed to release coupon reservation after payment intent error:', releaseErr.message);
            });
        }
        res.status(500).json({
            error: 'Failed to create payment intent',
            message: error.message
        });
    }
};

// Diagnostic: Expose PayMongo merchant method capabilities (sanitized)
exports.getPaymongoCapabilities = async (req, res) => {
    try {
        let paymongo;
        try {
            ({ paymongo } = await resolveCheckoutMode(req));
        } catch (modeErr) {
            if (respondModeError(res, modeErr)) return;
            throw modeErr;
        }
        const capabilities = await paymongo.getMerchantPaymentMethodCapabilities();

        const sanitized = (capabilities || []).map((pm) => {
            // PayMongo typically returns JSON:API resources, but be defensive and expose safe structure hints.
            if (typeof pm === 'string') {
                return {
                    methodType: pm,
                    entryKeys: [],
                    attributesKeys: []
                };
            }

            const isObject = pm !== null && typeof pm === 'object' && !Array.isArray(pm);
            const attributes = isObject ? pm.attributes : undefined;

            const methodType = attributes?.type ?? pm?.type;
            const status = attributes?.status;
            const country = attributes?.country;
            const brand = attributes?.brand;
            const id = pm?.id;

            const entryKeys = isObject ? Object.keys(pm) : [];
            const attributesKeys = attributes && typeof attributes === 'object' ? Object.keys(attributes) : [];

            return {
                id,
                methodType,
                status,
                brand,
                country,
                entryKeys,
                attributesKeys,
                // If everything is missing, include a safe string representation for debugging.
                debugValue: (id || methodType || status) ? undefined : String(pm)
            };
        });

        res.status(200).json({
            success: true,
            count: sanitized.length,
            capabilities: sanitized
        });
    } catch (error) {
        // Treat upstream capability fetch failures as a Bad Gateway.
        res.status(502).json({
            success: false,
            error: 'Failed to retrieve PayMongo capabilities',
            message: error.message
        });
    }
};

// The PayMongo client for an existing payment intent: the mode persisted on its
// digital_solutions_transactions row (unknown intents are live, as before).
async function paymongoForStoredIntent(paymentIntentId) {
    const tx = await digitalSolutionsStore.findByPaymongoPaymentIntentId(paymentIntentId);
    return paymongoService.forMode(tx && tx.isTest ? 'test' : 'live');
}

// Get payment statuses
exports.getPaymentStatus = async (req, res) => {
    try {
        const { paymentId } = req.params;

        if (!paymentId) {
            return res.status(400).json({ error: 'Payment ID required' });
        }

        // Always use the mode stored when the checkout was created - never the caller's say-so.
        const paymongo = await paymongoForStoredIntent(paymentId);
        const paymentStatus = await paymongo.getPaymentIntent(paymentId);

        res.status(200).json({
            success: true,
            status: paymentStatus.attributes.status,
            paid: paymentStatus.attributes.status === 'succeeded',
            paymentIntent: paymentStatus,
            ...(paymongo.isTest ? { testMode: true } : {})
        });

    } catch (error) {
        console.error('Payment status check error:', error);
        if (error.code === 'TEST_MODE_UNAVAILABLE') {
            return res.status(503).json({ error: error.message });
        }
        res.status(500).json({
            error: 'Failed to get payment status',
            message: error.message
        });
    }
};

// Handle PayMongo webhook
exports.handleWebhook = async (req, res) => {
    // Log raw request immediately
    console.log('=== WEBHOOK REQUEST RECEIVED ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Raw body:', JSON.stringify(req.body, null, 2));

    try {
        const event = req.body;

        // Handle both PayMongo structures
        const eventType = event.data?.attributes?.type || event.data?.type || event.type;

        console.log('Webhook received:', eventType);
        console.log('Event data:', JSON.stringify(event.data, null, 2));

        // PayMongo mode of this event: the signature middleware has already proven the
        // signature mode matches the payload's livemode (dev fallback without secrets: payload only).
        const isTestEvent = (req.paymongoWebhookMode || (eventLivemode(event) === false ? 'test' : 'live')) === 'test';

        // Handle different event types
        switch (eventType) {
            case 'payment.paid':
                await handlePaymentSuccess(event.data?.attributes || event.data, { isTestEvent });
                break;

            case 'payment.failed':
                await handlePaymentFailure(event.data?.attributes || event.data, { isTestEvent });
                break;

            case 'payment.pending':
                await handlePaymentPending(event.data?.attributes || event.data, { isTestEvent });
                break;

            default:
                console.log('Unhandled event type:', eventType);
        }

        // Always return 200 to acknowledge receipt
        res.status(200).json({ received: true });

    } catch (error) {
        console.error('Webhook processing error:', error);
        // Still return 200 to prevent PayMongo from retrying
        res.status(200).json({ received: true, error: error.message });
    }
};

// Cancel payment
exports.cancelPayment = async (req, res) => {
    try {
        const { paymentId } = req.params;
        const reason = req.body.reason || 'User cancelled';

        if (!paymentId) {
            return res.status(400).json({ error: 'Payment ID required' });
        }

        res.status(200).json({
            success: true,
            message: 'Payment cancelled',
            paymentId
        });

    } catch (error) {
        console.error('Payment cancellation error:', error);
        res.status(500).json({ error: 'Failed to cancel payment' });
    }
};

// Retry payment
exports.retryPayment = async (req, res) => {
    try {
        const { paymentId } = req.params;

        if (!paymentId) {
            return res.status(400).json({ error: 'Payment ID required' });
        }

        const paymongo = await paymongoForStoredIntent(paymentId);
        const paymentIntent = await paymongo.getPaymentIntent(paymentId);

        res.status(200).json({
            success: true,
            checkoutUrl: paymentIntent.attributes.checkout_url,
            paymentIntentId: paymentIntent.id
        });

    } catch (error) {
        console.error('Payment retry error:', error);
        if (error.code === 'TEST_MODE_UNAVAILABLE') {
            return res.status(503).json({ error: error.message });
        }
        res.status(500).json({ error: 'Failed to retry payment' });
    }
};

// Get payment methods
exports.getPaymentMethods = async (req, res) => {
    const methods = [
        { id: 'qrph', name: 'QRPh (All Methods)', icon: 'qrph-icon.png', category: 'qr' },
        { id: 'gcash', name: 'GCash', icon: 'gcash-icon.png', category: 'ewallet' },
        { id: 'grabpay', name: 'GrabPay', icon: 'grab-icon.png', category: 'ewallet' },
        { id: 'maya', name: 'Maya', icon: 'maya-icon.png', category: 'ewallet' },
        { id: 'shopeepay', name: 'ShopeePay', icon: 'shopee-icon.png', category: 'ewallet' },
        // PayMongo renders the actual bank list dynamically under `dob` (Direct Online Banking).
        { id: 'dob', name: 'Online Banking', icon: 'online-banking-icon.png', category: 'bank' },
        { id: 'card', name: 'Credit/Debit Card', icon: 'card-icon.png', category: 'card' }
    ];

    let paymongo;
    try {
        ({ paymongo } = await resolveCheckoutMode(req));
    } catch (modeErr) {
        if (respondModeError(res, modeErr)) return;
        return res.status(500).json({ error: 'Failed to resolve payment mode' });
    }
    // Test-mode callers also get the test public key (same mode as the checkout they will create).
    const modeInfo = paymongo.isTest ? { mode: 'test', publicKey: paymongo.publicKey } : {};

    const enableCapabilityFilter = String(process.env.PAYMONGO_FILTER_METHOD_TYPES || '').toLowerCase() === 'true';
    if (!enableCapabilityFilter) {
        return res.status(200).json({ methods, ...modeInfo });
    }

    try {
        const capabilities = await paymongo.getMerchantPaymentMethodCapabilities();
        const allowed = new Set(
            (capabilities || [])
                .map((pm) => {
                    if (typeof pm === 'string') return pm;
                    return pm?.attributes?.type;
                })
                .filter(Boolean)
        );

        const idToCapabilityTypes = {
            qrph: ['qrph'],
            gcash: ['gcash'],
            grabpay: ['grab_pay'],
            maya: ['paymaya'],
            shopeepay: ['shopee_pay'],
            // If either `dob` or `dob_ubp` is enabled, keep "Online Banking" visible.
            dob: ['dob', 'dob_ubp'],
            card: ['card']
        };

        const filtered = methods.filter((m) => {
            const types = idToCapabilityTypes[m.id] || [];
            return types.some((t) => allowed.has(t));
        });

        return res.status(200).json({
            methods: filtered.length > 0 ? filtered : [{ id: 'qrph', name: 'QRPh (All Methods)', icon: 'qrph-icon.png', category: 'qr' }],
            ...modeInfo
        });
    } catch (err) {
        console.log('Non-fatal: unable to fetch PayMongo capabilities for /methods, returning full list:', err.message);
        return res.status(200).json({ methods, ...modeInfo });
    }
};

// Validate payment details
exports.validatePayment = (req, res) => {
    const { fullName, email, mobile, amount } = req.body;
    const errors = [];

    if (!fullName || fullName.length < 2) {
        errors.push('Full name must be at least 2 characters');
    }

    if (!email || !validateEmail(email)) {
        errors.push('Valid email is required');
    }

    if (!mobile || !validateMobile(mobile)) {
        errors.push('Valid mobile number is required');
    }

    if (amount && (isNaN(amount) || amount < 1)) {
        errors.push('Invalid amount');
    }

    if (errors.length > 0) {
        return res.status(400).json({ valid: false, errors });
    }

    res.status(200).json({ valid: true });
};

// Helper functions for webhook handling

/** The event's `livemode` (true/false) from the webhook payload, or undefined if absent. */
function eventLivemode(event) {
    const value = event?.data?.attributes?.livemode;
    if (typeof value === 'boolean') return value;
    const nested = event?.data?.attributes?.data?.attributes?.livemode;
    return typeof nested === 'boolean' ? nested : undefined;
}

/**
 * A test event may only touch records created in test mode, and a live event only live records.
 * The mode stored on the checkout's digital_solutions_transactions row is the source of truth.
 * A live event with no matching row proceeds (records that predate the tracker); a test event
 * with no matching row is ignored. Returns true when the event must be skipped.
 */
async function eventModeMismatch({ metadata, isClockistry, isTestEvent }) {
    const reference = isClockistry ? metadata.internal_transaction_id : metadata.paymentReference;
    const record = reference ? await digitalSolutionsStore.findByTransactionId(reference) : null;
    if (record) {
        if (record.isTest !== isTestEvent) {
            console.warn(`Ignoring ${isTestEvent ? 'TEST' : 'LIVE'} webhook event for ${record.isTest ? 'TEST' : 'LIVE'} record ${reference}`);
            return true;
        }
        return false;
    }
    if (isTestEvent) {
        console.warn(`Ignoring TEST webhook event: no test-mode record for reference ${reference || '(none)'}`);
        return true;
    }
    return false;
}

async function handlePaymentSuccess(attributes, { isTestEvent = false } = {}) {
    console.log('Payment succeeded:', attributes);

    const paymentData = attributes.data || {};
    const metadata = paymentData.attributes?.metadata || {};

    // Check if this is a Clockistry payment - skip GHL for Clockistry
    const isClockistry = metadata.source === 'clockistry';

    if (await eventModeMismatch({ metadata, isClockistry, isTestEvent })) return;

    if (isClockistry) {
        await digitalSolutionsStore.updateTransactionStatus(metadata.internal_transaction_id, 'paid', { isTest: isTestEvent });
    } else {
        await digitalSolutionsStore.updateTransactionStatus(metadata.paymentReference, 'paid', { isTest: isTestEvent });
    }

    // Forward to Clockistry if applicable
    if (isClockistry) {
        try {
            await clockistryController.forwardWebhookToClockistry({ data: { attributes } });
            console.log('Clockistry payment success forwarded');
        } catch (err) {
            console.log('Clockistry forward error (non-fatal):', err.message);
        }
    }

    // Skip GHL and LeadConnector for Clockistry payments
    if (isClockistry) {
        console.log('Clockistry payment - skipping GHL and LeadConnector integration');
        return;
    }

    // Confirm the coupon reservation made at checkout creation (see createPaymentIntent)
    // as paid. This is an UPDATE keyed on payment_reference, not an INSERT, so retried
    // payment.paid webhooks for the same checkout are idempotent - a second delivery
    // finds the row already 'paid' and markReservationPaid is a no-op.
    if (metadata.promoCode) {
        try {
            const confirmed = await couponStore.markReservationPaid({ paymentReference: metadata.paymentReference, isTest: isTestEvent });
            if (confirmed) {
                console.log('Coupon reservation confirmed paid:', confirmed.code, 'affiliateFee:', confirmed.affiliateFeeAmount);
            } else {
                const existing = await couponStore.findRedemptionByPaymentReference(metadata.paymentReference);
                if (existing) {
                    // Already 'paid' (webhook retry) or 'released' (raced with a failure
                    // webhook) - nothing to do either way.
                    console.log('Coupon reservation already resolved:', existing.code, existing.status);
                } else {
                    // No reservation found for this payment reference - fall back to
                    // recording directly as paid (e.g. a row from before reservations
                    // existed, or a coupon with no maxRedemptions where the reservation
                    // step was somehow skipped).
                    const coupon = await couponStore.findCoupon(metadata.promoCode);
                    if (coupon) {
                        const redemptionBaseAmount = Number(metadata.baseAmount) || 0;
                        const affiliateFeeAmount = Number((redemptionBaseAmount * coupon.affiliateFeePercent).toFixed(2));
                        await couponStore.recordRedemption({
                            code: coupon.code,
                            paymentReference: metadata.paymentReference,
                            productId: metadata.productId,
                            email: metadata.email,
                            fullName: metadata.fullName,
                            baseAmount: redemptionBaseAmount,
                            discountAmount: Number(metadata.discountAmount) || 0,
                            commissionBase: redemptionBaseAmount,
                            affiliateFeeAmount,
                            affiliateEmail: coupon.affiliateEmail || metadata.referredBy || '',
                            currency: paymentData.attributes?.currency || 'PHP',
                            isTest: isTestEvent
                        });
                        console.log('Coupon redemption recorded directly (no prior reservation found):', coupon.code, 'affiliateFee:', affiliateFeeAmount);
                    } else {
                        console.log('Coupon redemption skipped: unknown code in metadata:', metadata.promoCode);
                    }
                }
            }
        } catch (err) {
            console.log('Coupon redemption recording error (non-fatal):', err.message);
        }
    }

    // Test payments never touch the MAIN GHL location: no contact upsert, no invoice, no
    // invoice schedule (those would be real GHL records for fake money).
    try {
        if (isTestEvent) {
            console.log('PayMongo TEST payment - skipping GHL contact upsert and invoice mirroring');
        } else if (process.env.GHL_PRIVATE_KEY && process.env.GHL_LOCATION_ID) {
            const amountCentavos = Number(paymentData.attributes?.amount);
            const currency = paymentData.attributes?.currency || 'PHP';
            // Convert centavos to whole currency units with decimals preserved (e.g., 165000 -> 1650.00)
            const amount = Number.isFinite(amountCentavos) ? (amountCentavos / 100) : undefined;

            const fullName = metadata.fullName;
            const email = metadata.email;
            const phone = metadata.mobile;
            const product = metadata.product;
            const productId = metadata.productId;
            const catalogProduct = await resolveCatalogProduct({ productId, productName: product });

            const upsertResult = await ghlService.upsertContact({
                fullName,
                email,
                phone
            });

            const contactId = upsertResult?.contact?.id || upsertResult?.id || upsertResult?.contactId;

            if (!contactId) {
                console.log('GHL upsertContact did not return contact id, skipping invoice creation');
            } else if (!amount) {
                console.log('PayMongo amount missing, skipping invoice creation');
            } else {
                const now = new Date();
                const issueDate = now.toISOString().slice(0, 10);
                const dueDate = issueDate;

                const invoice = await ghlService.createInvoice({
                    contactId,
                    contactDetails: {
                        name: fullName,
                        phoneNo: phone,
                        email
                    },
                    name: product ? String(product) : 'PayMongo Payment',
                    currency: String(currency).toUpperCase(),
                    issueDate,
                    dueDate,
                    items: [
                        {
                            name: product ? String(product) : 'PayMongo Payment',
                            description: metadata.paymentReference ? `Ref: ${metadata.paymentReference}` : undefined,
                            currency: String(currency).toUpperCase(),
                            amount,
                            qty: 1,
                            type: 'one_time'
                        }
                    ].map(item => {
                        Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);
                        return item;
                    })
                });

                console.log('GHL invoice created:', invoice?.id || invoice?.invoice?.id || invoice);

                const invoiceId = invoice?.invoice?._id || invoice?._id || invoice?.id;
                if (invoiceId) {
                    try {
                        const paySource = paymentData.attributes?.source || {};
                        const cardBrand = paySource?.brand || paySource?.card_brand;
                        const cardLast4 = paySource?.last4 || paySource?.last_4;

                        const paymentResult = await ghlService.recordInvoicePayment({
                            invoiceId,
                            amount,
                            mode: 'card',
                            cardBrand,
                            cardLast4,
                            notes: `PayMongo payment ${paymentData.id}`,
                            fulfilledAt: new Date().toISOString()
                        });
                        console.log('GHL payment recorded, transaction created:', paymentResult?.id || paymentResult?.transaction?.id || 'OK');
                    } catch (payErr) {
                        console.log('GHL record-payment error (non-fatal):', payErr.response?.data || payErr.message);
                    }
                } else {
                    console.log('GHL invoice created but no invoiceId found for record-payment');
                }

                // Optional: Create recurring invoice schedule in GHL (recurring invoices, not recurring PayMongo charges)
                try {
                    const isRecurring = String(catalogProduct?.billing?.type || 'one_time') === 'recurring';
                    if (isRecurring && contactId && catalogProduct?.id) {
                        const existingScheduleId = await getScheduleId({
                            locationId: process.env.GHL_LOCATION_ID,
                            contactId,
                            productId: catalogProduct.id
                        });

                        if (existingScheduleId) {
                            console.log('GHL invoice schedule already exists for contact/product:', existingScheduleId);
                        } else {
                            const now = new Date();
                            const start = new Date(now);
                            const targetMonth = start.getMonth() + 1;
                            start.setMonth(targetMonth);
                            // Clamp day-of-month if next month is shorter
                            if (start.getMonth() !== (targetMonth % 12)) {
                                start.setDate(0);
                            }
                            const startAt = start.toISOString().slice(0, 10);

                            // Renewals always bill at the product's FULL (undiscounted)
                            // price - a coupon only ever discounts the first payment.
                            // Falls back to the actual charged `amount` only if the
                            // checkout predates fullPriceAmount being stashed in metadata.
                            const renewalAmount = Number(metadata.fullPriceAmount) || amount;

                            const schedule = await ghlService.createInvoiceSchedule({
                                contactId,
                                contactDetails: {
                                    name: fullName,
                                    phoneNo: phone,
                                    email
                                },
                                name: `${catalogProduct.name} (Recurring)`,
                                currency: String(currency).toUpperCase(),
                                startAt,
                                interval: 'month',
                                intervalCount: 1,
                                items: [
                                    {
                                        name: String(catalogProduct.name),
                                        description: metadata.paymentReference ? `Ref: ${metadata.paymentReference}` : undefined,
                                        currency: String(currency).toUpperCase(),
                                        amount: renewalAmount,
                                        qty: 1,
                                        type: 'recurring'
                                    }
                                ].map(item => {
                                    Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);
                                    return item;
                                })
                            });

                            const scheduleId = schedule?._id || schedule?.id || schedule?.schedule?._id || schedule?.schedule?.id;
                            if (scheduleId) {
                                await setScheduleId({
                                    locationId: process.env.GHL_LOCATION_ID,
                                    contactId,
                                    productId: catalogProduct.id,
                                    scheduleId
                                });
                                console.log('GHL invoice schedule created:', scheduleId);

                                try {
                                    await ghlService.scheduleInvoiceSchedule({ scheduleId });
                                    console.log('GHL invoice schedule activated:', scheduleId);
                                } catch (schedErr) {
                                    console.log('GHL invoice schedule activation error (non-fatal):', schedErr.response?.data || schedErr.message);
                                }
                            } else {
                                console.log('GHL invoice schedule created but no scheduleId found:', schedule);
                            }
                        }
                    }
                } catch (scheduleErr) {
                    console.log('GHL invoice schedule error (non-fatal):', scheduleErr.response?.data || scheduleErr.message);
                }
            }
        }
    } catch (err) {
        console.log('GHL sync error (non-fatal):', err.response?.data || err.message);
    }

    // GHL Practice Access / Premium: create the buyer as a GHL user in the Students sub-account
    // BEFORE the paid webhook so it can carry the login. Never throws or blocks payment
    // handling for long (bounded timeout inside); failures become status 'failed' + a retry.
    let ghlStudentAccount = null;
    try {
        ghlStudentAccount = await ghlStudentUsers.provisionForPayment({
            paymentReference: metadata.paymentReference || paymentData.id,
            email: metadata.email,
            fullName: metadata.fullName,
            productId: metadata.productId,
            isTest: isTestEvent
        });
    } catch (err) {
        console.log('GHL student account error (non-fatal):', err.message);
    }

    await webhookService.sendToLeadConnector({
        ...metadata,
        status: 'payment_successful',
        paymentId: paymentData.id,
        paymentDetails: attributes,
        ...(ghlStudentAccount ? { ghlStudentAccount } : {}),
        ...testPayloadFlags(isTestEvent),
        completedAt: new Date().toISOString()
    }).catch(err => {
        console.log('LeadConnector webhook error (non-fatal):', err.response?.data || err.message);
    });
}

async function handlePaymentFailure(attributes, { isTestEvent = false } = {}) {
    console.log('Payment failed:', attributes);

    const paymentData = attributes.data || {};
    const metadata = paymentData.attributes?.metadata || {};

    // Check if this is a Clockistry payment
    const isClockistry = metadata.source === 'clockistry';

    if (await eventModeMismatch({ metadata, isClockistry, isTestEvent })) return;

    if (isClockistry) {
        await digitalSolutionsStore.updateTransactionStatus(metadata.internal_transaction_id, 'failed', { isTest: isTestEvent });
    } else {
        await digitalSolutionsStore.updateTransactionStatus(metadata.paymentReference, 'failed', { isTest: isTestEvent });
    }

    // Release any coupon hold reserved at checkout creation for this payment, so a
    // failed one-time coupon attempt doesn't block the coupon forever.
    if (metadata.promoCode && metadata.paymentReference) {
        await couponStore.releaseReservation(metadata.paymentReference, { isTest: isTestEvent }).catch((err) => {
            console.log('Coupon reservation release error (non-fatal):', err.message);
        });
    }

    // Forward to Clockistry if applicable
    if (isClockistry) {
        try {
            await clockistryController.forwardWebhookToClockistry({ data: { attributes } });
            console.log('Clockistry payment failure forwarded');
        } catch (err) {
            console.log('Clockistry forward error (non-fatal):', err.message);
        }
        // Skip LeadConnector for Clockistry
        return;
    }

    await webhookService.sendToLeadConnector({
        ...metadata,
        status: 'payment_failed',
        paymentId: paymentData.id,
        paymentDetails: attributes,
        ...testPayloadFlags(isTestEvent),
        completedAt: new Date().toISOString()
    }).catch(err => {
        console.log('LeadConnector webhook error (non-fatal):', err.response?.data || err.message);
    });
}

async function handlePaymentPending(attributes, { isTestEvent = false } = {}) {
    console.log('Payment pending:', attributes);
}
