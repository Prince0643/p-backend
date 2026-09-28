// tests/envSafety.test.js
// Regression guard for a bug where running the test suite created real coupons in
// production GHL: tests/setupEnv.js used to `delete` GHL_* env vars, but index.js (and
// other modules) call `require('dotenv').config()` again on load, which re-populates any
// *deleted* var from the developer's real .env (dotenv never overwrites a var that's
// already an own-property of process.env, even an empty-string one - only a genuinely
// missing/deleted one). This test asserts that after loading the app, no GHL credential
// survives and the service reports no configured locations, so a coupon-sync path can
// never reach the real GHL API during a test run.
require('./setupEnv');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Require index.js the same way the other integration tests do - this is what triggers
// the second `dotenv.config()` call that used to resurrect the deleted GHL_* vars.
require('../index');
const ghlService = require('../services/ghlService');

test('GHL env vars stay blank after the app loads, and no GHL location is configured', () => {
    assert.equal(process.env.GHL_PRIVATE_KEY, '');
    assert.equal(process.env.GHL_LOCATION_ID, '');
    assert.equal(process.env.GHL_LOCATIONS_JSON, '');
    assert.equal(process.env.GHL_GLOBAL_LOCATION_ID, '');
    assert.deepEqual(ghlService.getConfiguredLocations(), []);
    assert.equal(ghlService.isConfigured(), false);
});

test('ghlService.createClient refuses to build a real client while NODE_ENV=test', () => {
    assert.throws(
        () => ghlService.createClient({ privateKey: 'pit_x', locationId: 'loc_x' }),
        /NODE_ENV=test/
    );
});

test('other external-service webhooks stay blank in tests', () => {
    assert.equal(process.env.LEADCONNECTOR_WEBHOOK, '');
    assert.equal(process.env.CLOCKISTRY_WEBHOOK_URL, '');
});
