// tests/embed.test.js
// Public embed API (/api/embed/*), the shared pricing helper, frozen product ids, and the
// cross-origin serving of the widget script.
require('./setupEnv');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const paymongoService = require('../services/paymongoService');
const productCatalog = require('../utils/productCatalog');
const { resolveTaxRate } = require('../utils/pricing');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SUFFIX = Date.now().toString(36);
const ids = {
    zero: `embed_zero_${SUFFIX}`,
    legacy: `embed_legacy_${SUFFIX}`,
    recurring: `embed_recurring_${SUFFIX}`
};
const createdProductIds = new Set(Object.values(ids));

const email = () => `embed.${Math.random().toString(36).slice(2, 8)}@example.com`;
const checkoutBody = (overrides = {}) => ({
    productId: ids.legacy, fullName: 'Embed Tester', email: email(), mobile: '+639171234567', ...overrides
});

// PayMongo is stubbed: no test in this file may reach the network.
const realCreateIntent = paymongoService.createPaymentIntent;
let intentCalls = [];

before(async () => {
    paymongoService.createPaymentIntent = async (args) => {
        intentCalls.push(args);
        return { id: `pi_test_${intentCalls.length}`, attributes: { checkout_url: 'https://checkout.example/test', client_secret: 'cs_test' } };
    };
    await productCatalog.upsertProduct({ id: ids.zero, name: 'Embed Zero Tax', amountPhp: 1000, defaults: { taxRate: 0, displaySuffix: ' / once', successUrl: 'https://product.example.com/thanks' } });
    await productCatalog.upsertProduct({ id: ids.legacy, name: 'Embed Legacy Tax', amountPhp: 1000, defaults: { successUrl: 'https://product.example.com/thanks' } });
    await productCatalog.upsertProduct({ id: ids.recurring, name: 'Embed Recurring', amountPhp: 1000, billing: { type: 'recurring', interval: 'monthly' }, defaults: { taxRate: 0.12 } });
});

after(async () => {
    paymongoService.createPaymentIntent = realCreateIntent;
    for (const id of createdProductIds) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE product_id = $1', [id]).catch(() => {});
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
    }
    await pool.end();
});

test('resolveTaxRate: core source override on top, then product rate (including 0), then legacy logic', () => {
    const core = Number(process.env.NX_CORE_TAX_RATE ?? 0.12);
    assert.equal(resolveTaxRate({ product: { id: 'x', defaults: { taxRate: 0 } }, source: 'nexistry_core_ph' }), core);
    assert.equal(resolveTaxRate({ product: { id: 'x', defaults: { taxRate: 0 } }, source: 'other' }), 0);
    assert.equal(resolveTaxRate({ product: { id: 'promo_website_monthly', defaults: { taxRate: 0.05 } }, source: 'other' }), 0.05);
    assert.equal(resolveTaxRate({ product: { id: 'x', defaults: { taxRate: 0.05 } } }), 0.05);
    const legacy = Number(process.env.TAX_RATE ?? 0.10);
    assert.equal(resolveTaxRate({ product: { id: 'x', defaults: {} }, source: 'other' }), legacy);
    assert.equal(resolveTaxRate({ product: { id: 'x', defaults: {} }, source: 'nexistry_core_ph' }), core);
    assert.equal(resolveTaxRate({ product: { id: 'promo_website_monthly', defaults: {} }, source: 'other' }), core);
});

test('GET /api/embed/products/:id returns only the public fields; unknown id is 404', async () => {
    const res = await request(app).get(`/api/embed/products/${ids.zero}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        product: {
            id: ids.zero, name: 'Embed Zero Tax', currency: 'PHP', amountPhp: 1000, taxRate: 0,
            billing: { type: 'one_time', interval: null }, displaySuffix: ' / once'
        }
    });
    const missing = await request(app).get('/api/embed/products/nope_nope');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Product not found' });
    // by id only - the name must not resolve
    const byName = await request(app).get('/api/embed/products/Embed%20Zero%20Tax');
    assert.equal(byName.status, 404);
});

test('quote: taxRate 0 means no tax; null taxRate uses the legacy env rate', async () => {
    const zero = await request(app).post('/api/embed/quote').send({ productId: ids.zero });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    assert.equal(zero.body.taxRate, 0);
    assert.equal(zero.body.taxAmount, 0);
    assert.equal(zero.body.total, 1000);
    assert.equal(zero.body.promo, null);
    assert.equal(zero.body.renewal, null);

    const legacyRate = Number(process.env.TAX_RATE ?? 0.10);
    const legacy = await request(app).post('/api/embed/quote').send({ productId: ids.legacy });
    assert.equal(legacy.body.taxRate, legacyRate);
    assert.equal(legacy.body.taxAmount, Number((1000 * legacyRate).toFixed(2)));
    assert.equal(legacy.body.total, Number((1000 + 1000 * legacyRate).toFixed(2)));
});

test('quote: 400 without productId, 404 for unknown product', async () => {
    assert.equal((await request(app).post('/api/embed/quote').send({})).status, 400);
    assert.equal((await request(app).post('/api/embed/quote').send({ productId: 'nope_nope' })).status, 404);
});

test('quote: recurring renewal is the full taxed price, no discount', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.20 });
    try {
        const res = await request(app).post('/api/embed/quote').send({ productId: ids.recurring, promoCode: code, email: email() });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.billing.type, 'recurring');
        assert.equal(res.body.discountAmount, 200);
        assert.equal(res.body.total, 896); // (1000 - 200) * 1.12
        assert.deepEqual(res.body.renewal, { amount: 1120, interval: 'monthly' });
        assert.equal(res.body.promo.applied, true);
    } finally {
        await cleanupCoupon(code);
    }
});

test('quote equals what checkout charges for the same product/coupon', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.15 });
    const buyer = email();
    try {
        const quote = await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: code, email: buyer });
        intentCalls = [];
        const co = await request(app).post('/api/embed/checkout').send(checkoutBody({ email: buyer, promoCode: code }));
        assert.equal(co.status, 200, JSON.stringify(co.body));
        assert.equal(co.body.amount, quote.body.total);
        assert.equal(co.body.taxAmount, quote.body.taxAmount);
        assert.equal(co.body.discountAmount, quote.body.discountAmount);
        assert.equal(co.body.taxRate, quote.body.taxRate);
        assert.equal(co.body.checkoutUrl, 'https://checkout.example/test');
        assert.equal(intentCalls[0].amount, quote.body.total);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
        await cleanupCoupon(code);
    }
});

test('quote: bad promo is 200 applied:false; nothing is reserved', async () => {
    const bad = await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: 'NOSUCHCODE' });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.promo.applied, false);
    assert.equal(bad.body.promo.code, 'NOSUCHCODE');
    assert.ok(bad.body.promo.message);
    assert.equal(bad.body.discountAmount, 0);

    const expired = await createTestCoupon({ type: 'general', expiresAt: new Date(Date.now() - 86400000).toISOString() });
    const scoped = await createTestCoupon({ type: 'general', productIds: ['test_product'] });
    const limited = await createTestCoupon({ type: 'general', maxRedemptions: 5 });
    const buyer = email();
    try {
        assert.equal((await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: expired })).body.promo.applied, false);
        assert.equal((await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: scoped })).body.promo.applied, false);

        // already-used-by-this-email only when an email is provided
        await pool.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, email, base_amount, discount_amount, currency, status)
             VALUES ($1, $2, $3, $4, 100, 10, 'PHP', 'paid')`,
            [`RDMEMB${SUFFIX}`, limited, `PAYEMB${SUFFIX}`, buyer]
        );
        const used = await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: limited, email: buyer });
        assert.equal(used.body.promo.applied, false);
        assert.equal(used.body.promo.message, 'You have already used this coupon.');
        const noEmail = await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: limited });
        assert.equal(noEmail.body.promo.applied, true);

        const before = (await pool.query('SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE code = $1', [limited])).rows[0].n;
        await request(app).post('/api/embed/quote').send({ productId: ids.legacy, promoCode: limited, email: email() });
        const after_ = (await pool.query('SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE code = $1', [limited])).rows[0].n;
        assert.equal(after_, before, 'quote must not create redemption rows');
    } finally {
        for (const c of [expired, scoped, limited]) {
            await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [c]);
            await cleanupCoupon(c);
        }
    }
});

test('checkout ignores client successUrl/cancelUrl/source/amount', async () => {
    intentCalls = [];
    const res = await request(app).post('/api/embed/checkout').send(checkoutBody({
        successUrl: 'https://evil.example.com/steal', cancelUrl: 'https://evil.example.com/cancel',
        source: 'nexistry_core_ph', amount: 1, paymentMethod: 'qrph'
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(intentCalls[0].successUrl, 'https://product.example.com/thanks');
    assert.notEqual(intentCalls[0].cancelUrl, 'https://evil.example.com/cancel');
    assert.equal(intentCalls[0].metadata.source, ids.legacy);
    assert.equal(res.body.taxRate, Number(process.env.TAX_RATE ?? 0.10));
    assert.equal(res.body.baseAmount, 1000);
});

test('checkout takes source from the product, never the client (no core-source tax override)', async () => {
    intentCalls = [];
    const res = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: ids.zero, source: 'nexistry_core_ph' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.taxRate, 0);
    assert.equal(intentCalls[0].metadata.source, ids.zero);
});

test('checkout errors use create-payment-intent shape', async () => {
    const missing = await request(app).post('/api/embed/checkout').send({ productId: ids.legacy });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'Missing required fields');
    const unknown = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: 'nope_nope' }));
    assert.equal(unknown.status, 400);
});

test('/api/embed allows any origin (even in production) while other /api routes still reject it', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
        const origin = 'https://some-ghl-funnel.example.org';
        const pre = await request(app).options('/api/embed/quote')
            .set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
        assert.equal(pre.status, 204);
        assert.equal(pre.headers['access-control-allow-origin'], '*');
        assert.equal(pre.headers['access-control-allow-credentials'], undefined);

        const res = await request(app).post('/api/embed/quote').set('Origin', origin).send({ productId: ids.zero });
        assert.equal(res.status, 200);
        assert.equal(res.headers['access-control-allow-origin'], '*');

        const other = await request(app).get('/api/payments/status/whatever').set('Origin', origin);
        assert.notEqual(other.headers['access-control-allow-origin'], origin);
        assert.notEqual(other.headers['access-control-allow-origin'], '*');
    } finally {
        process.env.NODE_ENV = prev;
    }
});

test('PUT keeps the product id when the name changes; 404 for unknown id; POST duplicate is 409', async () => {
    const id = `embed_frozen_${SUFFIX}`;
    createdProductIds.add(id);
    const created = await request(app).post('/api/admin/products').set('x-api-key', ADMIN_KEY)
        .send({ name: `Frozen ${SUFFIX}`, id, amountPhp: 500 });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const renamed = await request(app).put(`/api/admin/products/${id}`).set('x-api-key', ADMIN_KEY)
        .send({ name: 'Totally New Name', amountPhp: 600 });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.product.id, id);
    assert.equal(renamed.body.product.name, 'Totally New Name');
    assert.equal(renamed.body.product.amountPhp, 600);
    const { rows } = await pool.query('SELECT id FROM products WHERE name = $1', ['Totally New Name']);
    assert.deepEqual(rows.map((r) => r.id), [id]);

    const missing = await request(app).put('/api/admin/products/embed_missing_zzz').set('x-api-key', ADMIN_KEY)
        .send({ name: 'Ghost', amountPhp: 1 });
    assert.equal(missing.status, 404);
    assert.equal((await pool.query('SELECT 1 FROM products WHERE id = $1', ['ghost'])).rowCount, 0);

    const dup = await request(app).post('/api/admin/products').set('x-api-key', ADMIN_KEY)
        .send({ name: 'Another', id, amountPhp: 500 });
    assert.equal(dup.status, 409);

    // slugged from the name when no id is given
    const slugName = `Slug Me ${SUFFIX}`;
    const slugged = await request(app).post('/api/admin/products').set('x-api-key', ADMIN_KEY).send({ name: slugName, amountPhp: 10 });
    assert.equal(slugged.status, 200);
    createdProductIds.add(slugged.body.product.id);
    assert.equal(slugged.body.product.id, productCatalog.toSlugId(slugName));

    // legacy snippet endpoint still works
    const snippet = await request(app).get(`/api/admin/products/${id}/snippet`).set('x-api-key', ADMIN_KEY);
    assert.equal(snippet.status, 200);
    assert.ok(snippet.body.snippet);
});

test('GET /public/nx-embed.js is served cross-origin with a JS content type', async () => {
    const res = await request(app).get('/public/nx-embed.js');
    // 200 once the widget file exists; the headers are set either way
    assert.ok([200, 404].includes(res.status), `unexpected status ${res.status}`);
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(res.headers['content-type'], /application\/javascript/);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
});
