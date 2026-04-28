// controllers/paymentController.js
const paymongoService = require('../services/paymongoService');
const webhookService = require('../services/webhookService');
const ghlService = require('../services/ghlService');
const clockistryController = require('./clockistryController');
const { generateId, validateEmail, validateMobile, calculateTaxedAmount } = require('../utils/helpers');
const { getCheckoutMethodTypes } = require('../utils/paymongoMethodTypes');
const { findProduct } = require('../utils/productCatalog');

function resolveCatalogProduct({ productId, productName }) {
    const byId = productId ? findProduct({ productId }) : null;
    if (byId) return byId;
    const byName = productName ? findProduct({ productName }) : null;
    if (byName) return byName;
    return null;
}

// Create payment intent
exports.createPaymentIntent = async (req, res) => {
    try {
        // ✅ FIXED: Added paymentMethod and source to destructuring
        const {
            fullName,
            email,
            mobile,
            product,
            productId,
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
        const catalogProduct = resolveCatalogProduct({ productId, productName: normalizedProduct });
        if (!catalogProduct) {
            return res.status(400).json({ error: 'Invalid product. Add it in /admin/products first.' });
        }
        if (!normalizedProduct) normalizedProduct = catalogProduct.name;
        const productInfo = { amount: catalogProduct.amountPhp, currency: catalogProduct.currency };

        // Generate unique payment reference
        const paymentReference = generateId('PAY');

        const defaultTaxRate = Number(process.env.TAX_RATE ?? 0.10);
        const coreTaxRate = Number(process.env.NX_CORE_TAX_RATE ?? 0.12);
        const taxRate = (source === 'nexistry_core_ph') ? coreTaxRate : defaultTaxRate;
        
        // ✅ FIXED: Use frontend amount if provided and valid, otherwise calculate from product
        let finalAmount, baseAmount, taxAmount;
        
        if (amount && amount > 0 && amount !== productInfo.amount) {
            // Frontend provided a discounted amount - use it
            finalAmount = Number(Number(amount).toFixed(2));
            // Calculate base and tax from the discounted total
            // finalAmount = base + tax, and tax = base * taxRate
            // So: finalAmount = base + (base * taxRate) = base * (1 + taxRate)
            // Therefore: base = finalAmount / (1 + taxRate)
            baseAmount = Number((finalAmount / (1 + taxRate)).toFixed(2));
            taxAmount = Number((finalAmount - baseAmount).toFixed(2));
            console.log('Using frontend amount with discount:', {
                frontendAmount: amount,
                finalAmount,
                baseAmount,
                taxAmount,
                discountAmount: discountAmount || 0,
                promoCode: promoCode || 'none'
            });
        } else {
            // Use product mapping (no discount)
            const taxed = calculateTaxedAmount(productInfo.amount, taxRate);
            finalAmount = Number(taxed.totalAmount.toFixed(2));
            baseAmount = Number(taxed.baseAmount.toFixed(2));
            taxAmount = Number(taxed.taxAmount.toFixed(2));
        }

        // Safety: prevent accidental overcharge beyond catalog price (+ tax)
        const maxAllowed = Number(calculateTaxedAmount(productInfo.amount, taxRate).totalAmount.toFixed(2));
        if (finalAmount > maxAllowed) {
            return res.status(400).json({
                error: 'Amount exceeds product catalog maximum',
                maxAllowed,
                requested: finalAmount
            });
        }

        // Log what we received for debugging
        console.log('Received payment request:', {
            fullName,
            email,
            mobile,
            product: normalizedProduct,
            paymentMethod,
            source,
            frontendAmount: amount,
            discountAmount,
            promoCode
        });

        // FIXED: Flatten metadata - include paymentMethod and source
        const flattenedMetadata = {
            // Required fields
            fullName: String(fullName || ''),
            email: String(email || ''),
            mobile: String(mobile || ''),
            product: String(normalizedProduct || ''),
            paymentReference: String(paymentReference || ''),

            baseAmount: String(baseAmount),
            taxRate: String(taxRate),
            taxAmount: String(taxAmount),
            totalAmount: String(finalAmount),

            // ADD: Discount information
            discountAmount: String(discountAmount || 0),
            promoCode: String(promoCode || ''),

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
            paymongoService,
            enableCapabilityFilter
        });

        console.log('Payment method selected:', selectedPaymentMethod, 'checkout types:', paymentMethods);

        const coreSuccessUrlDefault = 'https://nexistrycoreph.nexistrydigitalsolutions.com/product-thank-you-page-703324-971918-441701';
        const successUrl = (source === 'nexistry_core_ph')
            ? (process.env.NX_CORE_FRONTEND_SUCCESS_URL || coreSuccessUrlDefault)
            : undefined;
        const failureUrl = (source === 'nexistry_core_ph')
            ? (process.env.NX_CORE_FRONTEND_FAILURE_URL || process.env.FRONTEND_FAILURE_URL)
            : undefined;
        const cancelUrl = (source === 'nexistry_core_ph')
            ? 'https://nexistrycoreph.nexistrydigitalsolutions.com/ph-ver-753092'
            : undefined;

        // Some PayMongo method types may be eligible for Checkout, but not accepted in PaymentIntent's
        // `payment_method_allowed` field. Keep a conservative allowlist for PaymentIntent, while
        // still offering the full set in Checkout Session `payment_method_types`.
        const checkoutMethodTypes = paymentMethods;
        const paymentIntentAllowed = paymentMethods.map(m => (m === 'dob_ubp' ? 'dob' : m));

        const paymentIntent = await paymongoService.createPaymentIntent({
            amount: finalAmount,
            currency: productInfo.currency,
            description: `${normalizedProduct} - ${fullName}${discountAmount > 0 ? ` (Promo: ${promoCode})` : ''}`,
            paymentMethodAllowed: paymentIntentAllowed,
            paymentMethodTypes: checkoutMethodTypes,
            metadata: flattenedMetadata,
            successUrl,
            failureUrl,
            cancelUrl
        });

        console.log('Payment intent created:', paymentIntent.id);

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
            discountAmount: discountAmount || 0,
            promoCode: promoCode || '',
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
            timestamp: new Date().toISOString()
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
            discountAmount: discountAmount || 0,
            promoCode: promoCode || '',
            currency: productInfo.currency
        });

    } catch (error) {
        console.error('Payment intent creation error:', error);
        res.status(500).json({
            error: 'Failed to create payment intent',
            message: error.message
        });
    }
};

// Diagnostic: Expose PayMongo merchant method capabilities (sanitized)
exports.getPaymongoCapabilities = async (req, res) => {
    try {
        const capabilities = await paymongoService.getMerchantPaymentMethodCapabilities();

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

// Get payment statuses
exports.getPaymentStatus = async (req, res) => {
    try {
        const { paymentId } = req.params;

        if (!paymentId) {
            return res.status(400).json({ error: 'Payment ID required' });
        }

        const paymentStatus = await paymongoService.getPaymentIntent(paymentId);

        res.status(200).json({
            success: true,
            status: paymentStatus.attributes.status,
            paid: paymentStatus.attributes.status === 'succeeded',
            paymentIntent: paymentStatus
        });

    } catch (error) {
        console.error('Payment status check error:', error);
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

        // Handle different event types
        switch (eventType) {
            case 'payment.paid':
                await handlePaymentSuccess(event.data?.attributes || event.data);
                break;

            case 'payment.failed':
                await handlePaymentFailure(event.data?.attributes || event.data);
                break;

            case 'payment.pending':
                await handlePaymentPending(event.data?.attributes || event.data);
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

        const paymentIntent = await paymongoService.getPaymentIntent(paymentId);

        res.status(200).json({
            success: true,
            checkoutUrl: paymentIntent.attributes.checkout_url,
            paymentIntentId: paymentIntent.id
        });

    } catch (error) {
        console.error('Payment retry error:', error);
        res.status(500).json({ error: 'Failed to retry payment' });
    }
};

// Get payment methods
exports.getPaymentMethods = (req, res) => {
    res.status(200).json({
        methods: [
            { id: 'qrph', name: 'QRPh (All Methods)', icon: 'qrph-icon.png', category: 'qr' },
            { id: 'gcash', name: 'GCash', icon: 'gcash-icon.png', category: 'ewallet' },
            { id: 'grabpay', name: 'GrabPay', icon: 'grab-icon.png', category: 'ewallet' },
            { id: 'maya', name: 'Maya', icon: 'maya-icon.png', category: 'ewallet' },
            { id: 'shopeepay', name: 'ShopeePay', icon: 'shopee-icon.png', category: 'ewallet' },
            // PayMongo renders the actual bank list dynamically under `dob` (Direct Online Banking).
            { id: 'dob', name: 'Online Banking', icon: 'online-banking-icon.png', category: 'bank' },
            { id: 'card', name: 'Credit/Debit Card', icon: 'card-icon.png', category: 'card' }
        ]
    });
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
async function handlePaymentSuccess(attributes) {
    console.log('Payment succeeded:', attributes);

    const paymentData = attributes.data || {};
    const metadata = paymentData.attributes?.metadata || {};

    // Check if this is a Clockistry payment - skip GHL for Clockistry
    const isClockistry = metadata.source === 'clockistry';

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

    try {
        if (process.env.GHL_PRIVATE_KEY && process.env.GHL_LOCATION_ID) {
            const amountCentavos = Number(paymentData.attributes?.amount);
            const currency = paymentData.attributes?.currency || 'PHP';
            // Convert centavos to whole currency units with decimals preserved (e.g., 165000 -> 1650.00)
            const amount = Number.isFinite(amountCentavos) ? (amountCentavos / 100) : undefined;

            const fullName = metadata.fullName;
            const email = metadata.email;
            const phone = metadata.mobile;
            const product = metadata.product;

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
            }
        }
    } catch (err) {
        console.log('GHL sync error (non-fatal):', err.response?.data || err.message);
    }

    await webhookService.sendToLeadConnector({
        ...metadata,
        status: 'payment_successful',
        paymentId: paymentData.id,
        paymentDetails: attributes,
        completedAt: new Date().toISOString()
    }).catch(err => {
        console.log('LeadConnector webhook error (non-fatal):', err.response?.data || err.message);
    });
}

async function handlePaymentFailure(attributes) {
    console.log('Payment failed:', attributes);

    const paymentData = attributes.data || {};
    const metadata = paymentData.attributes?.metadata || {};

    // Check if this is a Clockistry payment
    const isClockistry = metadata.source === 'clockistry';

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
        completedAt: new Date().toISOString()
    }).catch(err => {
        console.log('LeadConnector webhook error (non-fatal):', err.response?.data || err.message);
    });
}

async function handlePaymentPending(attributes) {
    console.log('Payment pending:', attributes);
}
