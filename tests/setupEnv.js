// tests/setupEnv.js
// Required as the FIRST line of every test file, before any app module is required -
// db/pool.js reads process.env.DATABASE_URL once at module load time, so the override
// below must land before anything requires it (directly or transitively).
//
// IMPORTANT: app modules (index.js, controllers, services) call `require('dotenv').config()`
// themselves. dotenv only fills in keys that are NOT already own-properties of process.env
// (see node_modules/dotenv/lib/main.js `populate()`), so `delete`-ing a var here is unsafe -
// once deleted, a later dotenv.config() call re-populates it from the developer's real .env.
// Blanking to '' instead makes the key an own-property (with an empty value) that dotenv will
// never touch again. Every GHL_* var and every other external-service credential/webhook must
// be blanked this way so tests can never reach a real third-party API (this repo has shipped
// a bug that created 119 junk coupons in production GHL by doing exactly this wrong).
const dotenv = require('dotenv');
const { parsed: dotenvParsed } = dotenv.config();

process.env.NODE_ENV = 'test';

// Never run tests against the real dev/production database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    || 'postgres://pbackend:pbackend_dev_local@localhost:5432/pbackend_test';

// Fixed, known values so tests don't depend on whatever's in the real .env.
process.env.PAYMONGO_WEBHOOK_SECRET = 'test_webhook_secret_for_automated_tests';
process.env.ADMIN_API_KEY = 'test_admin_key_for_automated_tests';
process.env.AUTH_TOKEN_SECRET = 'test_auth_token_secret_for_automated_tests';

// Blank every GHL_* var this codebase reads (GHL_PRIVATE_KEY, GHL_LOCATION_ID,
// GHL_LOCATIONS_JSON, GHL_GLOBAL_LOCATION_ID, GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL,
// GHL_BUSINESS_NAME, GHL_INVOICE_SCHEDULE_LIVE_MODE, GHL_INVOICE_SCHEDULE_STRICT, ...) plus
// any GHL_* key that happens to exist in the developer's real .env, so a future env var
// can never slip through unblanked. Individual tests that need GHL behavior set their own
// values on top of this (see tests/ghlCoupons.test.js, tests/ghlOrderImport.test.js).
const ghlKeysFromEnvFile = Object.keys(dotenvParsed || {}).filter((key) => key.startsWith('GHL_'));
const knownGhlKeys = [
    'GHL_PRIVATE_KEY',
    'GHL_LOCATION_ID',
    'GHL_LOCATIONS_JSON',
    'GHL_LOCATION_IDS',
    'GHL_GLOBAL_LOCATION_ID',
    'GHL_LOCATION_ID_NEXISTRY_CORE_GLOBAL',
    'GHL_BUSINESS_NAME',
    'GHL_INVOICE_SCHEDULE_LIVE_MODE',
    'GHL_INVOICE_SCHEDULE_STRICT'
];
for (const key of new Set([...knownGhlKeys, ...ghlKeysFromEnvFile])) {
    process.env[key] = '';
}

// Other external-service credentials/webhooks that must never be hit from a test run.
process.env.LEADCONNECTOR_WEBHOOK = '';
process.env.CLOCKISTRY_WEBHOOK_URL = '';

// PAYMONGO_SECRET_KEY is intentionally left as-is: some success-path tests are
// conditionally skipped unless it's set (see hasPaymongoKey below), and when it is set
// those tests deliberately hit PayMongo's real *test-mode* API to create test-mode
// payment intents - that's the documented, opt-in behavior, not an accident.
module.exports = {
    hasPaymongoKey: Boolean(process.env.PAYMONGO_SECRET_KEY)
};
