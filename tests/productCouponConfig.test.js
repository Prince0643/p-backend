// tests/productCouponConfig.test.js
// Per-product coupon config: local enforcement (checkout + quote), the admin API, and the GHL
// productIds sync (GHL is faked in memory - no test here may reach the network).
require('./setupEnv');
const { test, after, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const paymongoService = require('../services/paymongoService');
const couponStore = require('../utils/couponStore');
const productCatalog = require('../utils/productCatalog');
const { computeProductIds, syncAll } = require('../services/ghlProductCouponSync');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SUFFIX = Date.now().toString(36);
const P1 = `pcc_one_${SUFFIX}`;
const P2 = `pcc_two_${SUFFIX}`;
const GHL_REF = `pcc_ghl_${SUFFIX}`;
const LOCS = [
    { key: 'global', name: 'Global', locationId: 'loc_g', privateKey: 'k1' },
    { key: 'main', name: 'Main', locationId: 'loc_m', privateKey: 'k2' }
];
const names = ['getTrackedLocations', 'listCouponsForLocation', 'listLocationProducts', 'updateCouponProductRestriction'];
const originals = Object.fromEntries(names.map((n) => [n, ghlService[n]]));
const realCreateIntent = paymongoService.createPaymentIntent;
const coupons = [];
const email = () => `pcc.${Math.random().toString(36).slice(2, 8)}@example.com`;
const admin = (r) => r.set('x-api-key', ADMIN_KEY);

async function makeCoupon(overrides = {}) {
    const code = await createTestCoupon(overrides);
    coupons.push(code);
    return code;
}
const putConfig = (body) => admin(request(app).put('/api/admin/product-coupon-config')).send(body);

before(async () => {
    paymongoService.createPaymentIntent = async () => ({ id: 'pi_test_pcc', attributes: { checkout_url: 'https://checkout.example/test', client_secret: 'cs_test' } });
    await productCatalog.upsertProduct({ id: P1, name: 'PCC One', amountPhp: 1000, defaults: { taxRate: 0, successUrl: 'https://product.example.com/thanks' } });
    await productCatalog.upsertProduct({ id: P2, name: 'PCC Two', amountPhp: 1000, defaults: { taxRate: 0, successUrl: 'https://product.example.com/thanks' } });
});
afterEach(() => Object.assign(ghlService, originals));
after(async () => {
    paymongoService.createPaymentIntent = realCreateIntent;
    for (const code of coupons) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE promo_code = $1', [code]);
        await cleanupCoupon(code);
    }
    await pool.query("DELETE FROM product_coupon_config WHERE ref = ANY($1)", [[P1, P2, GHL_REF, 'p1', 'p2', 'p3', 'p4']]);
    for (const id of [P1, P2]) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE product_id = $1', [id]);
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
    }
    await pool.end();
});

// ---------------------------------------------------------------- local enforcement

test('affiliate switch off: affiliate coupon rejected on checkout and quote for that product only', async () => {
    const code = await makeCoupon({ type: 'affiliate', affiliateEmail: 'aff@example.com' });
    assert.equal((await putConfig({ kind: 'local', ref: P1, affiliateCouponsEnabled: false, disabledCouponCodes: [] })).status, 200);

    const reservation = await couponStore.beginCouponReservation({ code, productId: P1, email: email() });
    assert.equal(reservation.reason, 'product_coupon_disabled');
    assert.equal(reservation.error, 'This coupon is not valid for this product.');

    const quote = await request(app).post('/api/embed/quote').send({ productId: P1, promoCode: code, email: email() });
    assert.equal(quote.body.promo.applied, false);
    assert.equal(quote.body.promo.message, 'This coupon is not valid for this product.');
    assert.equal(quote.body.promo.reason, 'product_coupon_disabled');

    const ro = await couponStore.validateCouponReadOnly({ code, productId: P1 });
    assert.equal(ro.reason, 'product_coupon_disabled');

    // other product is untouched
    const other = await couponStore.validateCouponReadOnly({ code, productId: P2 });
    assert.ok(other.coupon);
});

test('a referral link (attributionRef) on a disabled product returns an error instead of being dropped', async () => {
    const code = await makeCoupon({ type: 'affiliate', affiliateEmail: 'aff2@example.com' });
    await putConfig({ kind: 'local', ref: P1, affiliateCouponsEnabled: false, disabledCouponCodes: [] });
    const body = { productId: P1, fullName: 'T', email: email(), mobile: '+639171234567', attributionRef: code, promoCode: code };
    const blocked = await request(app).post('/api/embed/checkout').send(body);
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, 'This coupon is not valid for this product.');

    // an unknown ref is still best-effort (checkout proceeds undiscounted)
    const unknown = await request(app).post('/api/embed/checkout').send({ ...body, attributionRef: 'NOPE999', promoCode: 'NOPE999' });
    assert.equal(unknown.status, 200);
});

test('general coupon blocked per product; new coupons default to allowed; both rules apply', async () => {
    const blocked = await makeCoupon({});
    const fresh = await makeCoupon({});
    const restricted = await makeCoupon({ productIds: [P2] });
    await putConfig({ kind: 'local', ref: P1, affiliateCouponsEnabled: true, disabledCouponCodes: [blocked] });

    assert.equal((await couponStore.validateCouponReadOnly({ code: blocked, productId: P1 })).reason, 'product_coupon_disabled');
    assert.ok((await couponStore.validateCouponReadOnly({ code: blocked, productId: P2 })).coupon);
    // a coupon created after the config was saved is allowed on P1 by default
    assert.ok((await couponStore.validateCouponReadOnly({ code: fresh, productId: P1 })).coupon);
    // coupon-side restriction still applies on its own...
    assert.equal((await couponStore.validateCouponReadOnly({ code: restricted, productId: P1 })).reason, 'product_not_eligible');
    // ...and combined with a product-side block on the product it IS eligible for
    await putConfig({ kind: 'local', ref: P2, affiliateCouponsEnabled: true, disabledCouponCodes: [restricted] });
    assert.equal((await couponStore.validateCouponReadOnly({ code: restricted, productId: P2 })).reason, 'product_coupon_disabled');
    await putConfig({ kind: 'local', ref: P2, affiliateCouponsEnabled: true, disabledCouponCodes: [] });
    assert.ok((await couponStore.validateCouponReadOnly({ code: restricted, productId: P2 })).coupon);

    const checkout = await request(app).post('/api/embed/checkout')
        .send({ productId: P1, fullName: 'T', email: email(), mobile: '+639171234567', promoCode: blocked });
    assert.equal(checkout.status, 400);
});

// ---------------------------------------------------------------- admin API

test('API: validation of kind/location/ref/codes', async () => {
    const ok = { kind: 'local', ref: P1, affiliateCouponsEnabled: true, disabledCouponCodes: [] };
    assert.equal((await putConfig({ ...ok, kind: 'nope' })).status, 400);
    assert.equal((await putConfig({ ...ok, ref: 'does_not_exist' })).status, 400);
    assert.equal((await putConfig({ ...ok, ref: '' })).status, 400);
    assert.equal((await putConfig({ kind: 'ghl', ref: 'x', affiliateCouponsEnabled: true, disabledCouponCodes: [] })).status, 400);
    assert.equal((await putConfig({ ...ok, disabledCouponCodes: ['NOSUCHCODE1'] })).status, 400);
    assert.equal((await putConfig({ ...ok, affiliateCouponsEnabled: 'yes' })).status, 400);
    assert.equal((await admin(request(app).get('/api/admin/product-coupon-config')).query({ kind: 'ghl', ref: 'x' })).status, 400);
    assert.equal((await request(app).get('/api/admin/product-coupon-config').query({ kind: 'local', ref: P1 })).status, 401);
});

test('API: GET/PUT shape for a local product, eligibility reasons, products list summary, delete cleanup', async () => {
    const inactive = await makeCoupon({ active: false });
    const scoped = await makeCoupon({ productIds: [P2] });
    const normal = await makeCoupon({});
    const res = await putConfig({ kind: 'local', ref: P1, name: 'PCC One', affiliateCouponsEnabled: false, disabledCouponCodes: [normal.toLowerCase()] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.product, { kind: 'local', locationKey: null, ref: P1, name: 'PCC One' });
    assert.equal(res.body.affiliateCouponsEnabled, false);
    assert.deepEqual(res.body.ghlSync, { attempted: 0, errors: [] });
    const byCode = Object.fromEntries(res.body.coupons.map((c) => [c.code, c]));
    assert.equal(byCode[normal].enabled, false);
    assert.equal(byCode[normal].eligible, true);
    assert.equal(byCode[inactive].ineligibleReason, 'inactive');
    assert.equal(byCode[scoped].ineligibleReason, 'product_not_eligible');
    assert.equal(byCode[scoped].enabled, true);
    assert.equal(typeof byCode[normal].discountPercent, 'number');

    const get = await admin(request(app).get('/api/admin/product-coupon-config')).query({ kind: 'local', ref: P1 });
    assert.deepEqual(get.body.coupons.find((c) => c.code === normal), byCode[normal]);

    const list = await admin(request(app).get('/api/admin/products'));
    const p1 = list.body.products.find((p) => p.id === P1);
    assert.deepEqual(p1.couponConfig, { affiliateCouponsEnabled: false, disabledCouponCount: 1 });
    assert.deepEqual(list.body.products.find((p) => p.id === P2).couponConfig, { affiliateCouponsEnabled: true, disabledCouponCount: 0 });

    const tmp = `pcc_tmp_${SUFFIX}`;
    await productCatalog.upsertProduct({ id: tmp, name: 'PCC Tmp', amountPhp: 1000, defaults: {} });
    await putConfig({ kind: 'local', ref: tmp, affiliateCouponsEnabled: false, disabledCouponCodes: [] });
    assert.equal((await admin(request(app).delete(`/api/admin/products/${tmp}`))).status, 200);
    const { rows } = await pool.query("SELECT 1 FROM product_coupon_config WHERE kind = 'local' AND ref = $1", [tmp]);
    assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------- GHL

test('computeProductIds: original intersect, blocked subtraction, empty deactivates, nothing blocked restores original', () => {
    const universe = ['p1', 'p2', 'p3'];
    assert.deepEqual(computeProductIds({ universe, original: [], blocked: new Set() }), { productIds: [], allowed: universe, deactivate: false });
    assert.deepEqual(computeProductIds({ universe, original: [], blocked: new Set(['p1']) }).productIds, ['p2', 'p3']);
    assert.deepEqual(computeProductIds({ universe, original: ['p1', 'p2'], blocked: new Set(['p1']) }).productIds, ['p2']);
    // blocking a product outside the original restriction changes nothing -> original is pushed
    assert.deepEqual(computeProductIds({ universe, original: ['p1', 'p2'], blocked: new Set(['p3']) }).productIds, ['p1', 'p2']);
    assert.equal(computeProductIds({ universe, original: ['p1'], blocked: new Set(['p1']) }).deactivate, true);
    assert.equal(computeProductIds({ universe: ['p1'], original: [], blocked: new Set(['p1']) }).deactivate, true);
});

/** In-memory GHL: coupons per location id, products per location id; every write is recorded. */
function fakeGhl({ coupons: initial = {}, products = {} } = {}) {
    const store = { loc_g: [...(initial.loc_g || [])], loc_m: [...(initial.loc_m || [])] };
    const prods = { loc_g: products.loc_g || [], loc_m: products.loc_m || [] };
    const writes = [];
    ghlService.getTrackedLocations = () => LOCS;
    ghlService.listCouponsForLocation = async (l) => ({ coupons: store[l.locationId].map((c) => ({ ...c })) });
    ghlService.listLocationProducts = async (l) => prods[l.locationId].map((id) => ({ ref: id, name: id, price: null }));
    ghlService.updateCouponProductRestriction = async (l, existing, productIds, { endDate } = {}) => {
        writes.push({ locationId: l.locationId, code: existing.code, productIds, endDate });
        const target = store[l.locationId].find((c) => c.id === existing.id);
        target.productIds = productIds;
        if (endDate !== undefined) target.endDate = endDate;
        return target;
    };
    return { store, prods, writes };
}
const ghlCoupon = (code, extra = {}) => ({ id: `id_${code}`, code, status: 'active', discountValue: 10, productIds: [], applyToFuturePayments: false, limitPerCustomer: true, ...extra });
async function makeGhlGeneral(locationIds = ['loc_g']) {
    return makeCoupon({
        type: 'general', origin: 'ghl', localEnabled: false, ghlLocationIds: locationIds,
        ghlCouponMeta: { productIds: [], byLocation: locationIds.map((l) => ({ locationId: l, ghlCouponId: `id_x_${l}` })) }
    });
}
const ghlKey = (ref) => ({ kind: 'ghl', location: 'global', ref });
const lastWrite = (writes, code) => writes.filter((w) => w.code === code).at(-1);

test('GHL: block/unblock a general coupon restores the ORIGINAL restriction without compounding', async () => {
    const code = await makeGhlGeneral();
    const { store, writes } = fakeGhl({ coupons: { loc_g: [ghlCoupon(code, { productIds: ['p1', 'p2'] })] }, products: { loc_g: ['p1', 'p2', 'p3'] } });

    let res = await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [code] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ghlSync, { attempted: 1, errors: [] });
    assert.deepEqual(store.loc_g[0].productIds, ['p2']);
    assert.equal(res.body.coupons.find((c) => c.code === code).enabled, false);

    // a second push with the same config must not change anything (no compounding)
    const before = writes.length;
    await syncAll();
    assert.equal(writes.length, before);
    assert.deepEqual(store.loc_g[0].productIds, ['p2']);

    // GHL product p3 is outside the original restriction, so blocking it changes nothing
    res = await putConfig({ ...ghlKey('p3'), affiliateCouponsEnabled: true, disabledCouponCodes: [code] });
    assert.deepEqual(store.loc_g[0].productIds, ['p2']);

    // unblocking everything restores the original
    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [] });
    await putConfig({ ...ghlKey('p3'), affiliateCouponsEnabled: true, disabledCouponCodes: [] });
    assert.deepEqual([...store.loc_g[0].productIds].sort(), ['p1', 'p2']);
    const state = (await couponStore.findCoupon(code)).ghlProductSync.global;
    assert.equal(state.status, 'synced');
    assert.deepEqual(state.original, ['p1', 'p2']);
});

test('GHL: blocked on every product ends the coupon (endDate), and unblocking restores the original endDate', async () => {
    const code = await makeGhlGeneral();
    const origEnd = new Date(Date.now() + 30 * 86400000).toISOString();
    const { store, writes } = fakeGhl({
        coupons: { loc_g: [ghlCoupon(code, { productIds: ['p1'], endDate: origEnd, startDate: '2020-01-01T00:00:00.000Z' })] },
        products: { loc_g: ['p1', 'p2'] }
    });
    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [code] });
    assert.ok(new Date(store.loc_g[0].endDate).getTime() <= Date.now());
    assert.deepEqual(store.loc_g[0].productIds, ['p1']);   // restriction stays at the original
    assert.equal(lastWrite(writes, code).endDate, store.loc_g[0].endDate);
    const state = (await couponStore.findCoupon(code)).ghlProductSync.global;
    assert.equal(state.deactivatedByUs, true);
    assert.equal(state.originalEndDate, origEnd);

    // a re-sync while still fully blocked changes nothing
    const n = writes.length;
    await syncAll();
    assert.equal(writes.length, n);

    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [] });
    assert.equal(store.loc_g[0].endDate, origEnd);
    assert.deepEqual(store.loc_g[0].productIds, ['p1']);
});

test('GHL: a coupon with no endDate is reactivated by clearing endDate; a future startDate keeps endDate after it', async () => {
    const code = await makeGhlGeneral();
    const start = new Date(Date.now() + 86400000).toISOString();
    const { store } = fakeGhl({ coupons: { loc_g: [ghlCoupon(code, { startDate: start })] }, products: { loc_g: ['p1'] } });
    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [code] });
    assert.ok(new Date(store.loc_g[0].endDate).getTime() > new Date(start).getTime());
    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [] });
    assert.equal(store.loc_g[0].endDate, null);
});

test('GHL: coupons already expired in GHL, or inactive on our side, are left alone', async () => {
    const expired = await makeGhlGeneral();
    const inactive = await makeGhlGeneral();
    await pool.query('UPDATE coupons SET active = false WHERE code = $1', [inactive]);
    const past = '2020-06-01T00:00:00.000Z';
    const { store, writes } = fakeGhl({
        coupons: { loc_g: [ghlCoupon(expired, { endDate: past }), ghlCoupon(inactive)] },
        products: { loc_g: ['p1', 'p2'] }
    });
    await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [expired, inactive] });
    assert.equal(writes.filter((w) => [expired, inactive].includes(w.code)).length, 0);
    assert.equal(store.loc_g[0].endDate, past);
});

test('GHL: affiliate switch off restricts affiliate coupons; a new GHL product is picked up by the auto re-sync', async () => {
    const aff = await makeCoupon({ type: 'affiliate', affiliateEmail: 'aff3@example.com' });
    const { store, prods } = fakeGhl({ coupons: { loc_g: [ghlCoupon(aff)], loc_m: [ghlCoupon(aff)] }, products: { loc_g: ['p1', 'p2', 'p3'], loc_m: ['m1'] } });

    const res = await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: false, disabledCouponCodes: [] });
    assert.equal(res.status, 200);
    assert.ok(res.body.ghlSync.attempted >= 1);
    assert.deepEqual(res.body.ghlSync.errors, []);
    assert.deepEqual(store.loc_g[0].productIds, ['p2', 'p3']);
    assert.deepEqual(store.loc_m[0].productIds, []);   // other location untouched

    prods.loc_g.push('p4');   // a product is added in GHL: allowed by default
    const out = await syncAll();
    assert.deepEqual(out.errors, []);
    assert.deepEqual(store.loc_g[0].productIds, ['p2', 'p3', 'p4']);

    // the manual trigger endpoint runs the same re-sync
    prods.loc_g.push('p5');
    const manual = await admin(request(app).post('/api/admin/product-coupon-config/ghl-sync'));
    assert.equal(manual.status, 200);
    assert.deepEqual(manual.body.errors, []);
    assert.ok(Array.isArray(manual.body.results));
    assert.deepEqual(store.loc_g[0].productIds, ['p2', 'p3', 'p4', 'p5']);
});

test('GHL: failures are non-fatal - the save succeeds and the error is reported and recorded', async () => {
    const code = await makeGhlGeneral();
    fakeGhl({ coupons: { loc_g: [ghlCoupon(code)] }, products: { loc_g: ['p1', 'p2'] } });
    ghlService.updateCouponProductRestriction = async () => { throw new Error('GHL down'); };
    const res = await putConfig({ ...ghlKey('p1'), affiliateCouponsEnabled: true, disabledCouponCodes: [code] });
    assert.equal(res.status, 200);
    assert.equal(res.body.ghlSync.errors.length, 1);
    assert.deepEqual(res.body.ghlSync.errors[0], { code, locationKey: 'global', error: 'GHL down' });
    assert.equal((await couponStore.findCoupon(code)).ghlProductSync.global.status, 'error');
    assert.equal(res.body.coupons.find((c) => c.code === code).enabled, false);   // config still saved
});

test('GHL: GET /ghl-products lists each tracked location and reports a failing one without failing the call', async () => {
    fakeGhl({ products: { loc_g: ['a'] } });
    ghlService.listLocationProducts = async (l) => {
        if (l.key === 'main') throw new Error('boom');
        return [{ ref: 'a', name: 'A', price: 1500, currency: 'PHP' }];
    };
    const res = await admin(request(app).get('/api/admin/ghl-products'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.locations[0], { key: 'global', locationId: 'loc_g', products: [{ id: 'a', name: 'A', price: 1500 }] });
    assert.equal(res.body.locations[1].key, 'main');
    assert.equal(res.body.locations[1].error, 'boom');
});

test('GHL: GET config for a ghl product lists GHL-origin general coupons of that location with eligibility', async () => {
    const code = await makeGhlGeneral();
    const other = await makeGhlGeneral(['loc_m']);
    fakeGhl();
    await pool.query("UPDATE coupons SET ghl_coupon_meta = jsonb_set(ghl_coupon_meta, '{productIds}', '[\"pX\"]') WHERE code = $1", [code]);
    const res = await admin(request(app).get('/api/admin/product-coupon-config')).query({ kind: 'ghl', location: 'global', ref: GHL_REF });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.product, { kind: 'ghl', locationKey: 'global', ref: GHL_REF, name: null });
    const found = res.body.coupons.find((c) => c.code === code);
    assert.equal(found.eligible, false);
    assert.equal(found.ineligibleReason, 'ghl_product_not_eligible');
    assert.equal(res.body.coupons.some((c) => c.code === other), false);
});

test('widget shows a coupon blocked for the product as a blocking error, not "you can still continue"', async () => {
    const res = await request(app).get('/public/nx-embed.js');
    assert.match(res.text, /product_coupon_disabled/);
    assert.match(res.text, /This coupon is not valid for this product\. Remove it to continue\./);
});
