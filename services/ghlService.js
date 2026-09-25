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

    isConfigured() {
        return Boolean(this.privateKey && this.locationId);
    }

    getConfiguredLocations() {
        const locations = [];

        if (process.env.GHL_LOCATIONS_JSON) {
            try {
                let parsed;
                try {
                    parsed = JSON.parse(process.env.GHL_LOCATIONS_JSON);
                } catch (err) {
                    parsed = JSON.parse(process.env.GHL_LOCATIONS_JSON.replace(/\\"/g, '"'));
                }
                if (Array.isArray(parsed)) {
                    for (const location of parsed) {
                        if (location?.locationId && location?.pit) {
                            locations.push({
                                name: location.name || location.locationId,
                                locationId: String(location.locationId),
                                privateKey: String(location.pit)
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn('GHL_LOCATIONS_JSON is invalid:', err.message);
            }
        }

        if (locations.length === 0 && this.privateKey && this.locationId) {
            locations.push({
                name: process.env.GHL_BUSINESS_NAME || this.locationId,
                locationId: this.locationId,
                privateKey: this.privateKey
            });
        }

        return locations;
    }

    createClient({ privateKey, locationId, version = '2021-07-28' }) {
        return axios.create({
            baseURL: this.baseURL,
            timeout: 15000,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${privateKey}`,
                Version: version,
                LocationId: locationId
            }
        });
    }

    normalizeCoupon(coupon, location) {
        return {
            id: coupon._id || coupon.id || coupon.couponId || '',
            code: coupon.code || coupon.couponCode || '',
            name: coupon.name || '',
            status: coupon.status || '',
            discountType: coupon.discountType || coupon.type || '',
            discountValue: coupon.discountValue ?? coupon.value ?? null,
            usageLimit: coupon.usageLimit ?? coupon.maxRedemptions ?? null,
            redemptionCount: coupon.redemptionCount ?? coupon.usageCount ?? coupon.usedCount ?? null,
            startDate: coupon.startDate || coupon.startsAt || null,
            endDate: coupon.endDate || coupon.expiresAt || null,
            createdAt: coupon.createdAt || null,
            locationName: location.name,
            locationId: location.locationId
        };
    }

    async listCouponsForLocation(location, { search, status, limit = 100 } = {}) {
        const client = this.createClient({
            privateKey: location.privateKey,
            locationId: location.locationId,
            version: 'v3'
        });
        const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 100);
        const allCoupons = [];
        let offset = 0;
        let totalCount = null;

        do {
            const params = {
                altId: location.locationId,
                altType: 'location',
                limit: pageSize,
                offset
            };
            if (search) params.search = String(search);
            if (status) params.status = String(status);

            const res = await client.get('/payments/coupon/list', { params });
            const page = Array.isArray(res.data?.data)
                ? res.data.data
                : Array.isArray(res.data?.coupons)
                    ? res.data.coupons
                    : Array.isArray(res.data)
                        ? res.data
                        : [];
            totalCount = Number.isFinite(Number(res.data?.totalCount)) ? Number(res.data.totalCount) : null;
            allCoupons.push(...page.map((coupon) => this.normalizeCoupon(coupon, location)));

            if (page.length < pageSize) break;
            offset += pageSize;
        } while (totalCount == null || offset < totalCount);

        return {
            location: {
                name: location.name,
                locationId: location.locationId
            },
            coupons: allCoupons,
            totalCount: totalCount ?? allCoupons.length
        };
    }

    async listCouponsAcrossLocations(options = {}) {
        const locations = this.getConfiguredLocations();
        if (locations.length === 0) {
            return { coupons: [], locations: [], errors: [] };
        }

        const results = await Promise.allSettled(
            locations.map((location) => this.listCouponsForLocation(location, options))
        );
        const coupons = [];
        const errors = [];

        results.forEach((result, index) => {
            const location = locations[index];
            if (result.status === 'fulfilled') {
                coupons.push(...result.value.coupons);
            } else {
                errors.push({
                    locationName: location.name,
                    locationId: location.locationId,
                    error: result.reason?.response?.data?.message
                        || result.reason?.response?.data?.error
                        || result.reason?.message
                        || 'Failed to fetch GHL coupons'
                });
            }
        });

        coupons.sort((a, b) => {
            const locationCompare = String(a.locationName).localeCompare(String(b.locationName));
            if (locationCompare !== 0) return locationCompare;
            return String(a.code || a.name).localeCompare(String(b.code || b.name));
        });

        return {
            coupons,
            locations: locations.map(({ name, locationId }) => ({ name, locationId })),
            errors
        };
    }

    buildCouponPayload(coupon, locationId) {
        const payload = {
            altId: locationId,
            altType: 'location',
            name: coupon.name || coupon.code,
            code: coupon.code,
            discountType: 'percentage',
            discountValue: Number((Number(coupon.discountPercent || 0) * 100).toFixed(4)),
            startDate: new Date().toISOString(),
            usageLimit: coupon.maxRedemptions || undefined,
            endDate: coupon.expiresAt || undefined,
            applyToFuturePayments: true,
            applyToFuturePaymentsConfig: { type: 'forever' },
            limitPerCustomer: true
        };

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
        return payload;
    }

    async createCouponForLocation(location, coupon) {
        const client = this.createClient({
            privateKey: location.privateKey,
            locationId: location.locationId,
            version: 'v3'
        });
        const payload = this.buildCouponPayload(coupon, location.locationId);
        const res = await client.post('/payments/coupon', payload);
        return this.normalizeCoupon(res.data || payload, location);
    }

    async syncCouponsToGhlLocations(coupons = []) {
        const locations = this.getConfiguredLocations();
        const results = [];
        const activeCoupons = coupons.filter((coupon) => coupon.active);
        const inactiveCoupons = coupons.filter((coupon) => !coupon.active);

        if (locations.length === 0) {
            return {
                summary: {
                    locations: 0,
                    localCoupons: coupons.length,
                    activeCoupons: activeCoupons.length,
                    created: 0,
                    skippedExisting: 0,
                    skippedInactive: inactiveCoupons.length,
                    errors: coupons.length
                },
                results: coupons.map((coupon) => ({
                    code: coupon.code,
                    action: 'error',
                    error: 'No GHL locations are configured'
                }))
            };
        }

        for (const location of locations) {
            let existingCodes = new Set();
            try {
                const existing = await this.listCouponsForLocation(location);
                existingCodes = new Set(existing.coupons.map((coupon) => String(coupon.code || '').toUpperCase()).filter(Boolean));
            } catch (err) {
                const error = err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to list GHL coupons';
                for (const coupon of activeCoupons) {
                    results.push({
                        locationName: location.name,
                        locationId: location.locationId,
                        code: coupon.code,
                        action: 'error',
                        error
                    });
                }
                continue;
            }

            for (const coupon of activeCoupons) {
                if (existingCodes.has(String(coupon.code).toUpperCase())) {
                    results.push({
                        locationName: location.name,
                        locationId: location.locationId,
                        code: coupon.code,
                        action: 'skipped_existing'
                    });
                    continue;
                }

                try {
                    const created = await this.createCouponForLocation(location, {
                        ...coupon,
                        name: coupon.notes || coupon.code
                    });
                    results.push({
                        locationName: location.name,
                        locationId: location.locationId,
                        code: coupon.code,
                        action: 'created',
                        ghlCouponId: created.id || null
                    });
                    existingCodes.add(String(coupon.code).toUpperCase());
                } catch (err) {
                    results.push({
                        locationName: location.name,
                        locationId: location.locationId,
                        code: coupon.code,
                        action: 'error',
                        error: err.response?.data?.message
                            || err.response?.data?.error
                            || err.message
                            || 'Failed to create GHL coupon'
                    });
                }
            }
        }

        for (const coupon of inactiveCoupons) {
            results.push({
                code: coupon.code,
                action: 'skipped_inactive'
            });
        }

        return {
            summary: {
                locations: locations.length,
                localCoupons: coupons.length,
                activeCoupons: activeCoupons.length,
                created: results.filter((result) => result.action === 'created').length,
                skippedExisting: results.filter((result) => result.action === 'skipped_existing').length,
                skippedInactive: inactiveCoupons.length,
                errors: results.filter((result) => result.action === 'error').length
            },
            results
        };
    }

    async createCoupon({ name, code, discountPercent, maxRedemptions, productIds = [], expiresAt }) {
        if (!this.isConfigured()) {
            throw new Error('GHL_PRIVATE_KEY and GHL_LOCATION_ID are required to create a GHL coupon');
        }

        const payload = {
            altId: this.locationId,
            altType: 'location',
            name: name || code,
            code,
            discountType: 'percentage',
            discountValue: Number((Number(discountPercent || 0) * 100).toFixed(4)),
            startDate: new Date().toISOString(),
            usageLimit: maxRedemptions || undefined,
            productIds: Array.isArray(productIds) && productIds.length ? productIds : undefined,
            endDate: expiresAt || undefined,
            applyToFuturePayments: true,
            applyToFuturePaymentsConfig: { type: 'forever' },
            limitPerCustomer: true
        };

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

        const res = await this.client.post('/payments/coupon', payload, {
            headers: { Version: '2021-04-15' }
        });
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

    async createInvoiceSchedule({ contactId, contactDetails, name, currency, items, startAt, interval = 'month', intervalCount = 1 }) {
        if (!contactId) throw new Error('contactId is required');
        if (!startAt) throw new Error('startAt is required (YYYY-MM-DD)');
        if (!Array.isArray(items) || items.length === 0) throw new Error('items is required');

        const startDate = String(startAt).slice(0, 10);
        // Some accounts validate that you must specify either `executeAt` (one-time scheduling)
        // or `rrule` (recurring scheduling), but not both.

        const startDateObj = new Date(`${startDate}T00:00:00.000Z`);
        const dayOfMonth = Number(startDate.slice(8, 10));
        const computedWeek = Number.isFinite(dayOfMonth) ? Math.ceil(dayOfMonth / 7) : undefined;
        const numOfWeek = (computedWeek && computedWeek >= 1 && computedWeek <= 4) ? computedWeek : -1;
        const dayOfWeekValues = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
        const dayOfWeek = Number.isFinite(startDateObj.getUTCDay())
            ? dayOfWeekValues[startDateObj.getUTCDay()]
            : undefined;

        const normalizedPhoneNo = this.normalizePhoneE164(contactDetails?.phoneNo);
        const normalizedContactDetails = {
            ...(contactDetails || {}),
            phoneNo: normalizedPhoneNo || undefined
        };
        Object.keys(normalizedContactDetails).forEach(k => normalizedContactDetails[k] === undefined && delete normalizedContactDetails[k]);

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
                ,
                ...normalizedContactDetails
            },
            discount: {
                value: 0,
                type: 'percentage',
                validOnProductIds: []
            },
            items,
            schedule: {
                rrule: {
                    startDate,
                    intervalType: String(interval || 'month').toLowerCase() === 'month' ? 'monthly' : 'monthly',
                    interval: Number(intervalCount) || 1,
                    dayOfMonth: Number.isFinite(dayOfMonth) ? dayOfMonth : undefined,
                    dayOfWeek: dayOfWeek || undefined,
                    numOfWeek,
                    startTime: '00:00:00'
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
