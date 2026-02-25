const axios = require('axios');

class GhlService {
    constructor() {
        this.baseURL = 'https://services.leadconnectorhq.com';
        this.privateKey = process.env.GHL_PRIVATE_KEY;
        this.locationId = process.env.GHL_LOCATION_ID;

        if (!this.privateKey) {
            console.warn('GHL_PRIVATE_KEY is not configured');
        }
        if (!this.locationId) {
            console.warn('GHL_LOCATION_ID is not configured');
        }

        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 15000,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.privateKey}`,
                Version: '2021-07-28',
                LocationId: this.locationId
            }
        });
    }

    normalizePhoneE164(phone) {
        if (!phone) return undefined;
        const raw = String(phone).trim();
        if (!raw) return undefined;
        const digits = raw.replace(/\D/g, '');
        if (!digits) return undefined;

        if (raw.startsWith('+')) {
            return `+${digits}`;
        }

        if (digits.startsWith('63')) {
            return `+${digits}`;
        }

        if (digits.startsWith('09') && digits.length === 11) {
            return `+63${digits.substring(1)}`;
        }

        if (digits.startsWith('9') && digits.length === 10) {
            return `+63${digits}`;
        }

        if (digits.length >= 10) {
            return `+${digits}`;
        }

        return undefined;
    }

    async upsertContact({ fullName, email, phone }) {
        const name = String(fullName || '').trim();
        const [firstName, ...rest] = name.split(' ').filter(Boolean);
        const lastName = rest.join(' ');

        const normalizedPhone = this.normalizePhoneE164(phone);

        const payload = {
            firstName: firstName || name || undefined,
            lastName: lastName || undefined,
            name: name || undefined,
            email: email || undefined,
            phone: normalizedPhone || undefined,
            locationId: this.locationId
        };

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

        const res = await this.client.post('/contacts/upsert', payload);
        return res.data;
    }

    async createInvoice({ contactId, contactDetails, items, name, currency, issueDate, dueDate }) {
        const normalizedPhoneNo = this.normalizePhoneE164(contactDetails?.phoneNo);
        const normalizedContactDetails = {
            ...(contactDetails || {}),
            phoneNo: normalizedPhoneNo || undefined
        };
        Object.keys(normalizedContactDetails).forEach(k => normalizedContactDetails[k] === undefined && delete normalizedContactDetails[k]);

        const payload = {
            altId: this.locationId,
            altType: 'location',
            name: name || 'PayMongo Invoice',
            businessDetails: {
                name: process.env.GHL_BUSINESS_NAME || 'Nexistry Academy'
            },
            currency: currency || 'PHP',
            items,
            contactDetails: {
                id: contactId,
                ...normalizedContactDetails
            },
            issueDate,
            dueDate,
            liveMode: true
        };

        const res = await this.client.post('/invoices/', payload);
        return res.data;
    }

    async recordInvoicePayment({ invoiceId, amount, mode = 'card', cardBrand, cardLast4, notes, fulfilledAt }) {
        if (!invoiceId) {
            throw new Error('invoiceId is required');
        }

        const payload = {
            altId: this.locationId,
            altType: 'location',
            mode: mode || 'card',
            ...(cardBrand && cardLast4 && {
                card: {
                    brand: cardBrand,
                    last4: cardLast4
                }
            }),
            notes: notes || 'Payment via PayMongo',
            amount: amount,
            fulfilledAt: fulfilledAt || new Date().toISOString()
        };

        const res = await this.client.post(`/invoices/${invoiceId}/record-payment`, payload);
        return res.data;
    }
}

module.exports = new GhlService();
