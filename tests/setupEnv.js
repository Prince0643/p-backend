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
// Tests must never reach PayMongo: force fake live keys too (real ones from .env are overwritten).
process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake_live_slot_key_for_automated_tests';
process.env.PAYMONGO_PUBLIC_KEY = 'pk_test_fake_live_slot_key_for_automated_tests';

// Per-checkout PayMongo TEST mode: fixed fake test credentials (never real keys, never the network).
process.env.PAYMONGO_TEST_SECRET_KEY = 'sk_test_fake_key_for_automated_tests';
process.env.PAYMONGO_TEST_PUBLIC_KEY = 'pk_test_fake_key_for_automated_tests';
process.env.PAYMONGO_TEST_WEBHOOK_SECRET = 'test_mode_webhook_secret_for_automated_tests';
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
    'GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS',
    'GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS',
    'GHL_STUDENTS_COMPANY_ID',
    'GHL_STUDENT_USER_PRODUCTS',
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

// PayMongo never gets a real request from the test suite. The keys above are fake, and any axios
// call to api.paymongo.com is answered by an offline fake below (tests that need specific behavior
// still stub paymongoService methods directly). Set PAYMONGO_TESTS_ALLOW_NETWORK=true to opt out
// and use your own real keys (then also remove the forced keys above).
if (String(process.env.PAYMONGO_TESTS_ALLOW_NETWORK).toLowerCase() !== 'true') {
    const axios = require('axios');
    const realAdapter = axios.defaults.adapter;
    let counter = 0;
    const reply = (config, status, data) => {
        const response = { data, status, statusText: String(status), headers: { 'content-type': 'application/json' }, config, request: {} };
        if (status >= 400) {
            const err = new Error(`Request failed with status code ${status}`);
            err.response = response;
            err.config = config;
            return Promise.reject(err);
        }
        return Promise.resolve(response);
    };
    axios.defaults.adapter = (config) => {
        const target = `${config.baseURL || ''}${config.url || ''}`;
        if (!/paymongo\.com/i.test(target)) return realAdapter(config);
        const method = String(config.method || 'get').toLowerCase();
        const path = target.replace(/^https?:\/\/[^/]+\/v1/, '').split('?')[0];
        counter += 1;
        if (method === 'post' && path === '/payment_intents') {
            return reply(config, 200, { data: { id: `pi_fake_${counter}`, type: 'payment_intent', attributes: { client_secret: `cs_fake_${counter}`, status: 'awaiting_payment_method' } } });
        }
        if (method === 'post' && path === '/checkout_sessions') {
            return reply(config, 200, { data: { id: `cs_fake_${counter}`, type: 'checkout_session', attributes: { checkout_url: 'https://checkout.invalid/fake' } } });
        }
        if (method === 'get' && path.startsWith('/payment_intents/')) {
            return reply(config, 200, { data: { id: path.split('/').pop(), type: 'payment_intent', attributes: { status: 'awaiting_payment_method' } } });
        }
        if (method === 'get' && path.startsWith('/merchants/capabilities')) return reply(config, 200, { data: [] });
        return reply(config, 404, { errors: [{ code: 'not_mocked', detail: `tests/setupEnv.js has no fake for ${method.toUpperCase()} ${path}` }] });
    };
}

module.exports = {
    hasPaymongoKey: Boolean(process.env.PAYMONGO_SECRET_KEY)
};
