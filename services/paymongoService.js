// services/paymongoService.js
const axios = require('axios');

class PayMongoService {
    constructor() {
        this.baseURL = 'https://api.paymongo.com/v1';
        this.secretKey = process.env.PAYMONGO_SECRET_KEY;

        // Debug: Check if secret key is loaded (masked for security)
        console.log('PayMongo Secret Key loaded:', this.secretKey ? '✅ Yes (starts with ' + this.secretKey.substring(0, 8) + '...)' : '❌ No');

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Authorization': `Basic ${Buffer.from(this.secretKey + ':').toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });
    }

    // Helper function to format currency for PayMongo
    formatCurrency(currency) {
        return currency.toUpperCase();
    }

    // Retrieve list of possible merchant payment methods (capabilities)
    async getMerchantPaymentMethodCapabilities() {
        try {
            const response = await this.client.get('/merchants/capabilities/payment_methods');
            return response.data?.data;
        } catch (error) {
            console.error('PayMongo merchant capabilities error:', error.response?.data || error.message);
            throw new Error('Failed to retrieve merchant payment method capabilities');
        }
    }

    // Create a payment intent
    async createPaymentIntent({ amount, currency, description, paymentMethodAllowed, metadata, paymentMethodTypes }) {
        try {
            const formattedCurrency = this.formatCurrency(currency);

            // Map payment methods for checkout session
            // PayMongo uses different identifiers for checkout sessions vs payment intents
            const methodTypeMap = {
                'gcash': 'gcash',
                'grab_pay': 'grab_pay',
                'maya': 'paymaya',
                'paymaya': 'paymaya',
                'shopeepay': 'shopee_pay',
                'shopee_pay': 'shopee_pay',
                // Online banking is represented by `dob` (Direct Online Banking)
                'dob': 'dob',
                'card': 'card',
                'qrph': 'qrph'
            };

            // Convert payment methods to checkout session format
            const checkoutMethodTypes = (paymentMethodTypes || paymentMethodAllowed || ['qrph']).map(method => {
                return methodTypeMap[method] || method;
            });

            console.log('1. Creating payment intent with:', {
                amount: Math.floor(amount * 100),
                currency: formattedCurrency,
                description,
                paymentMethodAllowed: paymentMethodAllowed || ['qrph'],
                checkoutMethodTypes,
                metadataKeys: Object.keys(metadata)
            });

            // Step 1: Create payment intent
            const paymentIntentResponse = await this.client.post('/payment_intents', {
                data: {
                    attributes: {
                        amount: Math.floor(amount * 100),
                        currency: formattedCurrency,
                        description,
                        statement_descriptor: 'Nexistry Academy',
                        payment_method_allowed: paymentMethodAllowed || ['qrph'],
                        metadata
                    }
                }
            });

            console.log('2. Payment intent created successfully');

            const paymentIntent = paymentIntentResponse.data.data;
            console.log('   Payment Intent ID:', paymentIntent.id);

            // Step 2: Create checkout session
            console.log('3. Creating checkout session...');

            const checkoutResponse = await this.client.post('/checkout_sessions', {
                data: {
                    attributes: {
                        send_email_receipt: true,
                        show_description: true,
                        show_line_items: true,
                        line_items: [
                            {
                                amount: Math.floor(amount * 100),
                                currency: formattedCurrency,
                                description,
                                name: description,
                                quantity: 1
                            }
                        ],
                        payment_method_types: checkoutMethodTypes,
                        description,
                        metadata,
                        success_url: process.env.FRONTEND_SUCCESS_URL || 'https://nxacademy.nexistrydigitalsolutions.com/success?session_id={CHECKOUT_SESSION_ID}',
                        failure_url: process.env.FRONTEND_FAILURE_URL || 'https://nxacademy.nexistrydigitalsolutions.com/failed',
                        cancel_url: process.env.FRONTEND_CANCEL_URL || 'https://nxacademy.nexistrydigitalsolutions.com/cancelled'
                    }
                }
            });

            console.log('4. Checkout session created successfully');

            const checkoutSession = checkoutResponse.data.data;
            console.log('   Checkout Session ID:', checkoutSession.id);
            console.log('   Checkout URL:', checkoutSession.attributes.checkout_url);

            // Step 3: Return combined data
            return {
                id: paymentIntent.id,
                type: paymentIntent.type,
                attributes: {
                    ...paymentIntent.attributes,
                    checkout_url: checkoutSession.attributes.checkout_url,
                    checkout_session_id: checkoutSession.id
                }
            };

        } catch (error) {
            // Enhanced error logging
            console.error('❌ PayMongo API Error:');

            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                console.error('   Status:', error.response.status);
                console.error('   Headers:', error.response.headers);
                console.error('   Data:', JSON.stringify(error.response.data, null, 2));

                // Extract the specific error message from PayMongo
                const payMongoError = error.response.data?.errors?.[0];
                if (payMongoError) {
                    console.error('   PayMongo Error Code:', payMongoError.code);
                    console.error('   PayMongo Error Detail:', payMongoError.detail);
                    throw new Error(`${payMongoError.code}: ${payMongoError.detail}`);
                }
            } else if (error.request) {
                // The request was made but no response was received
                console.error('   No response received from PayMongo');
                console.error('   Request:', error.request);
                throw new Error('No response from PayMongo API. Check your network connection.');
            } else {
                // Something happened in setting up the request that triggered an Error
                console.error('   Error setting up request:', error.message);
                throw new Error(`Request setup error: ${error.message}`);
            }

            throw new Error('Failed to create payment intent');
        }
    }

    // Create a checkout session (kept for backward compatibility)
    async createCheckoutSession(paymentIntentId, { amount, currency, description, metadata }) {
        try {
            const formattedCurrency = this.formatCurrency(currency);

            const response = await this.client.post('/checkout_sessions', {
                data: {
                    attributes: {
                        payment_intent_id: paymentIntentId,
                        send_email_receipt: true,
                        show_description: true,
                        show_line_items: true,
                        line_items: [
                            {
                                amount: Math.floor(amount * 100),
                                currency: formattedCurrency,
                                description,
                                name: description,
                                quantity: 1
                            }
                        ],
                        payment_method_types: ['qrph'],
                        description,
                        metadata,
                        success_url: process.env.FRONTEND_SUCCESS_URL || 'https://nxacademy.nexistrydigitalsolutions.com/success?session_id={CHECKOUT_SESSION_ID}',
                        failure_url: process.env.FRONTEND_FAILURE_URL || 'https://nxacademy.nexistrydigitalsolutions.com/failed',
                        cancel_url: process.env.FRONTEND_CANCEL_URL || 'https://nxacademy.nexistrydigitalsolutions.com/cancelled'
                    }
                }
            });

            return response.data;
        } catch (error) {
            console.error('PayMongo create checkout error:', error.response?.data || error.message);
            throw new Error('Failed to create checkout session');
        }
    }

    // Get payment intent details
    async getPaymentIntent(paymentIntentId) {
        try {
            const response = await this.client.get(`/payment_intents/${paymentIntentId}`);
            return response.data.data;
        } catch (error) {
            console.error('PayMongo get payment intent error:', error.response?.data || error.message);
            throw new Error('Failed to retrieve payment intent');
        }
    }

    // Attach payment method to intent (for card payments)
    async attachPaymentMethod(paymentIntentId, paymentMethodId) {
        try {
            const response = await this.client.post(`/payment_intents/${paymentIntentId}/attach`, {
                data: {
                    attributes: {
                        payment_method: paymentMethodId
                    }
                }
            });
            return response.data;
        } catch (error) {
            console.error('PayMongo attach payment method error:', error.response?.data || error.message);
            throw new Error('Failed to attach payment method');
        }
    }

    // Create payment method (for saved cards)
    async createPaymentMethod({ type, details }) {
        try {
            const response = await this.client.post('/payment_methods', {
                data: {
                    attributes: {
                        type,
                        details
                    }
                }
            });
            return response.data;
        } catch (error) {
            console.error('PayMongo create payment method error:', error.response?.data || error.message);
            throw new Error('Failed to create payment method');
        }
    }

    // List all payments
    async listPayments(limit = 10) {
        try {
            const response = await this.client.get('/payments', {
                params: { limit }
            });
            return response.data.data;
        } catch (error) {
            console.error('PayMongo list payments error:', error.response?.data || error.message);
            throw new Error('Failed to list payments');
        }
    }

    // Get payment by ID
    async getPayment(paymentId) {
        try {
            const response = await this.client.get(`/payments/${paymentId}`);
            return response.data.data;
        } catch (error) {
            console.error('PayMongo get payment error:', error.response?.data || error.message);
            throw new Error('Failed to retrieve payment');
        }
    }

    // Refund payment
    async refundPayment(paymentId, amount, reason = 'requested_by_customer') {
        try {
            const response = await this.client.post('/refunds', {
                data: {
                    attributes: {
                        payment_id: paymentId,
                        amount: Math.floor(amount * 100),
                        reason
                    }
                }
            });
            return response.data;
        } catch (error) {
            console.error('PayMongo refund error:', error.response?.data || error.message);
            throw new Error('Failed to process refund');
        }
    }

    // Expire checkout session
    async expireCheckoutSession(sessionId) {
        try {
            const response = await this.client.post(`/checkout_sessions/${sessionId}/expire`);
            return response.data;
        } catch (error) {
            console.error('PayMongo expire session error:', error.response?.data || error.message);
            throw new Error('Failed to expire checkout session');
        }
    }

    // Get checkout session details
    async getCheckoutSession(sessionId) {
        try {
            const response = await this.client.get(`/checkout_sessions/${sessionId}`);
            return response.data.data;
        } catch (error) {
            console.error('PayMongo get checkout session error:', error.response?.data || error.message);
            throw new Error('Failed to retrieve checkout session');
        }
    }

    // List webhooks
    async listWebhooks() {
        try {
            const response = await this.client.get('/webhooks');
            return response.data.data;
        } catch (error) {
            console.error('PayMongo list webhooks error:', error.response?.data || error.message);
            throw new Error('Failed to list webhooks');
        }
    }

    // Create webhook (for initial setup)
    async createWebhook(url, events = ['payment.paid', 'payment.failed']) {
        try {
            const response = await this.client.post('/webhooks', {
                data: {
                    attributes: {
                        url,
                        events
                    }
                }
            });
            return response.data;
        } catch (error) {
            console.error('PayMongo create webhook error:', error.response?.data || error.message);
            throw new Error('Failed to create webhook');
        }
    }
}

module.exports = new PayMongoService();