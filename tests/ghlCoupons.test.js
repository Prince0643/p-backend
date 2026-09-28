require('./setupEnv');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ghlService = require('../services/ghlService');

test('GHL coupons are aggregated across configured locations with partial failures', async () => {
    const originalLocationsJson = process.env.GHL_LOCATIONS_JSON;
    const originalPrivateKey = process.env.GHL_PRIVATE_KEY;
    const originalLocationId = process.env.GHL_LOCATION_ID;
    const originalListCouponsForLocation = ghlService.listCouponsForLocation;

    process.env.GHL_LOCATIONS_JSON = JSON.stringify([
        { name: 'Alpha Location', locationId: 'loc_alpha', pit: 'pit_alpha' },
        { name: 'Beta Location', locationId: 'loc_beta', pit: 'pit_beta' }
    ]);
    delete process.env.GHL_PRIVATE_KEY;
    delete process.env.GHL_LOCATION_ID;

    ghlService.listCouponsForLocation = async (location) => {
        if (location.locationId === 'loc_beta') {
            throw new Error('token rejected');
        }
        return {
            location: { name: location.name, locationId: location.locationId },
            coupons: [
                {
                    id: 'coupon_1',
                    code: 'AFF123',
                    name: 'Affiliate code',
                    status: 'active',
                    locationName: location.name,
                    locationId: location.locationId
                }
            ],
            totalCount: 1
        };
    };

    try {
        const result = await ghlService.listCouponsAcrossLocations();
        assert.equal(result.locations.length, 2);
        assert.equal(result.coupons.length, 1);
        assert.equal(result.coupons[0].code, 'AFF123');
        assert.equal(result.coupons[0].locationName, 'Alpha Location');
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].locationId, 'loc_beta');
        assert.match(result.errors[0].error, /token rejected/);
    } finally {
        if (originalLocationsJson === undefined) delete process.env.GHL_LOCATIONS_JSON;
        else process.env.GHL_LOCATIONS_JSON = originalLocationsJson;
        if (originalPrivateKey === undefined) delete process.env.GHL_PRIVATE_KEY;
        else process.env.GHL_PRIVATE_KEY = originalPrivateKey;
        if (originalLocationId === undefined) delete process.env.GHL_LOCATION_ID;
        else process.env.GHL_LOCATION_ID = originalLocationId;
        ghlService.listCouponsForLocation = originalListCouponsForLocation;
    }
});

test('GHL location config accepts escaped JSON from dotenv-quoted env values', () => {
    const originalLocationsJson = process.env.GHL_LOCATIONS_JSON;
    const originalPrivateKey = process.env.GHL_PRIVATE_KEY;
    const originalLocationId = process.env.GHL_LOCATION_ID;

    process.env.GHL_LOCATIONS_JSON = '[{\\"name\\":\\"Escaped Location\\",\\"locationId\\":\\"loc_escaped\\",\\"pit\\":\\"pit_escaped\\"}]';
    delete process.env.GHL_PRIVATE_KEY;
    delete process.env.GHL_LOCATION_ID;

    try {
        const locations = ghlService.getConfiguredLocations();
        assert.equal(locations.length, 1);
        assert.equal(locations[0].name, 'Escaped Location');
        assert.equal(locations[0].locationId, 'loc_escaped');
        assert.equal(locations[0].privateKey, 'pit_escaped');
    } finally {
        if (originalLocationsJson === undefined) delete process.env.GHL_LOCATIONS_JSON;
        else process.env.GHL_LOCATIONS_JSON = originalLocationsJson;
        if (originalPrivateKey === undefined) delete process.env.GHL_PRIVATE_KEY;
        else process.env.GHL_PRIVATE_KEY = originalPrivateKey;
        if (originalLocationId === undefined) delete process.env.GHL_LOCATION_ID;
        else process.env.GHL_LOCATION_ID = originalLocationId;
    }
});

test('GHL sync creates missing active coupons, updates drifted ones, leaves matching ones unchanged, and skips inactive codes', async () => {
    const originalLocationsJson = process.env.GHL_LOCATIONS_JSON;
    const originalPrivateKey = process.env.GHL_PRIVATE_KEY;
    const originalLocationId = process.env.GHL_LOCATION_ID;
    const originalListCouponsForLocation = ghlService.listCouponsForLocation;
    const originalCreateCouponForLocation = ghlService.createCouponForLocation;
    const originalUpdateCouponForLocation = ghlService.updateCouponForLocation;
    const created = [];
    const updated = [];

    process.env.GHL_LOCATIONS_JSON = JSON.stringify([
        { name: 'Sync Location', locationId: 'loc_sync', pit: 'pit_sync' }
    ]);
    delete process.env.GHL_PRIVATE_KEY;
    delete process.env.GHL_LOCATION_ID;

    ghlService.listCouponsForLocation = async (location) => ({
        location,
        coupons: [
            // Matches the local coupon exactly - should be left unchanged.
            {
                code: 'EXISTS', locationName: location.name, locationId: location.locationId,
                id: 'ghl_exists', status: 'active', discountValue: 15, usageLimit: 1, endDate: null,
                applyToFuturePayments: false, limitPerCustomer: true
            },
            // Drifted discount value - should be updated.
            {
                code: 'DRIFTED', locationName: location.name, locationId: location.locationId,
                id: 'ghl_drifted', status: 'active', discountValue: 5, usageLimit: null, endDate: null,
                applyToFuturePayments: false, limitPerCustomer: true, productIds: ['prod_1']
            }
        ],
        totalCount: 2
    });
    ghlService.createCouponForLocation = async (location, coupon) => {
        created.push({ location, coupon });
        return { id: `created_${coupon.code}`, code: coupon.code, locationName: location.name, locationId: location.locationId };
    };
    ghlService.updateCouponForLocation = async (location, existingGhlCoupon, coupon) => {
        updated.push({ location, existingGhlCoupon, coupon });
        return { id: existingGhlCoupon.id, code: coupon.code, locationName: location.name, locationId: location.locationId };
    };

    try {
        const result = await ghlService.syncCouponsToGhlLocations([
            { code: 'EXISTS', type: 'affiliate', active: true, discountPercent: 0.15, maxRedemptions: 1, expiresAt: null },
            { code: 'DRIFTED', type: 'affiliate', active: true, discountPercent: 0.20, maxRedemptions: null, expiresAt: null },
            { code: 'NEWONE', type: 'affiliate', active: true, discountPercent: 0.2, maxRedemptions: null, expiresAt: null },
            { code: 'OFF', type: 'affiliate', active: false, discountPercent: 0.1, maxRedemptions: null, expiresAt: null }
        ]);

        assert.equal(created.length, 1);
        assert.equal(created[0].coupon.code, 'NEWONE');

        assert.equal(updated.length, 1);
        assert.equal(updated[0].coupon.code, 'DRIFTED');
        // The existing GHL coupon's productIds must be preserved verbatim into the update call.
        assert.deepEqual(updated[0].existingGhlCoupon.productIds, ['prod_1']);

        assert.deepEqual(result.summary, {
            locations: 1,
            localCoupons: 4,
            activeCoupons: 3,
            created: 1,
            updated: 1,
            unchanged: 1,
            wouldCreate: 0,
            wouldUpdate: 0,
            notSyncable: 0,
            skippedInactive: 1,
            errors: 0,
            dryRun: false
        });
        assert.equal(result.results.find((row) => row.code === 'EXISTS').action, 'unchanged');
        assert.equal(result.results.find((row) => row.code === 'DRIFTED').action, 'updated');
        assert.equal(result.results.find((row) => row.code === 'OFF').action, 'skipped_inactive');
    } finally {
        if (originalLocationsJson === undefined) delete process.env.GHL_LOCATIONS_JSON;
        else process.env.GHL_LOCATIONS_JSON = originalLocationsJson;
        if (originalPrivateKey === undefined) delete process.env.GHL_PRIVATE_KEY;
        else process.env.GHL_PRIVATE_KEY = originalPrivateKey;
        if (originalLocationId === undefined) delete process.env.GHL_LOCATION_ID;
        else process.env.GHL_LOCATION_ID = originalLocationId;
        ghlService.listCouponsForLocation = originalListCouponsForLocation;
        ghlService.createCouponForLocation = originalCreateCouponForLocation;
        ghlService.updateCouponForLocation = originalUpdateCouponForLocation;
    }
});

test('GHL sync dryRun reports planned creates/updates without writing anything', async () => {
    const originalLocationsJson = process.env.GHL_LOCATIONS_JSON;
    const originalPrivateKey = process.env.GHL_PRIVATE_KEY;
    const originalLocationId = process.env.GHL_LOCATION_ID;
    const originalListCouponsForLocation = ghlService.listCouponsForLocation;
    const originalCreateCouponForLocation = ghlService.createCouponForLocation;
    let createCalls = 0;

    process.env.GHL_LOCATIONS_JSON = JSON.stringify([
        { name: 'Dry Run Location', locationId: 'loc_dry', pit: 'pit_dry' }
    ]);
    delete process.env.GHL_PRIVATE_KEY;
    delete process.env.GHL_LOCATION_ID;

    ghlService.listCouponsForLocation = async (location) => ({ location, coupons: [], totalCount: 0 });
    ghlService.createCouponForLocation = async () => { createCalls++; return {}; };

    try {
        const result = await ghlService.syncCouponsToGhlLocations(
            [{ code: 'DRYNEW', type: 'affiliate', active: true, discountPercent: 0.1, maxRedemptions: null, expiresAt: null }],
            { dryRun: true }
        );
        assert.equal(createCalls, 0, 'dryRun must not actually create anything');
        assert.equal(result.summary.wouldCreate, 1);
        assert.equal(result.summary.dryRun, true);
        assert.equal(result.results[0].action, 'would_create');
    } finally {
        if (originalLocationsJson === undefined) delete process.env.GHL_LOCATIONS_JSON;
        else process.env.GHL_LOCATIONS_JSON = originalLocationsJson;
        if (originalPrivateKey === undefined) delete process.env.GHL_PRIVATE_KEY;
        else process.env.GHL_PRIVATE_KEY = originalPrivateKey;
        if (originalLocationId === undefined) delete process.env.GHL_LOCATION_ID;
        else process.env.GHL_LOCATION_ID = originalLocationId;
        ghlService.listCouponsForLocation = originalListCouponsForLocation;
        ghlService.createCouponForLocation = originalCreateCouponForLocation;
    }
});

test('buildCouponPayload sends applyToFuturePayments:false and limitPerCustomer:true, and omits usageLimit when unset', () => {
    const payload = ghlService.buildCouponPayload({ code: 'FLAGCHECK', discountPercent: 0.1, maxRedemptions: null, expiresAt: null }, 'loc_1');
    assert.equal(payload.applyToFuturePayments, false);
    assert.equal(payload.limitPerCustomer, true);
    assert.equal('usageLimit' in payload, false);
    assert.equal('applyToFuturePaymentsConfig' in payload, false);
});

test('buildCouponUpdatePayload carries over existing productIds/startDate and uses PUT-with-id-in-body shape', () => {
    const existing = {
        id: 'ghl_abc123',
        startDate: '2024-01-01T00:00:00.000Z',
        productIds: ['prod_a', 'prod_b'],
        priceIds: [],
        variantIds: []
    };
    const payload = ghlService.buildCouponUpdatePayload(existing, { code: 'OCTFEST15', discountPercent: 0.15, maxRedemptions: 100, expiresAt: null }, 'loc_1');
    assert.equal(payload.id, 'ghl_abc123');
    assert.equal(payload.altId, 'loc_1');
    assert.equal(payload.altType, 'location');
    assert.equal(payload.startDate, '2024-01-01T00:00:00.000Z');
    assert.deepEqual(payload.productIds, ['prod_a', 'prod_b']);
    assert.equal(payload.applyToFuturePayments, false);
    assert.equal(payload.limitPerCustomer, true);
    assert.equal(payload.usageLimit, 100);
});
