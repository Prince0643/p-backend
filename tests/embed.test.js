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
const legalLinks = require('../utils/legalLinks');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SUFFIX = Date.now().toString(36);
const ids = {
    zero: `embed_zero_${SUFFIX}`,
    legacy: `embed_legacy_${SUFFIX}`,
    recurring: `embed_recurring_${SUFFIX}`,
    legalBoth: `embed_legal_both_${SUFFIX}`,
    legalTerms: `embed_legal_terms_${SUFFIX}`
};
const createdProductIds = new Set(Object.values(ids));

const email = () => `embed.${Math.random().toString(36).slice(2, 8)}@example.com`;
const checkoutBody = (overrides = {}) => ({
    productId: ids.legacy, fullName: 'Embed Tester', email: email(), mobile: '+639171234567', ...overrides
});

// PayMongo is stubbed: no test in this file may reach the network.
const realCreateIntent = paymongoService.createPaymentIntent;
let intentCalls = [];
// Global legal links as found in the DB; restored after the suite.
let savedGlobalLinks = { termsUrl: null, privacyUrl: null };

before(async () => {
    savedGlobalLinks = await legalLinks.getGlobalLegalLinks();
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
    await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
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
            billing: { type: 'one_time', interval: null }, displaySuffix: ' / once', termsUrl: null, privacyUrl: null,
            installmentsAvailable: false
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

// ---- Terms & Privacy consent ------------------------------------------------------------
// These tests mutate the shared global legal links, so they live in this file (tests in a file
// run sequentially) and always restore the links they change.
const TERMS = 'https://legal.example.com/terms';
const PRIVACY = 'https://legal.example.com/privacy';
// The settings payload also carries the (unrelated) affiliate limit; these tests only assert the legal links.
const legalOnly = ({ termsUrl, privacyUrl }) => ({ termsUrl, privacyUrl });
const putSettings = (body) => request(app).put('/api/admin/settings').set('x-api-key', ADMIN_KEY).send(body);
const clearGlobals = () => putSettings({ termsUrl: '', privacyUrl: null });
const txRow = async (paymentReference) =>
    (await pool.query('SELECT * FROM digital_solutions_transactions WHERE transaction_id = $1', [paymentReference])).rows[0];

test('settings API: requires admin auth; GET returns the two links', async () => {
    assert.equal((await request(app).get('/api/admin/settings')).status, 401);
    assert.equal((await request(app).put('/api/admin/settings').send({ termsUrl: TERMS })).status, 401);
    const res = await request(app).get('/api/admin/settings').set('x-api-key', ADMIN_KEY);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.settings).sort(), ['affiliateDiscountsPerCustomer', 'privacyUrl', 'termsUrl']);
});

test('settings API: validates URLs (400, nothing saved), trims, supports partial update and clearing', async () => {
    try {
        await clearGlobals();
        for (const bad of ['ftp://x.example.com/t', 'javascript:alert(1)', '/relative/terms', 'not a url', 'https://', `https://x.example.com/${'a'.repeat(2048)}`, 123, {}]) {
            const res = await putSettings({ termsUrl: TERMS, privacyUrl: bad });
            assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad).slice(0, 40)}`);
        }
        assert.deepEqual((await legalLinks.getGlobalLegalLinks()), { termsUrl: null, privacyUrl: null }, 'a rejected PUT must not save the valid half');

        const saved = await putSettings({ termsUrl: `  ${TERMS}  `, privacyUrl: PRIVACY });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.deepEqual(legalOnly(saved.body.settings), { termsUrl: TERMS, privacyUrl: PRIVACY });
        assert.deepEqual(legalOnly((await request(app).get('/api/admin/settings').set('x-api-key', ADMIN_KEY)).body.settings), { termsUrl: TERMS, privacyUrl: PRIVACY });

        const partial = await putSettings({ privacyUrl: null });
        assert.deepEqual(legalOnly(partial.body.settings), { termsUrl: TERMS, privacyUrl: null });
        const cleared = await putSettings({ termsUrl: '   ' });
        assert.deepEqual(legalOnly(cleared.body.settings), { termsUrl: null, privacyUrl: null });
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('product legal links: validated, stored, exposed in defaults, and clearable', async () => {
    const bad = await request(app).post('/api/admin/products').set('x-api-key', ADMIN_KEY)
        .send({ name: 'Bad Legal', id: `embed_badlegal_${SUFFIX}`, amountPhp: 10, defaults: { termsUrl: 'ftp://nope.example.com' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /defaults\.termsUrl/);

    const id = `embed_legal_crud_${SUFFIX}`;
    createdProductIds.add(id);
    const created = await request(app).post('/api/admin/products').set('x-api-key', ADMIN_KEY)
        .send({ name: 'Legal Crud', id, amountPhp: 10, defaults: { termsUrl: ` ${TERMS} `, privacyUrl: PRIVACY } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.product.defaults.termsUrl, TERMS);
    assert.equal(created.body.product.defaults.privacyUrl, PRIVACY);

    const cleared = await request(app).put(`/api/admin/products/${id}`).set('x-api-key', ADMIN_KEY)
        .send({ name: 'Legal Crud', amountPhp: 10, defaults: { termsUrl: '', privacyUrl: PRIVACY } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.product.defaults.termsUrl, undefined);
    assert.equal(cleared.body.product.defaults.privacyUrl, PRIVACY);
});

test('resolveLegalLinks: product overrides global, per link independently', async () => {
    const global = { termsUrl: 'https://global.example.com/t', privacyUrl: 'https://global.example.com/p' };
    try {
        await putSettings(global);
        const own = (defaults) => ({ id: 'x', defaults });
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({})), global);
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({ termsUrl: TERMS })), { termsUrl: TERMS, privacyUrl: global.privacyUrl });
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({ privacyUrl: PRIVACY })), { termsUrl: global.termsUrl, privacyUrl: PRIVACY });
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({ termsUrl: TERMS, privacyUrl: PRIVACY })), { termsUrl: TERMS, privacyUrl: PRIVACY });
        await clearGlobals();
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({ termsUrl: TERMS })), { termsUrl: TERMS, privacyUrl: null });
        assert.deepEqual(await legalLinks.resolveLegalLinks(own({})), { termsUrl: null, privacyUrl: null });
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('no links anywhere: no consent needed, termsAccepted is ignored, nothing recorded', async () => {
    try {
        await clearGlobals();
        const info = await request(app).get(`/api/embed/products/${ids.legacy}`);
        assert.equal(info.body.product.termsUrl, null);
        assert.equal(info.body.product.privacyUrl, null);

        intentCalls = [];
        const res = await request(app).post('/api/embed/checkout').send(checkoutBody());
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const meta = intentCalls[0].metadata;
        assert.equal(Object.keys(meta).some((k) => /^(terms_|privacy_)/.test(k)), false);
        const row = await txRow(res.body.paymentReference);
        assert.equal(row.terms_accepted_at, null);
        assert.equal(row.terms_url, null);
        assert.equal(row.privacy_url, null);

        intentCalls = [];
        const ignored = await request(app).post('/api/embed/checkout').send(checkoutBody({ termsAccepted: true }));
        assert.equal(ignored.status, 200);
        assert.equal(intentCalls[0].metadata.terms_accepted, undefined);
        assert.equal((await txRow(ignored.body.paymentReference)).terms_accepted_at, null);
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('embed checkout with product links: 400 without consent, 200 and audit record with consent', async () => {
    await productCatalog.upsertProduct({ id: ids.legalBoth, name: 'Embed Legal Both', amountPhp: 1000, defaults: { termsUrl: TERMS, privacyUrl: PRIVACY } });
    await productCatalog.upsertProduct({ id: ids.legalTerms, name: 'Embed Legal Terms', amountPhp: 1000, defaults: { termsUrl: TERMS } });
    try {
        await clearGlobals();
        const info = await request(app).get(`/api/embed/products/${ids.legalBoth}`);
        assert.equal(info.body.product.termsUrl, TERMS);
        assert.equal(info.body.product.privacyUrl, PRIVACY);

        intentCalls = [];
        for (const termsAccepted of [undefined, 'true']) {
            const res = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: ids.legalBoth, termsAccepted }));
            assert.equal(res.status, 400, `termsAccepted=${JSON.stringify(termsAccepted)}`);
            assert.equal(res.body.error, 'Please agree to the Terms and Conditions and Privacy Policy to continue.');
        }
        assert.equal(intentCalls.length, 0, 'no payment intent without consent');

        const before = Date.now();
        const ok = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: ids.legalBoth, termsAccepted: true }));
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(intentCalls.length, 1);
        const meta = intentCalls[0].metadata;
        assert.equal(meta.terms_accepted, 'true');
        assert.equal(meta.terms_url, TERMS);
        assert.equal(meta.privacy_url, PRIVACY);
        assert.ok(Date.parse(meta.terms_accepted_at) >= before - 1000 && Date.parse(meta.terms_accepted_at) <= Date.now() + 1000);

        const row = await txRow(ok.body.paymentReference);
        assert.equal(row.terms_url, TERMS);
        assert.equal(row.privacy_url, PRIVACY);
        assert.equal(row.terms_accepted_at.toISOString(), meta.terms_accepted_at);

        const detail = await request(app).get(`/api/admin/solutions/${ok.body.paymentReference}`).set('x-api-key', ADMIN_KEY);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.transaction.termsAcceptedAt, meta.terms_accepted_at);
        assert.equal(detail.body.transaction.termsUrl, TERMS);
        assert.equal(detail.body.transaction.privacyUrl, PRIVACY);
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('global links apply to products without overrides; the checkout records the links resolved at that moment', async () => {
    const global = { termsUrl: 'https://global.example.com/t', privacyUrl: 'https://global.example.com/p' };
    try {
        await putSettings(global);
        const info = await request(app).get(`/api/embed/products/${ids.legacy}`);
        assert.equal(info.body.product.termsUrl, global.termsUrl);
        assert.equal(info.body.product.privacyUrl, global.privacyUrl);

        // legalTerms overrides only the Terms link; Privacy falls back to the global one
        intentCalls = [];
        const ok = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: ids.legalTerms, termsAccepted: true }));
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(intentCalls[0].metadata.terms_url, TERMS);
        assert.equal(intentCalls[0].metadata.privacy_url, global.privacyUrl);
        const row = await txRow(ok.body.paymentReference);
        assert.equal(row.terms_url, TERMS);
        assert.equal(row.privacy_url, global.privacyUrl);

        // Single-link wording. The embed checkout limiter allows 15 requests per window, so
        // checkout calls in this file are kept to a minimum.
        await putSettings({ termsUrl: '', privacyUrl: global.privacyUrl });
        const privacyOnly = await request(app).post('/api/embed/checkout').send(checkoutBody());
        assert.equal(privacyOnly.status, 400);
        assert.equal(privacyOnly.body.error, 'Please agree to the Privacy Policy to continue.');
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('legacy create-payment-intent cannot be given a forged consent record', async () => {
    try {
        await clearGlobals();
        intentCalls = [];
        const res = await request(app).post('/api/payments/create-payment-intent').send({
            fullName: 'Legacy Caller', email: email(), mobile: '+639171234567', productId: ids.legacy,
            legalConsent: { acceptedAt: new Date().toISOString(), termsUrl: TERMS, privacyUrl: PRIVACY },
            termsAccepted: true
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(Object.keys(intentCalls[0].metadata).some((k) => /^(terms_|privacy_)/.test(k)), false);
        assert.equal((await txRow(res.body.paymentReference)).terms_accepted_at, null);
    } finally {
        await legalLinks.setGlobalLegalLinks(savedGlobalLinks);
    }
});

test('GET /api/embed/products/:id installmentsAvailable follows the real checkout rules', async () => {
    const keys = ['PAYMONGO_CARD_INSTALLMENTS_ENABLED', 'PAYMONGO_INSTALLMENTS_MIN_AMOUNT'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const mk = async (suffix, amountPhp, defaults = {}) => {
        const id = `embed_inst_${suffix}_${SUFFIX}`;
        createdProductIds.add(id);
        await productCatalog.upsertProduct({ id, name: `Inst ${suffix}`, amountPhp, defaults: { taxRate: 0, ...defaults } });
        return id;
    };
    const flag = async (id) => (await request(app).get(`/api/embed/products/${id}`)).body.product.installmentsAvailable;
    try {
        delete process.env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT;
        const all = await mk('all', 3500);
        const qr = await mk('qr', 3500, { paymentMethod: 'qrph' }); // 'qrph' expands to ALL methods (incl. card)
        const card = await mk('card', 3500, { paymentMethod: 'card' });
        const gcash = await mk('gcash', 3500, { paymentMethod: 'gcash' });
        const low = await mk('low', 2000);
        const taxed = await mk('taxed', 2800, { taxRate: 0.12 }); // 3136 incl. tax >= 3000

        process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
        assert.equal(await flag(all), true);
        assert.equal(await flag(qr), true);
        assert.equal(await flag(card), true);
        assert.equal(await flag(gcash), false);
        assert.equal(await flag(low), false);
        assert.equal(await flag(taxed), true);

        process.env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT = '5000';
        assert.equal(await flag(all), false);

        delete process.env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT;
        process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'false';
        assert.equal(await flag(all), false);
    } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
});
