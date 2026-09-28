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

test('couponNeedsUpdate reports no drift when GHL returns limitPerCustomer/applyToFuturePayments as numbers (live API shape)', () => {
    // Real-world example: OCTFEST15 came back as
    // { applyToFuturePayments: false, limitPerCustomer: 1 } and was incorrectly
    // flagged as needing an update by strict `!== true` / `!== false` checks.
    const existing = {
        discountValue: 15,
        usageLimit: 100,
        endDate: null,
        applyToFuturePayments: false,
        limitPerCustomer: 1
    };
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    assert.equal(ghlService.couponNeedsUpdate(existing, coupon), false);
});

test('couponNeedsUpdate reports no drift for the boolean-shaped equivalent (true/false)', () => {
    const existing = {
        discountValue: 15,
        usageLimit: 100,
        endDate: null,
        applyToFuturePayments: false,
        limitPerCustomer: true
    };
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    assert.equal(ghlService.couponNeedsUpdate(existing, coupon), false);
});

test('couponNeedsUpdate flags drift when limitPerCustomer is falsy (0 or false)', () => {
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    const withZero = { discountValue: 15, usageLimit: 100, endDate: null, applyToFuturePayments: false, limitPerCustomer: 0 };
    const withFalse = { discountValue: 15, usageLimit: 100, endDate: null, applyToFuturePayments: false, limitPerCustomer: false };
    assert.equal(ghlService.couponNeedsUpdate(withZero, coupon), true);
    assert.equal(ghlService.couponNeedsUpdate(withFalse, coupon), true);
});

test('couponNeedsUpdate flags drift when applyToFuturePayments is truthy (1 or true)', () => {
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    const withOne = { discountValue: 15, usageLimit: 100, endDate: null, applyToFuturePayments: 1, limitPerCustomer: 1 };
    const withTrue = { discountValue: 15, usageLimit: 100, endDate: null, applyToFuturePayments: true, limitPerCustomer: true };
    assert.equal(ghlService.couponNeedsUpdate(withOne, coupon), true);
    assert.equal(ghlService.couponNeedsUpdate(withTrue, coupon), true);
});

test('couponNeedsUpdate treats a missing/undefined applyToFuturePayments as drift (GHL defaults it to true when omitted)', () => {
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    const missing = { discountValue: 15, usageLimit: 100, endDate: null, limitPerCustomer: true };
    const nullValue = { discountValue: 15, usageLimit: 100, endDate: null, applyToFuturePayments: null, limitPerCustomer: true };
    assert.equal(ghlService.couponNeedsUpdate(missing, coupon), true);
    assert.equal(ghlService.couponNeedsUpdate(nullValue, coupon), true);
});

test('couponNeedsUpdate coerces usageLimit for comparison even when it comes back as a numeric string', () => {
    const existing = {
        discountValue: 15,
        usageLimit: '100',
        endDate: null,
        applyToFuturePayments: false,
        limitPerCustomer: true
    };
    const coupon = { discountPercent: 0.15, maxRedemptions: 100, expiresAt: null };
    assert.equal(ghlService.couponNeedsUpdate(existing, coupon), false);
});

test('normalizeCoupon coerces discountValue and usageLimit to numbers when GHL returns them as strings', () => {
    const location = { name: 'Alpha Location', locationId: 'loc_alpha' };
    const normalized = ghlService.normalizeCoupon({
        _id: 'ghl_1',
        code: 'STRCOERCE',
        discountValue: '15',
        usageLimit: '100',
        applyToFuturePayments: false,
        limitPerCustomer: 1
    }, location);
    assert.equal(normalized.discountValue, 15);
    assert.strictEqual(typeof normalized.discountValue, 'number');
    assert.equal(normalized.usageLimit, 100);
    assert.strictEqual(typeof normalized.usageLimit, 'number');
});

test('normalizeCoupon leaves discountValue/usageLimit as null when GHL omits them', () => {
    const location = { name: 'Alpha Location', locationId: 'loc_alpha' };
    const normalized = ghlService.normalizeCoupon({ _id: 'ghl_2', code: 'NOLIMIT' }, location);
    assert.equal(normalized.discountValue, null);
    assert.equal(normalized.usageLimit, null);
});

test('truncateCouponName collapses whitespace and leaves short names unchanged', () => {
    assert.equal(ghlService.truncateCouponName('  Short   Name  '), 'Short Name');
    assert.equal(ghlService.truncateCouponName(''), '');
});

test('truncateCouponName truncates names over 100 chars and ends with an ellipsis within the limit', () => {
    const long = 'A'.repeat(150);
    const truncated = ghlService.truncateCouponName(long);
    assert.equal(truncated.length, 100);
    assert.ok(truncated.endsWith('…'));
    assert.equal(truncated, `${'A'.repeat(99)}…`);
});

test('buildCouponPayload derives name from PRINC3-style long notes (regression: GHL "name must be <= 100 chars")', () => {
    const longNotes = 'Auto-generated for affiliate '.padEnd(140, 'x');
    const payload = ghlService.buildCouponPayload(
        { code: 'PRINC3', notes: longNotes, discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.ok(payload.name.length <= 100, `expected name <= 100 chars, got ${payload.name.length}`);
    assert.ok(payload.name.endsWith('…'));
});

test('buildCouponPayload keeps short notes unchanged and prefers an explicit name over notes', () => {
    const shortNotesPayload = ghlService.buildCouponPayload(
        { code: 'SHORTNOTE', notes: 'Short note', discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.equal(shortNotesPayload.name, 'Short note');

    const explicitNamePayload = ghlService.buildCouponPayload(
        { code: 'HASNAME', name: 'Explicit Name', notes: 'Some notes that would otherwise be used', discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.equal(explicitNamePayload.name, 'Explicit Name');
});

test('buildCouponPayload falls back to the coupon code when notes are empty', () => {
    const payload = ghlService.buildCouponPayload(
        { code: 'NONOTES', notes: '', discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.equal(payload.name, 'NONOTES');
});

test('buildCouponUpdatePayload keeps carrying over the existing GHL coupon name, clamped to 100 chars', () => {
    const existingLongName = 'B'.repeat(150);
    const payload = ghlService.buildCouponUpdatePayload(
        { id: 'ghl_1', name: existingLongName },
        { code: 'UPDATEME', discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.equal(payload.name.length, 100);
    assert.ok(payload.name.endsWith('…'));
});

test('buildCouponUpdatePayload does not rename an existing coupon when our local record has no explicit name', () => {
    const payload = ghlService.buildCouponUpdatePayload(
        { id: 'ghl_1', name: 'Existing GHL Name' },
        { code: 'UPDATEME', notes: 'Local notes that must not overwrite the existing GHL name', discountPercent: 0.1, maxRedemptions: null, expiresAt: null },
        'loc_1'
    );
    assert.equal(payload.name, 'Existing GHL Name');
});
