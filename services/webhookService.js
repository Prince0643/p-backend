// services/webhookService.js
const axios = require('axios');

class WebhookService {
    constructor() {
        this.leadConnectorWebhook = process.env.LEADCONNECTOR_WEBHOOK;
    }

    async sendToLeadConnector(data) {
        if (String(process.env.DISABLE_LEADCONNECTOR_WEBHOOK).toLowerCase() === 'true') {
            return;
        }

        if (!this.leadConnectorWebhook) {
            console.log('LeadConnector webhook URL not configured');
            return;
        }

        try {
            const response = await axios.post(this.leadConnectorWebhook, data, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 10000 // 10 second timeout
            });

            console.log('LeadConnector webhook sent successfully');
            return response.data;
        } catch (error) {
            console.error('Failed to send to LeadConnector:', error.message);

            // Retry once after 5 seconds
            setTimeout(async () => {
                try {
                    await axios.post(this.leadConnectorWebhook, {
                        ...data,
                        retry: true,
                        originalError: error.message
                    });
                    console.log('LeadConnector webhook retry successful');
                } catch (retryError) {
                    console.error('LeadConnector webhook retry failed:', retryError.message);
                }
            }, 5000);

            throw error;
        }
    }

    async sendToMultipleWebhooks(data, webhooks) {
        const promises = webhooks.map(webhook =>
            axios.post(webhook.url, data, {
                headers: webhook.headers || { 'Content-Type': 'application/json' },
                timeout: 5000
            }).catch(error => ({
                webhook: webhook.url,
                error: error.message
            }))
        );

        const results = await Promise.allSettled(promises);

        const failures = results
            .filter(r => r.status === 'rejected')
            .map(r => r.reason);

        if (failures.length > 0) {
            console.error('Some webhooks failed:', failures);
        }

        return results;
    }
}

module.exports = new WebhookService();