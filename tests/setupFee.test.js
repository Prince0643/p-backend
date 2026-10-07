// tests/setupFee.test.js
// Recurring-product setup fee: normalization/storage, computePricing, the embed quote, the PayMongo
// checkout session line items, affiliate commission base, card-installments eligibility and the
// GHL first invoice vs renewal schedule.
require('./setupEnv');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const paymongoService = require('../services/paymongoService');
const ghlService = require('../services/ghlService');
const productCatalog = require('../utils/productCatalog');
const { computePricing } = require('../utils/pricing');
const { createTestCoupon, cleanupCoupon, signWebhookBody, paymentEventPayload } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const admin = (req) => req.set('x-api-key', ADMIN_KEY);
const SUFFIX = Date.now().toString(36);
const ids = {
    fee: `sf_fee_${SUFFIX}`,       // 1500/month + 5000 setup, 12% tax
    plain: `sf_plain_${SUFFIX}`,   // recurring, no setup fee
    admin: `sf_admin_${SUFFIX}`,
    upsert: `sf_upsert_${SUFFIX}`
};
const createdProductIds = new Set(Object.values(ids));
const email = () => `sf.${Math.random().toString(36).slice(2, 8)}@example.com`;
const checkoutBody = (overrides = {}) => ({
    productId: ids.fee, fullName: 'Setup Fee Tester', email: email(), mobile: '+639171234567', ...overrides
});
const sumLines = (lines) => Number(lines.reduce((t, l) => t + l.amount, 0).toFixed(2));

// PayMongo is stubbed at the service method for most tests; the real method (offline axios fake) is
// used where line items are asserted.
const realCreateIntent = paymongoService.createPaymentIntent;
let intentCalls = [];
const stubPaymongo = () => {
    paymongoService.createPaymentIntent = async (args) => {
        intentCalls.push(args);
        return { id: `pi_sf_${intentCalls.length}`, attributes: { checkout_url: 'https://checkout.example/test', client_secret: 'cs_test' } };
    };
};

before(async () => {
    stubPaymongo();
    await productCatalog.upsertProduct({ id: ids.fee, name: 'SF Fee', amountPhp: 1500, setupFeePhp: 5000, billing: { type: 'recurring', interval: 'monthly' }, defaults: { taxRate: 0.12, successUrl: 'https://product.example.com/thanks' } });
    await productCatalog.upsertProduct({ id: ids.plain, name: 'SF Plain', amountPhp: 1500, billing: { type: 'recurring', interval: 'monthly' }, defaults: { taxRate: 0.12 } });
});

after(async () => {
    paymongoService.createPaymentIntent = realCreateIntent;
    for (const id of createdProductIds) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE product_id = $1', [id]).catch(() => {});
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
    }
    await pool.end();
});

// ---------- normalize / storage ----------

test('normalize: one_time forces a null fee, negative / non-numeric is rejected, 0 and blank mean none', () => {
    const base = { id: 'x', name: 'X', amountPhp: 100 };
    const rec = { billing: { type: 'recurring', interval: 'monthly' } };
    assert.equal(productCatalog.normalizeProductInput({ ...base, setupFeePhp: 500 }).setupFeePhp, null);
    assert.equal(productCatalog.normalizeProductInput({ ...base, ...rec, setupFeePhp: '500.456' }).setupFeePhp, 500.46);
    assert.equal(productCatalog.normalizeProductInput({ ...base, ...rec, setupFeePhp: 0 }).setupFeePhp, null);
    assert.equal(productCatalog.normalizeProductInput({ ...base, ...rec, setupFeePhp: '' }).setupFeePhp, null);
    assert.equal(productCatalog.normalizeProductInput({ ...base, ...rec }).setupFeePhp, null);
    assert.throws(() => productCatalog.normalizeProductInput({ ...base, ...rec, setupFeePhp: -1 }), /setupFeePhp/);
    assert.throws(() => productCatalog.normalizeProductInput({ ...base, ...rec, setupFeePhp: 'abc' }), /setupFeePhp/);
    assert.throws(() => productCatalog.normalizeProductInput({ ...base, setupFeePhp: -5 }), /setupFeePhp/);
});

test('admin create/update round-trip; switching to one-time clears the fee; bad fee is 400', async () => {
    const body = { id: ids.admin, name: 'SF Admin', amountPhp: 1500, setupFeePhp: 5000, billing: { type: 'recurring' } };
    const created = await admin(request(app).post('/api/admin/products')).send(body);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.product.setupFeePhp, 5000);

    const fetched = await admin(request(app).get(`/api/admin/products/${ids.admin}`));
    assert.equal(fetched.body.product.setupFeePhp, 5000);

    const updated = await admin(request(app).put(`/api/admin/products/${ids.admin}`)).send({ ...body, setupFeePhp: 2500.5 });
    assert.equal(updated.body.product.setupFeePhp, 2500.5);

    const bad = await admin(request(app).put(`/api/admin/products/${ids.admin}`)).send({ ...body, setupFeePhp: -1 });
    assert.equal(bad.status, 400);

    const off = await admin(request(app).put(`/api/admin/products/${ids.admin}`)).send({ ...body, setupFeePhp: null });
    assert.equal(off.body.product.setupFeePhp, null);

    await admin(request(app).put(`/api/admin/products/${ids.admin}`)).send(body);
    const oneTime = await admin(request(app).put(`/api/admin/products/${ids.admin}`)).send({ ...body, billing: { type: 'one_time' } });
    assert.equal(oneTime.body.product.setupFeePhp, null);
});

test('upsertProduct (JSON-style re-import) keeps an admin-set fee unless the payload provides one', async () => {
    const payload = { id: ids.upsert, name: 'SF Upsert', amountPhp: 1000, billing: { type: 'recurring', interval: 'monthly' } };
    await productCatalog.upsertProduct({ ...payload, setupFeePhp: 700 });
    assert.equal((await productCatalog.upsertProduct(payload)).setupFeePhp, 700);
    assert.equal((await productCatalog.upsertProduct({ ...payload, setupFeePhp: 900 })).setupFeePhp, 900);
    assert.equal((await productCatalog.upsertProduct({ ...payload, billing: { type: 'one_time' } })).setupFeePhp, null);
});

// ---------- computePricing ----------

test('computePricing: setup fee is part of the first payment, taxed; renewal amount excludes it', () => {
    const product = { id: 'p', name: 'P', amountPhp: 1500, setupFeePhp: 5000, defaults: { taxRate: 0.12 } };
    const r = computePricing({ product, source: 'other' });
    assert.equal(r.setupFee, 5000);
    assert.equal(r.discountAmount, 0);
    assert.equal(r.baseAmount, 6500);
    assert.equal(r.taxAmount, 780);
    assert.equal(r.finalAmount, 7280);
    assert.equal(r.fullPriceAmount, 1680); // monthly only: 1500 * 1.12
    assert.equal(r.setupFeeAmount, 5600);
    assert.deepEqual(r.lines.map((l) => [l.key, l.amount]), [['product', 1680], ['setup_fee', 5600]]);
    assert.equal(sumLines(r.lines), r.finalAmount);
});

test('computePricing: coupon discount applies to setup fee + first month; lines sum exactly', () => {
    const product = { id: 'p', name: 'P', amountPhp: 1500, setupFeePhp: 5000, defaults: { taxRate: 0.12 } };
    const r = computePricing({ product, source: 'other', discountPercent: 0.2 });
    assert.equal(r.discountAmount, 1300);
    assert.equal(r.baseAmount, 5200);
    assert.equal(r.taxAmount, 624);
    assert.equal(r.finalAmount, 5824);
    assert.equal(r.fullPriceAmount, 1680);
    assert.equal(sumLines(r.lines), r.finalAmount);
    assert.equal(r.lines[1].amount, 4480); // (5000 - 1000) * 1.12
});

test('computePricing: lines always sum to finalAmount under awkward rounding; no fee = unchanged shape', () => {
    for (const [amt, fee, pct, tax] of [[999.99, 1234.57, 0.33, 0.12], [1.01, 0.03, 0.07, 0.1], [333.33, 111.11, 0.15, 0]]) {
        const r = computePricing({ product: { id: 'p', name: 'P', amountPhp: amt, setupFeePhp: fee, defaults: { taxRate: tax } }, source: 'o', discountPercent: pct });
        assert.equal(sumLines(r.lines), r.finalAmount, JSON.stringify([amt, fee, pct, tax]));
    }
    const none = computePricing({ product: { id: 'p', name: 'P', amountPhp: 1000, setupFeePhp: null, defaults: { taxRate: 0 } }, source: 'o', discountPercent: 0.1 });
    assert.equal(none.setupFee, 0);
    assert.equal(none.finalAmount, 900);
    assert.equal(none.lines.length, 1);
    assert.equal(none.lines[0].amount, 900);
});

// ---------- embed ----------

test('embed quote: setup fee line, total includes it, renewal excludes it; public product exposes it', async () => {
    const res = await request(app).post('/api/embed/quote').send({ productId: ids.fee });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subtotal, 1500);
    assert.equal(res.body.setupFee, 5000);
    assert.equal(res.body.taxAmount, 780);
    assert.equal(res.body.total, 7280);
    assert.deepEqual(res.body.renewal, { amount: 1680, interval: 'monthly' });

    const plain = await request(app).post('/api/embed/quote').send({ productId: ids.plain });
    assert.equal(plain.body.setupFee, 0);
    assert.equal(plain.body.total, 1680);

    const prod = await request(app).get(`/api/embed/products/${ids.fee}`);
    assert.equal(prod.body.product.setupFeePhp, 5000);
});

test('embed quote with a coupon discounts the whole first payment and equals what checkout charges', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.2 });
    const buyer = email();
    try {
        const quote = await request(app).post('/api/embed/quote').send({ productId: ids.fee, promoCode: code, email: buyer });
        assert.equal(quote.body.discountAmount, 1300);
        assert.equal(quote.body.total, 5824);
        assert.deepEqual(quote.body.renewal, { amount: 1680, interval: 'monthly' });
        intentCalls = [];
        const co = await request(app).post('/api/embed/checkout').send(checkoutBody({ email: buyer, promoCode: code }));
        assert.equal(co.status, 200, JSON.stringify(co.body));
        assert.equal(co.body.amount, quote.body.total);
        assert.equal(intentCalls[0].setupFeeAmount, 4480);
        assert.equal(intentCalls[0].metadata.setupFeeAmount, '4480');
        assert.equal(intentCalls[0].metadata.fullPriceAmount, '1680');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
        await cleanupCoupon(code);
    }
});

// ---------- PayMongo line items ----------

test('PayMongo checkout session gets product + "Setup fee" line items summing to the amount', async () => {
    const posts = [];
    const realPost = paymongoService.client.post;
    paymongoService.client.post = async (url, payload) => {
        posts.push({ url, payload });
        if (url === '/payment_intents') return { data: { data: { id: 'pi_x', attributes: { client_secret: 'cs_x' } } } };
        return { data: { data: { id: 'cs_x', attributes: { checkout_url: 'https://checkout.example/x' } } } };
    };
    try {
        await realCreateIntent.call(paymongoService, {
            amount: 7280, currency: 'PHP', description: 'SF Fee - Tester', paymentMethodAllowed: ['qrph'], metadata: {}, setupFeeAmount: 5600
        });
        const items = posts.find((p) => p.url === '/checkout_sessions').payload.data.attributes.line_items;
        assert.equal(items.length, 2);
        assert.equal(items[1].name, 'Setup fee');
        assert.deepEqual(items.map((i) => i.amount), [168000, 560000]);
        assert.equal(items.reduce((t, i) => t + i.amount * i.quantity, 0), 728000);

        posts.length = 0;
        await realCreateIntent.call(paymongoService, {
            amount: 1680, currency: 'PHP', description: 'SF Plain', paymentMethodAllowed: ['qrph'], metadata: {}
        });
        const single = posts.find((p) => p.url === '/checkout_sessions').payload.data.attributes.line_items;
        assert.equal(single.length, 1);
        assert.equal(single[0].amount, 168000);
    } finally {
        paymongoService.client.post = realPost;
    }
});

// ---------- affiliate commission ----------

test('affiliate commission base includes the setup fee (post-discount, pre-tax)', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'aff.sf@example.com', discountPercent: 0.2, affiliateFeePercent: 0.1, maxRedemptions: 5 });
    try {
        const co = await request(app).post('/api/embed/checkout').send(checkoutBody({ promoCode: code }));
        assert.equal(co.status, 200, JSON.stringify(co.body));
        const { rows } = await pool.query('SELECT base_amount, discount_amount, commission_base, affiliate_fee_amount FROM coupon_redemptions WHERE code = $1', [code]);
        assert.equal(Number(rows[0].commission_base), 5200); // 1500 + 5000 - 20%
        assert.equal(Number(rows[0].base_amount), 5200);
        assert.equal(Number(rows[0].discount_amount), 1300);
        assert.equal(Number(rows[0].affiliate_fee_amount), 520);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
        await cleanupCoupon(code);
    }
});

// ---------- installments ----------

test('card installments eligibility counts the setup fee (embed pre-check and checkout session)', async () => {
    const keys = ['PAYMONGO_CARD_INSTALLMENTS_ENABLED', 'PAYMONGO_INSTALLMENTS_MIN_AMOUNT'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const lowId = `sf_inst_low_${SUFFIX}`;
    const highId = `sf_inst_high_${SUFFIX}`;
    createdProductIds.add(lowId); createdProductIds.add(highId);
    const rec = { type: 'recurring', interval: 'monthly' };
    await productCatalog.upsertProduct({ id: lowId, name: 'SF Inst Low', amountPhp: 1500, billing: rec, defaults: { taxRate: 0 } });
    await productCatalog.upsertProduct({ id: highId, name: 'SF Inst High', amountPhp: 1500, setupFeePhp: 2000, billing: rec, defaults: { taxRate: 0 } });
    const flag = async (id) => (await request(app).get(`/api/embed/products/${id}`)).body.product.installmentsAvailable;
    try {
        delete process.env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT;
        process.env.PAYMONGO_CARD_INSTALLMENTS_ENABLED = 'true';
        assert.equal(await flag(lowId), false); // 1500 < 3000
        assert.equal(await flag(highId), true); // 1500 + 2000 >= 3000

        // The real session: same amount (incl. fee) drives payment_method_options.
        const posts = [];
        const realPost = paymongoService.client.post;
        paymongoService.client.post = async (url, payload) => {
            posts.push({ url, payload });
            return { data: { data: { id: 'x', attributes: { checkout_url: 'https://checkout.example/x', client_secret: 'cs' } } } };
        };
        try {
            await realCreateIntent.call(paymongoService, { amount: 3500, currency: 'PHP', description: 'd', paymentMethodAllowed: ['card'], metadata: {}, setupFeeAmount: 2000 });
            assert.ok(posts.find((p) => p.url === '/checkout_sessions').payload.data.attributes.payment_method_options);
        } finally {
            paymongoService.client.post = realPost;
        }
    } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
});

// ---------- GHL first invoice vs renewal schedule ----------

test('GHL: first invoice has a "Setup fee" item; the recurring schedule bills the monthly price only', async () => {
    const envKeys = ['GHL_PRIVATE_KEY', 'GHL_LOCATION_ID'];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    const methods = ['upsertContact', 'createInvoice', 'recordInvoicePayment', 'createInvoiceSchedule', 'scheduleInvoiceSchedule'];
    const savedMethods = Object.fromEntries(methods.map((m) => [m, ghlService[m]]));
    const contactId = `sf_contact_${SUFFIX}`;
    const calls = {};
    ghlService.upsertContact = async () => ({ contact: { id: contactId } });
    ghlService.createInvoice = async (args) => { calls.invoice = args; return { _id: 'inv_sf' }; };
    ghlService.recordInvoicePayment = async (args) => { calls.payment = args; return { id: 'txn_sf' }; };
    ghlService.createInvoiceSchedule = async (args) => { calls.schedule = args; return { _id: `sched_sf_${SUFFIX}` }; };
    ghlService.scheduleInvoiceSchedule = async () => ({});
    process.env.GHL_PRIVATE_KEY = 'pit_fake_for_test';
    process.env.GHL_LOCATION_ID = `loc_sf_${SUFFIX}`;
    try {
        intentCalls = [];
        const co = await request(app).post('/api/embed/checkout').send(checkoutBody());
        assert.equal(co.status, 200, JSON.stringify(co.body));
        const metadata = intentCalls[0].metadata;
        const payload = paymentEventPayload('payment.paid', metadata, { amountCentavos: Math.round(co.body.amount * 100) });
        const { body, header } = signWebhookBody(payload);
        const res = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(body);
        assert.equal(res.status, 200);

        const items = calls.invoice.items;
        assert.equal(items.length, 2);
        assert.equal(items[1].name, 'Setup fee');
        assert.equal(items[1].amount, 5600);
        assert.equal(items[0].amount, 1680);
        assert.equal(Number((items[0].amount + items[1].amount).toFixed(2)), 7280);
        assert.equal(calls.payment.amount, 7280);

        assert.equal(calls.schedule.items.length, 1);
        assert.equal(calls.schedule.items[0].amount, 1680);
        assert.equal(calls.schedule.items[0].type, 'recurring');
    } finally {
        await pool.query('DELETE FROM ghl_invoice_schedules WHERE contact_id = $1', [contactId]);
        for (const m of methods) ghlService[m] = savedMethods[m];
        for (const k of envKeys) process.env[k] = savedEnv[k];
    }
});

test('GHL: a product without a setup fee still produces a single-item first invoice', async () => {
    const envKeys = ['GHL_PRIVATE_KEY', 'GHL_LOCATION_ID'];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    const methods = ['upsertContact', 'createInvoice', 'recordInvoicePayment', 'createInvoiceSchedule', 'scheduleInvoiceSchedule'];
    const savedMethods = Object.fromEntries(methods.map((m) => [m, ghlService[m]]));
    const contactId = `sf_contact_plain_${SUFFIX}`;
    const calls = {};
    ghlService.upsertContact = async () => ({ contact: { id: contactId } });
    ghlService.createInvoice = async (args) => { calls.invoice = args; return { _id: 'inv_sf2' }; };
    ghlService.recordInvoicePayment = async () => ({ id: 't' });
    ghlService.createInvoiceSchedule = async (args) => { calls.schedule = args; return { _id: `sched_sf2_${SUFFIX}` }; };
    ghlService.scheduleInvoiceSchedule = async () => ({});
    process.env.GHL_PRIVATE_KEY = 'pit_fake_for_test';
    process.env.GHL_LOCATION_ID = `loc_sf_${SUFFIX}`;
    try {
        intentCalls = [];
        const co = await request(app).post('/api/embed/checkout').send(checkoutBody({ productId: ids.plain }));
        const metadata = intentCalls[0].metadata;
        assert.equal(metadata.setupFeeAmount, undefined);
        const { body, header } = signWebhookBody(paymentEventPayload('payment.paid', metadata, { amountCentavos: Math.round(co.body.amount * 100) }));
        await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(body);
        assert.equal(calls.invoice.items.length, 1);
        assert.equal(calls.invoice.items[0].amount, 1680);
        assert.equal(calls.schedule.items[0].amount, 1680);
    } finally {
        await pool.query('DELETE FROM ghl_invoice_schedules WHERE contact_id = $1', [contactId]);
        for (const m of methods) ghlService[m] = savedMethods[m];
        for (const k of envKeys) process.env[k] = savedEnv[k];
    }
});
