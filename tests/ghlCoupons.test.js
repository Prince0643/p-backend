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

test('GHL sync creates missing active coupons and skips existing/inactive codes', async () => {
    const originalLocationsJson = process.env.GHL_LOCATIONS_JSON;
    const originalPrivateKey = process.env.GHL_PRIVATE_KEY;
    const originalLocationId = process.env.GHL_LOCATION_ID;
    const originalListCouponsForLocation = ghlService.listCouponsForLocation;
    const originalCreateCouponForLocation = ghlService.createCouponForLocation;
    const created = [];

    process.env.GHL_LOCATIONS_JSON = JSON.stringify([
        { name: 'Sync Location', locationId: 'loc_sync', pit: 'pit_sync' }
    ]);
    delete process.env.GHL_PRIVATE_KEY;
    delete process.env.GHL_LOCATION_ID;

    ghlService.listCouponsForLocation = async (location) => ({
        location,
        coupons: [{ code: 'EXISTS', locationName: location.name, locationId: location.locationId }],
        totalCount: 1
    });
    ghlService.createCouponForLocation = async (location, coupon) => {
        created.push({ location, coupon });
        return { id: `created_${coupon.code}`, code: coupon.code, locationName: location.name, locationId: location.locationId };
    };

    try {
        const result = await ghlService.syncCouponsToGhlLocations([
            { code: 'EXISTS', active: true, discountPercent: 0.15, maxRedemptions: 1, expiresAt: null },
            { code: 'NEWONE', active: true, discountPercent: 0.2, maxRedemptions: null, expiresAt: null },
            { code: 'OFF', active: false, discountPercent: 0.1, maxRedemptions: null, expiresAt: null }
        ]);

        assert.equal(created.length, 1);
        assert.equal(created[0].coupon.code, 'NEWONE');
        assert.deepEqual(result.summary, {
            locations: 1,
            localCoupons: 3,
            activeCoupons: 2,
            created: 1,
            skippedExisting: 1,
            skippedInactive: 1,
            errors: 0
        });
        assert.equal(result.results.find((row) => row.code === 'EXISTS').action, 'skipped_existing');
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
    }
});
