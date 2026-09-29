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

    /**
     * Resolves the "Nexistry Core Global" GHL location (native GHL checkout, USD) from
     * configured locations, by env GHL_GLOBAL_LOCATION_ID, falling back to
     * GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL. Returns null if not configured.
     */
    resolveGlobalLocation() {
        const targetId = process.env.GHL_GLOBAL_LOCATION_ID || process.env.GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL;
        if (!targetId) return null;
        const configured = this.getConfiguredLocations().find((l) => l.locationId === targetId);
        if (configured) return configured;
        // GHL_LOCATIONS_JSON may be unset (prod): fall back to a dedicated env key for the
        // Global location.
        if (process.env.GHL_GLOBAL_PRIVATE_KEY) {
            return { name: 'Nexistry Core Global', locationId: targetId, privateKey: process.env.GHL_GLOBAL_PRIVATE_KEY };
        }
        return null;
    }

    /** The MAIN location, straight from env GHL_LOCATION_ID + GHL_PRIVATE_KEY (independent of GHL_LOCATIONS_JSON). */
    resolveMainLocation() {
        if (!this.privateKey || !this.locationId) return null;
        return { name: process.env.GHL_BUSINESS_NAME || 'Main', locationId: this.locationId, privateKey: this.privateKey };
    }

    /**
     * The two locations order import and affiliate-coupon push work against, keyed
     * 'global' | 'main'. Unconfigured ones are omitted; MAIN is omitted when it is the
     * same GHL location as GLOBAL.
     */
    getTrackedLocations() {
        const locations = [];
        const global = this.resolveGlobalLocation();
        if (global) locations.push({ key: 'global', ...global });
        const main = this.resolveMainLocation();
        if (main && (!global || global.locationId !== main.locationId)) locations.push({ key: 'main', ...main });
        return locations;
    }

    /** Lists all products in the Global GHL location, with best-effort price lookup (null if unavailable). */
    async listGlobalLocationProducts() {
        const location = this.resolveGlobalLocation();
        if (!location) {
            const err = new Error('Global GHL location is not configured');
            err.statusCode = 502;
            throw err;
        }

        const client = this.createClient({ privateKey: location.privateKey, locationId: location.locationId, version: '2021-07-28' });
        const products = [];
        let offset = 0;
        const limit = 100;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const res = await client.get('/products/', { params: { locationId: location.locationId, limit, offset } });
            const page = Array.isArray(res.data?.products) ? res.data.products : Array.isArray(res.data) ? res.data : [];
            products.push(...page);
            if (page.length < limit) break;
            offset += limit;
        }

        const withPrices = await Promise.all(products.map(async (p) => {
            const ref = p._id || p.id;
            let price = null;
            let currency = null;
            const firstPrice = Array.isArray(p.prices) && p.prices.length ? p.prices[0] : null;
            if (firstPrice) {
                price = firstPrice.amount ?? null;
                currency = firstPrice.currency ?? null;
            } else {
                try {
                    const priceRes = await client.get(`/products/${ref}/price`, { params: { locationId: location.locationId } });
                    const priceData = Array.isArray(priceRes.data?.prices) ? priceRes.data.prices[0] : priceRes.data?.price || priceRes.data;
                    price = priceData?.amount ?? null;
                    currency = priceData?.currency ?? null;
                } catch {
                    price = null;
                    currency = null;
                }
            }
            return { ref, name: p.name || '', price, currency };
        }));

        return withPrices;
    }

    createClient({ privateKey, locationId, version = '2021-07-28' }) {
        // Safety net: this builds a real axios client that talks to the live GHL API.
        // Tests must always mock `ghlService.createClient` (or the higher-level method
        // that calls it) rather than let this real implementation run - see
        // tests/ghlCoupons.test.js, tests/ghlOrderImport.test.js, tests/campaignSites.test.js.
        // If a test path reaches here it means a mock is missing and a real request is
        // about to be sent, which has previously created junk coupons in production GHL.
        if (process.env.NODE_ENV === 'test') {
            throw new Error(
                'ghlService.createClient() was called for real during NODE_ENV=test - mock ' +
                'ghlService.createClient (or the calling method) instead of letting this reach ' +
                'the live GHL API.'
            );
        }
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
            discountValue: (coupon.discountValue ?? coupon.value) != null
                ? Number(coupon.discountValue ?? coupon.value)
                : null,
            usageLimit: (coupon.usageLimit ?? coupon.maxRedemptions) != null
                ? Number(coupon.usageLimit ?? coupon.maxRedemptions)
                : null,
            redemptionCount: coupon.redemptionCount ?? coupon.usageCount ?? coupon.usedCount ?? null,
            startDate: coupon.startDate || coupon.startsAt || null,
            endDate: coupon.endDate || coupon.expiresAt || null,
            createdAt: coupon.createdAt || null,
            // GHL's Update Coupon (PUT /payments/coupon) is a full replace - these fields
            // must be carried over from the existing coupon on update unless our DB
            // intends to change them, or an update would silently wipe e.g. product
            // restrictions. There is no `status` field on update, so active/inactive
            // drift can only be reported, never synced (see couponNeedsUpdate).
            applyToFuturePayments: coupon.applyToFuturePayments,
            limitPerCustomer: coupon.limitPerCustomer,
            productIds: Array.isArray(coupon.productIds) ? coupon.productIds : [],
            priceIds: Array.isArray(coupon.priceIds) ? coupon.priceIds : [],
            variantIds: Array.isArray(coupon.variantIds) ? coupon.variantIds : [],
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

    /**
     * GHL rejects coupon names over 100 chars ("name must be shorter than or equal
     * to 100 characters"). Collapses internal whitespace and truncates, appending an
     * ellipsis within the 100-char budget so truncation is visible in the GHL UI.
     */
    truncateCouponName(value) {
        const collapsed = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        if (collapsed.length <= 100) return collapsed;
        return `${collapsed.slice(0, 99)}…`;
    }

    /**
     * Resolves the GHL coupon `name` field from the first non-empty candidate (in
     * priority order), then clamps it to GHL's 100-char limit. Shared by create and
     * update payload builders so every code path that names a GHL coupon is clamped
     * the same way.
     */
    resolveCouponName(...candidates) {
        const first = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
        return this.truncateCouponName(first || '');
    }

    /** Payload for POST /payments/coupon (create). */
    buildCouponPayload(coupon, locationId) {
        const payload = {
            altId: locationId,
            altType: 'location',
            name: this.resolveCouponName(coupon.name, coupon.notes, coupon.code),
            code: coupon.code,
            discountType: 'percentage',
            discountValue: Number((Number(coupon.discountPercent || 0) * 100).toFixed(4)),
            startDate: new Date().toISOString(),
            // GHL defaults applyToFuturePayments to TRUE and limitPerCustomer to FALSE
            // when omitted - both are always sent explicitly so a coupon never silently
            // gets the opposite of what we intend.
            applyToFuturePayments: false,
            limitPerCustomer: true
        };
        if (coupon.maxRedemptions) payload.usageLimit = coupon.maxRedemptions;
        if (coupon.expiresAt) payload.endDate = coupon.expiresAt;

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
        return payload;
    }

    /**
     * Payload for PUT /payments/coupon (update - full replace, id in body, NOT in the
     * URL). Must carry over the existing GHL coupon's productIds/priceIds/variantIds/
     * startDate/name unless our DB intends to change them, or the update would silently
     * wipe e.g. OCTFEST15's product restrictions. There is no `status` field on update.
     */
    buildCouponUpdatePayload(existingGhlCoupon, coupon, locationId) {
        const payload = {
            id: existingGhlCoupon.id,
            altId: locationId,
            altType: 'location',
            name: this.resolveCouponName(coupon.name, existingGhlCoupon.name, coupon.code),
            code: coupon.code,
            discountType: 'percentage',
            discountValue: Number((Number(coupon.discountPercent || 0) * 100).toFixed(4)),
            startDate: existingGhlCoupon.startDate || new Date().toISOString(),
            applyToFuturePayments: false,
            limitPerCustomer: true
        };
        if (coupon.maxRedemptions) payload.usageLimit = coupon.maxRedemptions;
        if (coupon.expiresAt) payload.endDate = coupon.expiresAt;
        if (Array.isArray(existingGhlCoupon.productIds) && existingGhlCoupon.productIds.length) {
            payload.productIds = existingGhlCoupon.productIds;
        }
        if (Array.isArray(existingGhlCoupon.priceIds) && existingGhlCoupon.priceIds.length) {
            payload.priceIds = existingGhlCoupon.priceIds;
        }
        if (Array.isArray(existingGhlCoupon.variantIds) && existingGhlCoupon.variantIds.length) {
            payload.variantIds = existingGhlCoupon.variantIds;
        }

        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
        return payload;
    }

    /**
     * True if the existing GHL coupon's syncable settings have drifted from what our
     * local coupon record wants. Status (active/inactive) is deliberately excluded -
     * there is no way to toggle it via Update Coupon, so drift there is reported
     * separately as "not syncable" rather than attempted.
     */
    couponNeedsUpdate(existingGhlCoupon, coupon) {
        const expectedDiscountValue = Number((Number(coupon.discountPercent || 0) * 100).toFixed(4));
        const expectedUsageLimit = coupon.maxRedemptions ? Number(coupon.maxRedemptions) : null;
        const existingUsageLimit = existingGhlCoupon.usageLimit != null ? Number(existingGhlCoupon.usageLimit) : null;
        const expectedEndDate = coupon.expiresAt ? new Date(coupon.expiresAt).toISOString() : null;
        const existingEndDate = existingGhlCoupon.endDate ? new Date(existingGhlCoupon.endDate).toISOString() : null;

        // The live GHL API returns these as numbers (1/0) as often as booleans, so
        // compare truthiness rather than strict equality. GHL defaults
        // applyToFuturePayments to TRUE when the field is omitted entirely, so
        // undefined/null must be treated as "true" (i.e. needs update), not as falsy.
        const applyToFuturePayments = existingGhlCoupon.applyToFuturePayments == null
            ? true
            : Boolean(existingGhlCoupon.applyToFuturePayments);
        const limitPerCustomer = Boolean(existingGhlCoupon.limitPerCustomer);

        if (Number(existingGhlCoupon.discountValue) !== expectedDiscountValue) return true;
        if (existingUsageLimit !== expectedUsageLimit) return true;
        if (existingEndDate !== expectedEndDate) return true;
        if (applyToFuturePayments) return true;
        if (!limitPerCustomer) return true;
        return false;
    }

    /** True if the coupon's active/inactive status can't be reflected by an update call (always, today). */
    statusDrifted(existingGhlCoupon, coupon) {
        const wantActive = Boolean(coupon.active);
        const isActive = String(existingGhlCoupon.status || '').toLowerCase() === 'active';
        return wantActive !== isActive;
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

    async updateCouponForLocation(location, existingGhlCoupon, coupon) {
        const client = this.createClient({
            privateKey: location.privateKey,
            locationId: location.locationId,
            version: 'v3'
        });
        const payload = this.buildCouponUpdatePayload(existingGhlCoupon, coupon, location.locationId);
        const res = await client.put('/payments/coupon', payload);
        return this.normalizeCoupon(res.data || payload, location);
    }

    /**
     * Creates missing coupons and updates drifted ones across configured GHL locations.
     * AFFILIATE coupons sync to every configured location; GENERAL coupons sync only to
     * their `ghlLocationIds` (or every location when that's null). `dryRun: true` reports
     * the planned creates/updates without writing anything.
     */
    async syncCouponsToGhlLocations(allCoupons = [], { dryRun = false } = {}) {
        // Coupons discovered from native GHL orders (origin 'ghl') already live in GHL and
        // are owned there - they must never be created/updated from our side.
        const coupons = allCoupons.filter((coupon) => coupon.origin !== 'ghl');
        const allLocations = this.getConfiguredLocations();
        const activeCoupons = coupons.filter((coupon) => coupon.active);
        const inactiveCoupons = coupons.filter((coupon) => !coupon.active);
        const results = [];

        if (allLocations.length === 0) {
            return {
                summary: {
                    locations: 0, localCoupons: coupons.length, activeCoupons: activeCoupons.length,
                    created: 0, updated: 0, unchanged: 0, notSyncable: 0,
                    skippedInactive: inactiveCoupons.length, errors: coupons.length, dryRun
                },
                results: coupons.map((coupon) => ({
                    code: coupon.code,
                    action: 'error',
                    error: 'No GHL locations are configured'
                }))
            };
        }

        const targetLocationsFor = (coupon) => {
            if (coupon.type === 'affiliate') return allLocations;
            if (Array.isArray(coupon.ghlLocationIds) && coupon.ghlLocationIds.length > 0) {
                return allLocations.filter((l) => coupon.ghlLocationIds.includes(l.locationId));
            }
            return allLocations;
        };

        const existingCache = new Map();
        const getExistingForLocation = async (location) => {
            if (existingCache.has(location.locationId)) return existingCache.get(location.locationId);
            try {
                const existing = await this.listCouponsForLocation(location);
                const map = new Map(existing.coupons.map((c) => [String(c.code || '').toUpperCase(), c]));
                existingCache.set(location.locationId, map);
                return map;
            } catch (err) {
                const error = err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to list GHL coupons';
                const errored = { error };
                existingCache.set(location.locationId, errored);
                return errored;
            }
        };

        for (const coupon of activeCoupons) {
            for (const location of targetLocationsFor(coupon)) {
                const existingMap = await getExistingForLocation(location);
                if (existingMap.error) {
                    results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'error', error: existingMap.error });
                    continue;
                }

                const existingCoupon = existingMap.get(String(coupon.code).toUpperCase());

                if (!existingCoupon) {
                    if (dryRun) {
                        results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'would_create' });
                        continue;
                    }
                    try {
                        const created = await this.createCouponForLocation(location, coupon);
                        results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'created', ghlCouponId: created.id || null });
                        existingMap.set(String(coupon.code).toUpperCase(), created);
                    } catch (err) {
                        results.push({
                            locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'error',
                            error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to create GHL coupon'
                        });
                    }
                    continue;
                }

                const statusNote = this.statusDrifted(existingCoupon, coupon) ? 'not_syncable_status' : null;
                if (!this.couponNeedsUpdate(existingCoupon, coupon)) {
                    results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'unchanged', note: statusNote });
                    continue;
                }
                if (dryRun) {
                    results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'would_update', note: statusNote });
                    continue;
                }
                try {
                    const updated = await this.updateCouponForLocation(location, existingCoupon, coupon);
                    results.push({ locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'updated', ghlCouponId: updated.id || existingCoupon.id || null, note: statusNote });
                } catch (err) {
                    results.push({
                        locationName: location.name, locationId: location.locationId, code: coupon.code, action: 'error',
                        error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to update GHL coupon'
                    });
                }
            }
        }

        for (const coupon of inactiveCoupons) {
            results.push({ code: coupon.code, action: 'skipped_inactive' });
        }

        return {
            summary: {
                locations: allLocations.length,
                localCoupons: coupons.length,
                activeCoupons: activeCoupons.length,
                created: results.filter((r) => r.action === 'created').length,
                updated: results.filter((r) => r.action === 'updated').length,
                unchanged: results.filter((r) => r.action === 'unchanged').length,
                wouldCreate: results.filter((r) => r.action === 'would_create').length,
                wouldUpdate: results.filter((r) => r.action === 'would_update').length,
                notSyncable: results.filter((r) => r.note === 'not_syncable_status').length,
                skippedInactive: inactiveCoupons.length,
                errors: results.filter((r) => r.action === 'error').length,
                dryRun
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
            name: this.resolveCouponName(name, null, code),
            code,
            discountType: 'percentage',
            discountValue: Number((Number(discountPercent || 0) * 100).toFixed(4)),
            startDate: new Date().toISOString(),
            usageLimit: maxRedemptions || undefined,
            productIds: Array.isArray(productIds) && productIds.length ? productIds : undefined,
            endDate: expiresAt || undefined,
            applyToFuturePayments: false,
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
