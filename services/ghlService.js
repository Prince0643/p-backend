const axios = require('axios');

class GhlService {
    constructor() {
        this.baseURL = 'https://services.leadconnectorhq.com';
        this.privateKey = process.env.GHL_PRIVATE_KEY;
        this.locationId = process.env.GHL_LOCATION_ID;
        this.invoiceScheduleLiveMode = String(process.env.GHL_INVOICE_SCHEDULE_LIVE_MODE || 'true').toLowerCase() === 'true';
        this.invoiceScheduleStrict = String(process.env.GHL_INVOICE_SCHEDULE_STRICT || 'false').toLowerCase() === 'true';

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

    async listInvoiceSchedules({ search, limit = 50, offset = 0, startAt, endAt, status }) {
        const params = {
            altId: this.locationId,
            altType: 'location',
            limit,
            offset
        };
        if (search) params.search = String(search);
        if (startAt) params.startAt = String(startAt);
        if (endAt) params.endAt = String(endAt);
        if (status) params.status = String(status);

        const res = await this.client.get('/invoices/schedule', { params });
        return res.data;
    }

    async createInvoiceSchedule({ contactId, name, currency, items, startAt, interval = 'month', intervalCount = 1 }) {
        if (!contactId) throw new Error('contactId is required');
        if (!startAt) throw new Error('startAt is required (YYYY-MM-DD)');
        if (!Array.isArray(items) || items.length === 0) throw new Error('items is required');

        const executeAt = String(startAt).includes('T')
            ? String(startAt)
            : `${String(startAt)}T00:00:00.000Z`;

        // The schedule APIs use a nested schedule object with `executeAt` + `rrule` in responses.
        // Construct a minimal payload that matches that shape.
        const payload = {
            altId: this.locationId,
            altType: 'location',
            liveMode: this.invoiceScheduleLiveMode,
            name: name || 'Recurring Invoice',
            currency: currency || 'PHP',
            businessDetails: {
                name: process.env.GHL_BUSINESS_NAME || 'Nexistry Academy'
            },
            contactDetails: {
                id: contactId
            },
            discount: {
                value: 0,
                type: 'percentage',
                validOnProductIds: []
            },
            items,
            schedule: {
                executeAt,
                rrule: {
                    freq: String(interval || 'month').toLowerCase() === 'month' ? 'MONTHLY' : 'MONTHLY',
                    interval: Number(intervalCount) || 1
                }
            }
        };

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

        try {
            const res = await this.client.post('/invoices/schedule', payload);
            return res.data;
        } catch (err) {
            const details = err.response?.data || err.message;
            console.log('GHL createInvoiceSchedule error:', details);
            console.log('GHL createInvoiceSchedule payload:', JSON.stringify(payload, null, 2));
            if (this.invoiceScheduleStrict) throw err;
            throw err;
        }
    }

    async scheduleInvoiceSchedule({ scheduleId }) {
        if (!scheduleId) throw new Error('scheduleId is required');
        const payload = {
            altId: this.locationId,
            altType: 'location',
            liveMode: this.invoiceScheduleLiveMode,
            autoPayment: { enable: false }
        };
        const res = await this.client.post(`/invoices/schedule/${scheduleId}/schedule`, payload);
        return res.data;
    }
}

module.exports = new GhlService();
