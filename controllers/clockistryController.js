// controllers/clockistryController.js
const axios = require('axios');
const { generateId } = require('../utils/helpers');

// Pricing configuration
const USD_TO_PHP_RATE = 58;
const PRICING = {
    office: 9,      // $9 per user
    enterprise: 12  // $12 per user
};

/**
 * Create payment intent for Clockistry subscription upgrade
 * POST /api/clockistry/create-payment-intent
 */
exports.createPaymentIntent = async (req, res) => {
    try {
        const {
            companyId,
            userId,
            plan,
            userCount,
            successUrl,
            cancelUrl,
            customerEmail,
            customerName
        } = req.body;

        // Validate required fields
        if (!companyId || !plan) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['companyId', 'plan']
            });
        }

        // Validate plan type
        if (!['office', 'enterprise'].includes(plan)) {
            return res.status(400).json({
                error: 'Invalid plan. Must be "office" or "enterprise"'
            });
        }

        // Calculate price in centavos
        const pricePerUserUSD = PRICING[plan];
        const pricePerUserCentavos = pricePerUserUSD * USD_TO_PHP_RATE * 100;
        const count = parseInt(userCount) || 1;
        const totalAmount = pricePerUserCentavos * count;

        // Generate internal transaction ID
        const internalTransactionId = generateId('CLK');

        // Create PayMongo checkout session directly
        const response = await axios.post(
            'https://api.paymongo.com/v1/checkout_sessions',
            {
                data: {
                    attributes: {
                        line_items: [{
                            name: `Nexiflow ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
                            amount: totalAmount,
                            currency: 'PHP',
                            description: `Subscription for ${count} user(s)`,
                            quantity: 1
                        }],
                        payment_method_types: ['card', 'gcash', 'qrph', 'grab_pay'],
                        success_url: successUrl || 'https://nexi-flow.com/billing/success',
                        cancel_url: cancelUrl || 'https://nexi-flow.com/billing/cancel',
                        description: `Upgrade to ${plan} plan`,
                        send_email_receipt: true,
                        show_description: true,
                        show_line_items: true,
                        metadata: {
                            company_id: companyId,
                            user_id: userId || '',
                            pricing_level: plan,
                            user_count: String(count),
                            price_per_user: String(pricePerUserCentavos),
                            internal_transaction_id: internalTransactionId,
                            source: 'clockistry',
                            customer_email: customerEmail || '',
                            customer_name: customerName || ''
                        }
                    }
                }
            },
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const checkoutData = response.data.data;

        console.log('Clockistry checkout session created:', {
            checkoutSessionId: checkoutData.id,
            companyId,
            plan,
            userCount: count,
            amount: totalAmount,
            transactionId: internalTransactionId
        });

        res.status(200).json({
            success: true,
            checkoutUrl: checkoutData.attributes.checkout_url,
            checkoutSessionId: checkoutData.id,
            transactionId: internalTransactionId,
            amount: totalAmount,
            currency: 'PHP'
        });

    } catch (error) {
        console.error('Clockistry payment creation error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to create payment',
            message: error.response?.data?.errors?.[0]?.detail || error.message
        });
    }
};

/**
 * Forward Clockistry webhook to their backend
 * This is called by the main webhook handler when source='clockistry'
 */
exports.forwardWebhookToClockistry = async (payload) => {
    const webhookUrl = process.env.CLOCKISTRY_WEBHOOK_URL;

    if (!webhookUrl) {
        console.log('Clockistry webhook URL not configured, skipping forward');
        return;
    }

    try {
        const eventType = payload.data?.attributes?.type;
        const paymentData = payload.data?.attributes?.data || {};
        const metadata = paymentData.attributes?.metadata || {};

        // Build payload for Clockistry
        const clockistryPayload = {
            eventType: eventType,
            checkoutSessionId: paymentData.id,
            paymentIntentId: paymentData.attributes?.payment_intent?.id,
            amount: paymentData.attributes?.amount,
            currency: paymentData.attributes?.currency,
            status: eventType?.includes('paid') ? 'paid' : 
                    eventType?.includes('failed') ? 'failed' : 'pending',
            metadata: metadata,
            paidAt: new Date().toISOString()
        };

        const headers = {
            'Content-Type': 'application/json'
        };

        // Add optional webhook secret if configured
        if (process.env.CLOCKISTRY_WEBHOOK_SECRET) {
            headers['X-Webhook-Secret'] = process.env.CLOCKISTRY_WEBHOOK_SECRET;
        }

        await axios.post(webhookUrl, clockistryPayload, {
            headers,
            timeout: 10000
        });

        console.log('Webhook forwarded to Clockistry successfully:', {
            checkoutSessionId: paymentData.id,
            eventType
        });

        return true;
    } catch (error) {
        console.error('Failed to forward webhook to Clockistry:', error.message);
        // Don't throw - we don't want to fail the PayMongo webhook response
        return false;
    }
};
