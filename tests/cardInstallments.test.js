// Card installments: pure decision helper + checkout session payload/fallback behavior.
// PayMongo is never contacted; the service's axios client `post` is stubbed.
require('./setupEnv');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getCardInstallmentOptions } = require('../utils/cardInstallments');
const paymongoService = require('../services/paymongoService');

const ENV_KEYS = ['PAYMONGO_CARD_INSTALLMENTS_ENABLED', 'PAYMONGO_INSTALLMENTS_MIN_AMOUNT'];
const saved = {};
const originalLog = console.log;

beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    console.log = () => {};
});
afterEach(() => {
    console.log = originalLog;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const OPTS = { card: { installments: { enabled: true } } };

test('helper: flag off -> null', () => {
    assert.equal(getCardInstallmentOptions({ paymentMethodTypes: ['card'], amountPhp: 5000, currency: 'PHP' }), null);
});

test('helper: enabled + card + >= min + PHP -> options', () => {
    process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
    assert.deepEqual(getCardInstallmentOptions({ paymentMethodTypes: ['gcash', 'card'], amountPhp: 3000, currency: 'php' }), OPTS);
});

test('helper: below min, no card, or non-PHP -> null; custom min honored', () => {
    process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
    assert.equal(getCardInstallmentOptions({ paymentMethodTypes: ['card'], amountPhp: 2999.99, currency: 'PHP' }), null);
    assert.equal(getCardInstallmentOptions({ paymentMethodTypes: ['gcash'], amountPhp: 9000, currency: 'PHP' }), null);
    assert.equal(getCardInstallmentOptions({ paymentMethodTypes: ['card'], amountPhp: 9000, currency: 'USD' }), null);
    process.env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT = '5000';
    assert.equal(getCardInstallmentOptions({ paymentMethodTypes: ['card'], amountPhp: 4000, currency: 'PHP' }), null);
    assert.deepEqual(getCardInstallmentOptions({ paymentMethodTypes: ['card'], amountPhp: 5000, currency: 'PHP' }), OPTS);
});

// Runs createPaymentIntent with a stubbed session POST. `sessionBehavior(payload, n)` may throw.
async function run({ amount = 3500, types = ['card', 'gcash'], sessionBehavior }) {
    const svc = paymongoService.forMode('live');
    const origPost = svc.client.post;
    const sessions = [];
    svc.client.post = async (url, payload) => {
        if (url === '/payment_intents') return { data: { data: { id: 'pi_x', type: 'payment_intent', attributes: {} } } };
        if (url === '/checkout_sessions') {
            sessions.push(payload.data.attributes);
            if (sessionBehavior) sessionBehavior(payload.data.attributes, sessions.length);
            return { data: { data: { id: 'cs_x', attributes: { checkout_url: 'https://checkout.invalid/x' } } } };
        }
        throw new Error(`unexpected ${url}`);
    };
    try {
        const result = await svc.createPaymentIntent({ amount, currency: 'php', description: 'd', paymentMethodTypes: types, paymentMethodAllowed: ['card'], metadata: {} });
        return { result, sessions };
    } finally { svc.client.post = origPost; }
}

const rejection = () => Object.assign(new Error('400'), { response: { status: 400, data: { errors: [{ code: 'parameter_invalid', detail: 'payment_method_options not allowed' }] } } });

test('session: flag off -> no payment_method_options', async () => {
    const { sessions } = await run({});
    assert.equal(sessions.length, 1);
    assert.equal('payment_method_options' in sessions[0], false);
});

test('session: flag on + card + >= min -> options present', async () => {
    process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
    const { sessions, result } = await run({});
    assert.deepEqual(sessions[0].payment_method_options, OPTS);
    assert.equal(result.attributes.checkout_session_id, 'cs_x');
});

test('session: below min or card absent -> options absent', async () => {
    process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
    assert.equal('payment_method_options' in (await run({ amount: 2999 })).sessions[0], false);
    assert.equal('payment_method_options' in (await run({ types: ['gcash'] })).sessions[0], false);
});

test('session: rejection with installments -> retries once without options and succeeds', async () => {
    process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
    const { sessions, result } = await run({ sessionBehavior: (attrs) => { if (attrs.payment_method_options) throw rejection(); } });
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].payment_method_options);
    assert.equal('payment_method_options' in sessions[1], false);
    assert.equal(result.attributes.checkout_url, 'https://checkout.invalid/x');
});

test('session: unrelated failure without installments is not retried', async () => {
    await assert.rejects(run({ sessionBehavior: () => { throw rejection(); } }));
});

test('session: brankas retry still works (with and without installments)', async () => {
    for (const flag of [undefined, 'true']) {
        if (flag) process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = flag;
        const { sessions, result } = await run({
            types: ['card', 'brankas_bdo'],
            sessionBehavior: (attrs) => { if (attrs.payment_method_types.some((t) => t.startsWith('brankas_'))) throw rejection(); }
        });
        const last = sessions[sessions.length - 1];
        assert.deepEqual(last.payment_method_types, ['card']);
        assert.equal(Boolean(last.payment_method_options), Boolean(flag));
        assert.equal(result.attributes.checkout_session_id, 'cs_x');
    }
});

test('getCardInstallmentPlans: [] below min and on error; lists plans otherwise', async () => {
    const svc = paymongoService.forMode('live');
    const origGet = svc.client.get;
    try {
        let called = 0;
        svc.client.get = async (url, cfg) => { called++; assert.equal(url, '/card_installment_plans'); assert.equal(cfg.params.amount, 350000); return { data: { data: [{ id: 'p1' }] } }; };
        assert.deepEqual(await svc.getCardInstallmentPlans(2000), []);
        assert.equal(called, 0);
        assert.deepEqual(await svc.getCardInstallmentPlans(3500), [{ id: 'p1' }]);
        svc.client.get = async () => { throw new Error('boom'); };
        assert.deepEqual(await svc.getCardInstallmentPlans(3500), []);
    } finally { svc.client.get = origGet; }
});
