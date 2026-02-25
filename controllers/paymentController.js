// controllers/paymentController.js
const paymongoService = require('../services/paymongoService');
const webhookService = require('../services/webhookService');
const ghlService = require('../services/ghlService');
const { generateId, validateEmail, validateMobile, calculateTaxedAmount } = require('../utils/helpers');

// Product pricing mapping
const PRODUCTS = {
    'START UP VA Course': { amount: 1500, currency: 'PHP' },
    'GHL Practice Access': { amount: 500, currency: 'PHP' },
    'Freelancer Plan': { amount: 3500, currency: 'PHP' },
    'Dedicated Coaching': { amount: 999, currency: 'PHP' },
    'Customization Plan': { amount: 5000, currency: 'PHP' },
    'Client Finder Tool': { amount: 500, currency: 'PHP' }
};

// Create payment intent
exports.createPaymentIntent = async (req, res) => {
    try {
        // ✅ FIXED: Added paymentMethod and source to destructuring
        const {
            fullName,
            email,
            mobile,
            product,
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
            metadata = {}
        } = req.body;

        // Validate required fields
        if (!fullName || !email || !mobile || !product) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['fullName', 'email', 'mobile', 'product']
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

        // Get product amount - Use frontend amount if provided (with discount), otherwise use product mapping
        const productInfo = PRODUCTS[product];
        if (!productInfo) {
            return res.status(400).json({ error: 'Invalid product' });
        }

        // Generate unique payment reference
        const paymentReference = generateId('PAY');

        const taxRate = process.env.TAX_RATE ?? 0.10;
        
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

        // Log what we received for debugging
        console.log('Received payment request:', {
            fullName,
            email,
            mobile,
            product,
            paymentMethod,
            source,
            frontendAmount: amount,
            discountAmount,
            promoCode
        });

        // ✅ FIXED: Flatten metadata - include paymentMethod and source
        const flattenedMetadata = {
            // Required fields
            fullName: String(fullName || ''),
            email: String(email || ''),
            mobile: String(mobile || ''),
            product: String(product || ''),
            paymentReference: String(paymentReference || ''),

            baseAmount: String(baseAmount),
            taxRate: String(taxRate),
            taxAmount: String(taxAmount),
            totalAmount: String(finalAmount),

            // ✅ ADD: Discount information
            discountAmount: String(discountAmount || 0),
            promoCode: String(promoCode || ''),

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

        // Map frontend payment method IDs to PayMongo identifiers
        const methodMap = {
            'gcash': 'gcash',
            'grabpay': 'grab_pay',
            'maya': 'paymaya',
            'shopeepay': 'shopee_pay',
            'bpi': 'dob',
            'unionbank': 'dob',
            'qrph': 'qrph',
            'card': 'card'
        };

        const allSupportedPaymongoMethods = [
            'qrph',
            'gcash',
            'grab_pay',
            'paymaya',
            'shopee_pay',
            'dob'
        ];

        const normalized = methodMap[selectedPaymentMethod] || 'qrph';

        // If the user didn’t pick a specific method (or picked qrph/all), show all options.
        let paymentMethods = (selectedPaymentMethod === 'qrph' || selectedPaymentMethod === 'all')
            ? allSupportedPaymongoMethods
            : [normalized];

        // Filter by what PayMongo says your merchant account is eligible for.
        // This also explains why UnionBank might not appear under Online Banking even if `dob` is included.
        try {
            const capabilities = await paymongoService.getMerchantPaymentMethodCapabilities();
            const allowed = new Set((capabilities || []).map(pm => pm?.attributes?.type).filter(Boolean));

            // Keep only allowed types; if filtering removes everything, fall back to qrph.
            const filtered = paymentMethods.filter(m => allowed.has(m));
            if (filtered.length > 0) {
                paymentMethods = filtered;
            } else {
                paymentMethods = ['qrph'];
            }
        } catch (capErr) {
            console.log('Non-fatal: unable to fetch PayMongo capabilities, proceeding without filtering:', capErr.message);
        }

        console.log('Payment method selected:', selectedPaymentMethod, '-> PayMongo:', normalized, 'checkout types:', paymentMethods);

        const paymentIntent = await paymongoService.createPaymentIntent({
            amount: finalAmount,
            currency: productInfo.currency,
            description: `${product} - ${fullName}${discountAmount > 0 ? ` (Promo: ${promoCode})` : ''}`,
            paymentMethodAllowed: paymentMethods,
            paymentMethodTypes: paymentMethods,
            metadata: flattenedMetadata
        });

        console.log('Payment intent created:', paymentIntent.id);

        // Send to LeadConnector webhook - include paymentMethod and source
        await webhookService.sendToLeadConnector({
            fullName,
            email,
            mobile,
            product,
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

// Get payment status
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
            { id: 'bpi', name: 'BPI Online', icon: 'bpi-icon.png', category: 'bank' },
            { id: 'unionbank', name: 'UnionBank Online', icon: 'unionbank-icon.png', category: 'bank' },
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