// Per-checkout PayMongo TEST mode: admin token -> test keys, persisted mode, webhook mode
// isolation, TEST bookkeeping. PayMongo, GHL and LeadConnector are all stubbed - nothing here
// reaches the network.
require('./setupEnv');
const { test, after, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const paymongoService = require('../services/paymongoService');
const webhookService = require('../services/webhookService');
const ghlService = require('../services/ghlService');
const productCatalog = require('../utils/productCatalog');
const couponStore = require('../utils/couponStore');
const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const { issueToken } = require('../utils/authToken');
const { createTestCoupon, cleanupCoupon, signWebhookBody, paymentEventPayload } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SUFFIX = Date.now().toString(36);
const PRODUCT_ID = `tm_product_${SUFFIX}`;
const STUDENT_PRODUCT_ID = 'ghl_practice_access';

const liveService = paymongoService.forMode('live');
const testService = paymongoService.forMode('test');
const originals = {
    liveCreate: liveService.createPaymentIntent, testCreate: testService.createPaymentIntent,
    liveGet: liveService.getPaymentIntent, testGet: testService.getPaymentIntent,
    send: webhookService.sendToLeadConnector,
    upsertContact: ghlService.upsertContact, createInvoice: ghlService.createInvoice,
    recordInvoicePayment: ghlService.recordInvoicePayment, createClient: ghlService.createClient
};
const originalLog = console.log;
const envKeys = ['PAYMONGO_TEST_SECRET_KEY', 'PAYMONGO_TEST_PUBLIC_KEY', 'GHL_PRIVATE_KEY', 'GHL_LOCATION_ID',
    'GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS', 'GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS'];
const savedEnv = {};

let calls; // { live: [], test: [], liveGet: [], testGet: [], sent: [], ghl: [] , users: [] }
const refsToClean = [];
const couponsToClean = [];

before(async () => {
    await productCatalog.upsertProduct({ id: PRODUCT_ID, name: 'TM Product', amountPhp: 1000, defaults: { taxRate: 0, successUrl: 'https://product.example.com/thanks' } });
});

beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    calls = { live: [], test: [], liveGet: [], testGet: [], sent: [], ghl: [], users: [] };
    let n = 0;
    liveService.createPaymentIntent = async (args) => { calls.live.push(args); return { id: `pi_live_${SUFFIX}_${++n}`, attributes: { checkout_url: 'https://checkout.example/live', client_secret: 'cs' } }; };
    testService.createPaymentIntent = async (args) => { calls.test.push(args); return { id: `pi_test_${SUFFIX}_${++n}`, attributes: { checkout_url: 'https://checkout.example/test', client_secret: 'cs' } }; };
    liveService.getPaymentIntent = async (id) => { calls.liveGet.push(id); return { id, attributes: { status: 'awaiting_payment_method' } }; };
    testService.getPaymentIntent = async (id) => { calls.testGet.push(id); return { id, attributes: { status: 'succeeded' } }; };
    webhookService.sendToLeadConnector = async (data) => { calls.sent.push(data); };
    ghlService.upsertContact = async (a) => { calls.ghl.push(['upsertContact', a]); return { contact: { id: 'c1' } }; };
    ghlService.createInvoice = async (a) => { calls.ghl.push(['createInvoice', a]); return { _id: 'inv1' }; };
    ghlService.recordInvoicePayment = async (a) => { calls.ghl.push(['recordInvoicePayment', a]); return { id: 't1' }; };
    console.log = () => {};
});

afterEach(async () => {
    console.log = originalLog;
    for (const k of envKeys) process.env[k] = savedEnv[k];
    liveService.createPaymentIntent = originals.liveCreate; testService.createPaymentIntent = originals.testCreate;
    liveService.getPaymentIntent = originals.liveGet; testService.getPaymentIntent = originals.testGet;
    webhookService.sendToLeadConnector = originals.send;
    ghlService.upsertContact = originals.upsertContact; ghlService.createInvoice = originals.createInvoice;
    ghlService.recordInvoicePayment = originals.recordInvoicePayment; ghlService.createClient = originals.createClient;
    const refs = refsToClean.splice(0);
    if (refs.length) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE transaction_id = ANY($1)', [refs]);
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = ANY($1)', [refs]);
        await pool.query('DELETE FROM ghl_student_users WHERE payment_reference = ANY($1)', [refs]);
    }
    for (const code of couponsToClean.splice(0)) await cleanupCoupon(code);
});

after(async () => {
    await pool.query('DELETE FROM digital_solutions_transactions WHERE product_id = $1', [PRODUCT_ID]);
    await pool.query('DELETE FROM products WHERE id = $1', [PRODUCT_ID]);
    await pool.end();
});

const email = () => `tm.${Math.random().toString(36).slice(2, 8)}@example.com`;
const body = (o = {}) => ({ productId: PRODUCT_ID, fullName: 'Test Mode', email: email(), mobile: '+639171234567', ...o });
const mintToken = async () => (await request(app).post('/api/admin/test-checkout-token').set('x-api-key', ADMIN_KEY)).body.token;
const txRow = async (ref) => (await pool.query('SELECT * FROM digital_solutions_transactions WHERE transaction_id = $1', [ref])).rows[0];

/** Creates a checkout through the API and tracks its reference for cleanup. */
async function checkout(o = {}, { token, via = 'body' } = {}) {
    let req = request(app).post('/api/payments/create-payment-intent');
    const payload = body(o);
    if (token && via === 'body') payload.testToken = token;
    if (token && via === 'header') req = req.set('x-nx-test-token', token);
    const res = await req.send(payload);
    if (res.body.paymentReference) refsToClean.push(res.body.paymentReference);
    return res;
}

async function webhook(payload, mode = 'live', opts = {}) {
    const { body: raw, header } = signWebhookBody(payload, { mode, ...opts });
    return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(raw);
}

const paidEvent = (metadata, livemode) => paymentEventPayload('payment.paid', metadata, { livemode });

test('no token: live key path, record is not a test, response has no testMode', async () => {
    const res = await checkout();
    assert.equal(res.status, 200);
    assert.equal(calls.live.length, 1);
    assert.equal(calls.test.length, 0);
    assert.equal(res.body.testMode, undefined);
    const row = await txRow(res.body.paymentReference);
    assert.equal(row.is_test, false);
    assert.equal(row.paymongo_payment_intent_id, res.body.paymentIntentId);
    assert.equal(calls.sent[0].isTest, undefined);
});

test('admin endpoint requires admin auth and returns a ~2h token', async () => {
    assert.equal((await request(app).post('/api/admin/test-checkout-token')).status, 401);
    const res = await request(app).post('/api/admin/test-checkout-token').set('x-api-key', ADMIN_KEY);
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'test');
    const ms = new Date(res.body.expiresAt).getTime() - Date.now();
    assert.ok(ms > 119 * 60 * 1000 && ms <= 120 * 60 * 1000, `expiry ~2h, got ${ms}`);
});

test('valid token (body or header): test key used, records are is_test, LeadConnector carries isTest', async () => {
    const token = await mintToken();
    for (const via of ['body', 'header']) {
        calls.live.length = 0; calls.test.length = 0; calls.sent.length = 0;
        const res = await checkout({}, { token, via });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(calls.test.length, 1);
        assert.equal(calls.live.length, 0);
        assert.equal(res.body.testMode, true);
        const row = await txRow(res.body.paymentReference);
        assert.equal(row.is_test, true);
        assert.equal(calls.sent[0].isTest, true);
        assert.equal(calls.sent[0].livemode, false);
    }
});

test('embed checkout accepts the token too, and forwards a bad one as 403', async () => {
    const token = await mintToken();
    const ok = await request(app).post('/api/embed/checkout').send(body({ testToken: token }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    refsToClean.push(ok.body.paymentReference);
    assert.equal(calls.test.length, 1);
    assert.equal((await txRow(ok.body.paymentReference)).is_test, true);

    const bad = await request(app).post('/api/embed/checkout').send(body({ testToken: 'garbage.token' }));
    assert.equal(bad.status, 403);
    assert.equal(calls.live.length, 0);
});

test('invalid, expired, wrong-type and tampered tokens are 403 and create nothing', async () => {
    const good = await mintToken();
    const expired = issueToken({ type: 'checkout_test', adminId: null, email: 'x' }, { ttlMs: -1000 });
    const adminSession = issueToken({ type: 'admin', id: 'whatever', email: 'a@b.c' });
    const tampered = `${good.split('.')[0]}.${'A'.repeat(43)}`;
    for (const token of ['nope', expired, adminSession, tampered]) {
        const res = await checkout({}, { token });
        assert.equal(res.status, 403, `token ${token.slice(0, 12)}`);
    }
    assert.equal(calls.live.length + calls.test.length, 0);
});

test('missing test env: 503 error, never falls back to live', async () => {
    const token = await mintToken();
    process.env.PAYMONGO_TEST_SECRET_KEY = '';
    const res = await checkout({}, { token });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /test mode/i);
    assert.equal(calls.live.length + calls.test.length, 0);
    const mint = await request(app).post('/api/admin/test-checkout-token').set('x-api-key', ADMIN_KEY);
    assert.equal(mint.status, 503);
    // a live key in the test var is refused as well
    process.env.PAYMONGO_TEST_SECRET_KEY = 'sk_live_definitely_not_a_test_key';
    assert.equal((await checkout({}, { token })).status, 503);
    assert.equal(calls.live.length, 0);
});

test('clockistry refuses a test token instead of going live', async () => {
    const res = await request(app).post('/api/clockistry/create-payment-intent').send({ companyId: 'c', plan: 'office', testToken: 'x' });
    assert.equal(res.status, 400);
});

test('test webhook (te + test secret): marks paid as TEST, no GHL invoice, LeadConnector isTest', async () => {
    process.env.GHL_PRIVATE_KEY = 'pit_fake'; process.env.GHL_LOCATION_ID = 'loc_fake';
    const token = await mintToken();
    const res = await checkout({}, { token });
    calls.sent.length = 0;
    const metadata = { paymentReference: res.body.paymentReference, email: 'a@example.com', fullName: 'A B', mobile: '+639171234567', product: 'TM Product', productId: PRODUCT_ID };
    const hook = await webhook(paidEvent(metadata, false), 'test');
    assert.equal(hook.status, 200);
    const row = await txRow(res.body.paymentReference);
    assert.equal(row.status, 'paid');
    assert.equal(row.is_test, true);
    assert.deepEqual(calls.ghl, [], 'no GHL contact/invoice calls for a test payment');
    const paid = calls.sent.find((d) => d.status === 'payment_successful');
    assert.equal(paid.isTest, true);
    assert.equal(paid.livemode, false);
});

test('live control: a live payment still mirrors to GHL and has no isTest flag', async () => {
    process.env.GHL_PRIVATE_KEY = 'pit_fake'; process.env.GHL_LOCATION_ID = 'loc_fake';
    const res = await checkout();
    calls.sent.length = 0;
    const metadata = { paymentReference: res.body.paymentReference, email: 'a@example.com', fullName: 'A B', mobile: '+639171234567', product: 'TM Product', productId: PRODUCT_ID };
    assert.equal((await webhook(paidEvent(metadata, true), 'live')).status, 200);
    assert.equal((await txRow(res.body.paymentReference)).status, 'paid');
    assert.ok(calls.ghl.some(([name]) => name === 'createInvoice'));
    assert.equal(calls.sent.find((d) => d.status === 'payment_successful').isTest, undefined);
});

test('a live signature cannot touch a test record, and a test signature cannot touch a live record', async () => {
    const token = await mintToken();
    const testRes = await checkout({}, { token });
    const liveRes = await checkout();
    const meta = (r) => ({ paymentReference: r.body.paymentReference, email: 'a@example.com', fullName: 'A B', productId: PRODUCT_ID });

    assert.equal((await webhook(paidEvent(meta(testRes), true), 'live')).status, 200);
    assert.equal((await txRow(testRes.body.paymentReference)).status, 'initiated');

    assert.equal((await webhook(paidEvent(meta(liveRes), false), 'test')).status, 200);
    assert.equal((await txRow(liveRes.body.paymentReference)).status, 'initiated');

    // unknown reference in test mode is ignored too
    assert.equal((await webhook(paidEvent({ paymentReference: 'PAY_NOPE' }, false), 'test')).status, 200);
    assert.equal(await txRow('PAY_NOPE'), undefined);
});

test('signature mode must match payload livemode and use the matching secret', async () => {
    const payloadLive = paidEvent({ paymentReference: 'x' }, true);
    const payloadTest = paidEvent({ paymentReference: 'x' }, false);
    // live signature, payload says test -> 400
    assert.equal((await webhook(payloadTest, 'live')).status, 400);
    // test signature, payload says live -> 400
    assert.equal((await webhook(payloadLive, 'test')).status, 400);
    // te populated but signed with the live secret -> 401
    assert.equal((await webhook(payloadTest, 'test', { secret: process.env.PAYMONGO_WEBHOOK_SECRET })).status, 401);
    // li slot signed with the test secret -> 401
    const { body: raw } = signWebhookBody(payloadLive, { mode: 'live', secret: process.env.PAYMONGO_TEST_WEBHOOK_SECRET });
    const ts = Math.floor(Date.now() / 1000);
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', process.env.PAYMONGO_TEST_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
    const res = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json')
        .set('Paymongo-Signature', `t=${ts},te=,li=${sig}`).send(raw);
    assert.equal(res.status, 401);
    // payload without livemode: mode comes from the verified signature (no rejection)
    const noMode = paidEvent({ paymentReference: 'x' }, true);
    delete noMode.data.attributes.livemode;
    assert.equal((await webhook(noMode, 'live')).status, 200);
    assert.equal((await webhook(noMode, 'test')).status, 200);
    // non-boolean livemode behaves the same
    noMode.data.attributes.livemode = 'true';
    assert.equal((await webhook(noMode, 'live')).status, 200);
    // test webhook secret missing -> te events rejected
    const saved = process.env.PAYMONGO_TEST_WEBHOOK_SECRET;
    process.env.PAYMONGO_TEST_WEBHOOK_SECRET = '';
    try {
        const { body: r2, header } = signWebhookBody(payloadTest, { mode: 'test', secret: saved });
        const res2 = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(r2);
        assert.equal(res2.status, 401);
    } finally {
        process.env.PAYMONGO_TEST_WEBHOOK_SECRET = saved;
    }
});

test('test coupon reservation: is_test row, live limit untouched, live hold preserved', async () => {
    const code = await createTestCoupon({ maxRedemptions: 1 });
    couponsToClean.push(code);
    const token = await mintToken();
    const shared = email();

    // Test checkout reserves + pays the single-use coupon in test mode.
    const t = await checkout({ promoCode: code, email: shared }, { token });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    refsToClean.push(t.body.paymentReference);
    let red = await couponStore.findRedemptionByPaymentReference(t.body.paymentReference);
    assert.equal(red.isTest, true);
    assert.equal(red.status, 'pending');
    const meta = { paymentReference: t.body.paymentReference, promoCode: code, email: shared, fullName: 'T', productId: PRODUCT_ID, baseAmount: '850', discountAmount: '150' };
    assert.equal((await webhook(paidEvent(meta, false), 'test')).status, 200);
    red = await couponStore.findRedemptionByPaymentReference(t.body.paymentReference);
    assert.equal(red.status, 'paid');
    assert.equal(red.isTest, true);

    // The live limit (1) is still free: a live checkout with the same email + coupon succeeds.
    const live = await checkout({ promoCode: code, email: shared });
    assert.equal(live.status, 200, JSON.stringify(live.body));
    const liveRed = await couponStore.findRedemptionByPaymentReference(live.body.paymentReference);
    assert.equal(liveRed.isTest, false);
    assert.equal(liveRed.status, 'pending');

    // A further test checkout (same email) must not release that live pending hold.
    const t2 = await checkout({ promoCode: code, email: shared }, { token });
    assert.equal(t2.status, 200, JSON.stringify(t2.body));
    const stillPending = await couponStore.findRedemptionByPaymentReference(live.body.paymentReference);
    assert.equal(stillPending.status, 'pending');

    // A test webhook cannot pay the live reservation.
    const liveMeta = { paymentReference: live.body.paymentReference, promoCode: code, email: shared, productId: PRODUCT_ID };
    await webhook(paidEvent(liveMeta, false), 'test');
    assert.equal((await couponStore.findRedemptionByPaymentReference(live.body.paymentReference)).status, 'pending');
});

test('GHL student user is created for a test payment and recorded with is_test', async () => {
    process.env.GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS = 'loc_students';
    process.env.GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS = 'pit_students';
    ghlService.createClient = () => ({
        get: async () => ({ data: { users: [] } }),
        post: async (url, b) => { calls.users.push({ url, b }); return { data: { id: 'ghluser_1', email: b.email } }; }
    });
    await productCatalog.upsertProduct({ id: STUDENT_PRODUCT_ID, name: 'GHL Practice Access', amountPhp: 500, defaults: { taxRate: 0 } }).catch(() => {});
    const token = await mintToken();
    const res = await checkout({ productId: STUDENT_PRODUCT_ID }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    calls.sent.length = 0;
    const meta = { paymentReference: res.body.paymentReference, email: 'student@example.com', fullName: 'Stu Dent', productId: STUDENT_PRODUCT_ID, product: 'GHL Practice Access' };
    assert.equal((await webhook(paidEvent(meta, false), 'test')).status, 200);
    assert.equal(calls.users.length, 1, 'user is still created in test mode');
    const { rows } = await pool.query('SELECT * FROM ghl_student_users WHERE payment_reference = $1', [res.body.paymentReference]);
    assert.equal(rows[0].is_test, true);
    assert.equal(rows[0].status, 'created');
    const paid = calls.sent.find((d) => d.status === 'payment_successful');
    assert.equal(paid.isTest, true);
    assert.equal(paid.ghlStudentAccount.status, 'created');
});

test('status polling uses the stored mode', async () => {
    const token = await mintToken();
    const t = await checkout({}, { token });
    const l = await checkout();

    const rt = await request(app).get(`/api/payments/status/${t.body.paymentIntentId}`);
    assert.equal(rt.status, 200);
    assert.equal(rt.body.paid, true);
    assert.equal(rt.body.testMode, true);
    assert.deepEqual(calls.testGet, [t.body.paymentIntentId]);
    assert.equal(calls.liveGet.length, 0);

    const rl = await request(app).get(`/api/payments/status/${l.body.paymentIntentId}`);
    assert.equal(rl.status, 200);
    assert.deepEqual(calls.liveGet, [l.body.paymentIntentId]);

    // a client-supplied token does not change the stored mode of a live intent
    await request(app).get(`/api/payments/status/${l.body.paymentIntentId}`).set('x-nx-test-token', token);
    assert.equal(calls.testGet.length, 1);

    // stored test mode + missing test env = error, not live
    process.env.PAYMONGO_TEST_SECRET_KEY = '';
    const gone = await request(app).get(`/api/payments/status/${t.body.paymentIntentId}`);
    assert.equal(gone.status, 503);
    assert.equal(calls.liveGet.length, 2, 'live client not used for the stored-test intent');

    // unknown intent stays live, as before
    process.env.PAYMONGO_TEST_SECRET_KEY = savedEnv.PAYMONGO_TEST_SECRET_KEY;
    await request(app).get('/api/payments/status/pi_unknown');
    assert.equal(calls.liveGet.length, 3);
});

test('digitalSolutionsStore.updateTransactionStatus respects the mode filter', async () => {
    const ref = `PAYTM${SUFFIX}`;
    refsToClean.push(ref);
    await digitalSolutionsStore.recordTransaction({ type: 'academy_product', transactionId: ref, amount: 1, isTest: true });
    assert.equal(await digitalSolutionsStore.updateTransactionStatus(ref, 'paid', { isTest: false }), null);
    assert.equal((await digitalSolutionsStore.updateTransactionStatus(ref, 'paid', { isTest: true })).status, 'paid');
});
