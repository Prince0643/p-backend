// tests/perCustomerLimit.test.js
// Per-customer coupon redemption limits: the per-coupon limit on GENERAL coupons
// (coupons.max_redemptions_per_customer, NULL = unlimited, default 1) and the single global
// "affiliate discounts per customer" setting, plus their mapping to GHL's boolean limitPerCustomer.
require('./setupEnv');
const fs = require('fs');
const path = require('path');
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const couponSettings = require('../utils/couponSettings');
const ghlCouponPush = require('../services/ghlCouponPush');
const { buildImportPlan } = require('../scripts/importGhlGeneralCoupons');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const PRODUCT_ID = 'test_product';
const names = ['getTrackedLocations', 'listCouponsForLocation', 'createCouponForLocation', 'updateCouponForLocation', 'updateCouponProductRestriction'];
const originals = Object.fromEntries(names.map((n) => [n, ghlService[n]]));
const originalGetLimit = couponSettings.getAffiliateDiscountsPerCustomer;
afterEach(() => {
    Object.assign(ghlService, originals);
    couponSettings.getAffiliateDiscountsPerCustomer = originalGetLimit;
});
after(async () => {
    await pool.end();
});

const email = () => `limit.${Math.random().toString(36).slice(2, 10)}@example.com`;
const admin = (req) => req.set('x-api-key', ADMIN_KEY);

/** Inserts a redemption row directly (any status / test flag / source). */
async function insertRedemption(code, who, { status = 'paid', isTest = false, source = 'paymongo' } = {}) {
    const id = `RDM${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
    await pool.query(
        `INSERT INTO coupon_redemptions (id, code, payment_reference, email, base_amount, discount_amount, currency, status, is_test, source)
         VALUES ($1,$2,$3,$4,100,10,'PHP',$5,$6,$7)`,
        [id, code, `ref_${id}`, who, status, isTest, source]
    );
}
const quote = (code, who) => couponStore.validateCouponReadOnly({ code, productId: PRODUCT_ID, email: who });
const cleanupRedemptions = (...codes) => pool.query('DELETE FROM coupon_redemptions WHERE code = ANY($1)', [codes]);

// ---------- general coupons ----------

test('a new general coupon defaults to 1 use per customer; an update that omits the field keeps the stored value', async () => {
    const code = await createTestCoupon({ type: 'general' });
    try {
        assert.equal((await couponStore.findCoupon(code)).maxRedemptionsPerCustomer, 1);
        await couponStore.upsertCoupon({ code, discountPercent: 0.2, maxRedemptionsPerCustomer: 4 });
        await couponStore.upsertCoupon({ code, discountPercent: 0.3 });
        assert.equal((await couponStore.findCoupon(code)).maxRedemptionsPerCustomer, 4, 'omitted field must not reset the admin value');
        await couponStore.upsertCoupon({ code, discountPercent: 0.3, maxRedemptionsPerCustomer: null });
        assert.equal((await couponStore.findCoupon(code)).maxRedemptionsPerCustomer, null);
    } finally {
        await cleanupCoupon(code);
    }
});

test('limit 1: the second use is rejected with the "already used" copy', async () => {
    const code = await createTestCoupon({ type: 'general' });
    const who = email();
    try {
        assert.ok((await quote(code, who)).coupon);
        await insertRedemption(code, who);
        const res = await quote(code, who);
        assert.equal(res.reason, 'coupon_already_used');
        assert.equal(res.error, 'You have already used this coupon.');
        assert.ok((await quote(code, email())).coupon, 'a different customer is unaffected');
    } finally {
        await cleanupRedemptions(code);
        await cleanupCoupon(code);
    }
});

test('limit 2: a second use is allowed, a third is rejected with the "reached the limit" copy (case-insensitive email)', async () => {
    const code = await createTestCoupon({ type: 'general', maxRedemptionsPerCustomer: 2 });
    const who = email();
    try {
        await insertRedemption(code, who.toUpperCase());
        assert.ok((await quote(code, who)).coupon, 'second use allowed');
        await insertRedemption(code, who);
        const res = await quote(code, who);
        assert.equal(res.reason, 'coupon_already_used');
        assert.equal(res.error, 'You have reached the limit for this coupon.');
    } finally {
        await cleanupRedemptions(code);
        await cleanupCoupon(code);
    }
});

test('NULL per-customer limit is unlimited', async () => {
    const code = await createTestCoupon({ type: 'general', maxRedemptionsPerCustomer: null });
    const who = email();
    try {
        for (let i = 0; i < 5; i++) await insertRedemption(code, who);
        assert.ok((await quote(code, who)).coupon);
    } finally {
        await cleanupRedemptions(code);
        await cleanupCoupon(code);
    }
});

test('test redemptions and pending holds do not count; GHL-imported paid ones (even refunded status aside) do', async () => {
    const code = await createTestCoupon({ type: 'general', maxRedemptionsPerCustomer: 1 });
    const who = email();
    try {
        await insertRedemption(code, who, { isTest: true });
        await insertRedemption(code, who, { status: 'pending' });
        assert.ok((await quote(code, who)).coupon, 'test + pending rows must not count');

        await couponStore.insertGhlRedemption({ orderId: `ord_${Date.now()}`, code, email: who, baseAmount: 100, discountAmount: 10 });
        const res = await quote(code, who);
        assert.equal(res.reason, 'coupon_already_used', 'imported paid GHL order counts');
    } finally {
        await cleanupRedemptions(code);
        await cleanupCoupon(code);
    }
});

test('the per-customer limit is counted per code, not across codes', async () => {
    const a = await createTestCoupon({ type: 'general' });
    const b = await createTestCoupon({ type: 'general' });
    const who = email();
    try {
        await insertRedemption(a, who);
        assert.equal((await quote(a, who)).reason, 'coupon_already_used');
        assert.ok((await quote(b, who)).coupon);
    } finally {
        await cleanupRedemptions(a, b);
        await cleanupCoupon(a);
        await cleanupCoupon(b);
    }
});

test('the reservation (checkout) path enforces the same limit', async () => {
    const code = await createTestCoupon({ type: 'general', maxRedemptionsPerCustomer: 2 });
    const who = email();
    try {
        await insertRedemption(code, who);
        await insertRedemption(code, who);
        const res = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: who });
        assert.equal(res.reason, 'coupon_already_used');
        assert.equal(res.error, 'You have reached the limit for this coupon.');
    } finally {
        await cleanupRedemptions(code);
        await cleanupCoupon(code);
    }
});

// ---------- affiliate coupons (global setting) ----------

const withAffiliateLimit = (value) => { couponSettings.getAffiliateDiscountsPerCustomer = async () => value; };

test('affiliate setting 1 (default): a second affiliate code is rejected with the original copy', async () => {
    const a = await createTestCoupon({ type: 'affiliate' });
    const b = await createTestCoupon({ type: 'affiliate' });
    const who = email();
    try {
        withAffiliateLimit(1);
        await insertRedemption(a, who);
        const res = await quote(b, who);
        assert.equal(res.reason, 'affiliate_already_used');
        assert.equal(res.error, 'You have already used an affiliate discount.');
    } finally {
        await cleanupRedemptions(a, b);
        await cleanupCoupon(a);
        await cleanupCoupon(b);
    }
});

test('affiliate setting 2: counted across codes - two uses allowed, third rejected', async () => {
    const a = await createTestCoupon({ type: 'affiliate' });
    const b = await createTestCoupon({ type: 'affiliate' });
    const c = await createTestCoupon({ type: 'affiliate' });
    const who = email();
    try {
        withAffiliateLimit(2);
        await insertRedemption(a, who);
        assert.ok((await quote(b, who)).coupon);
        await insertRedemption(b, who);
        const res = await quote(c, who);
        assert.equal(res.reason, 'affiliate_already_used');
        assert.equal(res.error, 'You have reached the limit for affiliate discounts.');
        // test rows never count
        const other = email();
        await insertRedemption(a, other, { isTest: true });
        await insertRedemption(b, other, { isTest: true });
        assert.ok((await quote(c, other)).coupon);
    } finally {
        await cleanupRedemptions(a, b, c);
        await cleanupCoupon(a);
        await cleanupCoupon(b);
        await cleanupCoupon(c);
    }
});

test('affiliate setting unlimited (null): never rejects', async () => {
    const a = await createTestCoupon({ type: 'affiliate' });
    const who = email();
    try {
        withAffiliateLimit(null);
        for (let i = 0; i < 3; i++) await insertRedemption(a, who);
        assert.ok((await quote(a, who)).coupon);
    } finally {
        await cleanupRedemptions(a);
        await cleanupCoupon(a);
    }
});

test('affiliate coupons ignore maxRedemptionsPerCustomer (stored NULL)', async () => {
    const code = await createTestCoupon({ type: 'affiliate', maxRedemptionsPerCustomer: 3 });
    try {
        assert.equal((await couponStore.findCoupon(code)).maxRedemptionsPerCustomer, null);
    } finally {
        await cleanupCoupon(code);
    }
});

// ---------- global setting storage + settings API ----------

test('settings API: affiliateDiscountsPerCustomer defaults to 1, validates, saves and clears to unlimited', async () => {
    try {
        await pool.query(`DELETE FROM app_settings WHERE key = $1`, [couponSettings.AFFILIATE_LIMIT_KEY]);
        ghlService.getTrackedLocations = () => [];
        assert.equal((await admin(request(app).get('/api/admin/settings'))).body.settings.affiliateDiscountsPerCustomer, 1);

        for (const bad of [0, -1, 1.5, 'abc']) {
            const res = await admin(request(app).put('/api/admin/settings')).send({ affiliateDiscountsPerCustomer: bad });
            assert.equal(res.status, 400, `expected 400 for ${bad}`);
        }
        // A bad affiliate value must not leave a partial save of the legal links.
        const partial = await admin(request(app).put('/api/admin/settings')).send({ termsUrl: 'https://partial.example.com/t', affiliateDiscountsPerCustomer: 0 });
        assert.equal(partial.status, 400);
        assert.notEqual((await admin(request(app).get('/api/admin/settings'))).body.settings.termsUrl, 'https://partial.example.com/t');

        const three = await admin(request(app).put('/api/admin/settings')).send({ affiliateDiscountsPerCustomer: '3' });
        assert.equal(three.body.settings.affiliateDiscountsPerCustomer, 3);
        const unlimited = await admin(request(app).put('/api/admin/settings')).send({ affiliateDiscountsPerCustomer: '' });
        assert.equal(unlimited.body.settings.affiliateDiscountsPerCustomer, null);
        const one = await admin(request(app).put('/api/admin/settings')).send({ affiliateDiscountsPerCustomer: 1 });
        assert.equal(one.body.settings.affiliateDiscountsPerCustomer, 1);
        // an unrelated update leaves it alone
        const legal = await admin(request(app).put('/api/admin/settings')).send({});
        assert.equal(legal.body.settings.affiliateDiscountsPerCustomer, 1);
    } finally {
        await pool.query(`DELETE FROM app_settings WHERE key = $1`, [couponSettings.AFFILIATE_LIMIT_KEY]);
    }
});

// ---------- admin coupon API validation ----------

test('coupon API: maxRedemptionsPerCustomer validation, default, blank = unlimited, affiliate ignores it', async () => {
    const code = `PCL${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const aff = await createTestCoupon({ type: 'affiliate' });
    try {
        const body = { code, discountPercent: 0.1 };
        for (const bad of [0, -2, 1.5, 'abc']) {
            const res = await admin(request(app).post('/api/admin/coupons')).send({ ...body, maxRedemptionsPerCustomer: bad });
            assert.equal(res.status, 400, `expected 400 for ${bad}`);
        }
        const created = await admin(request(app).post('/api/admin/coupons')).send(body);
        assert.equal(created.body.coupon.maxRedemptionsPerCustomer, 1, 'default 1');
        const set = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: '3' });
        assert.equal(set.body.coupon.maxRedemptionsPerCustomer, 3);
        const kept = await admin(request(app).put(`/api/admin/coupons/${code}`)).send(body);
        assert.equal(kept.body.coupon.maxRedemptionsPerCustomer, 3, 'omitted keeps value');
        const blank = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: '' });
        assert.equal(blank.body.coupon.maxRedemptionsPerCustomer, null);
        const nul = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: 2 });
        assert.equal(nul.body.coupon.maxRedemptionsPerCustomer, 2);
        const none = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: null });
        assert.equal(none.body.coupon.maxRedemptionsPerCustomer, null);

        ghlService.getTrackedLocations = () => [];
        const affRes = await admin(request(app).put(`/api/admin/coupons/${aff}`)).send({ code: aff, discountPercent: 0.1, maxRedemptionsPerCustomer: 5 });
        assert.equal(affRes.body.coupon.maxRedemptionsPerCustomer, null);
    } finally {
        await cleanupCoupon(code);
        await cleanupCoupon(aff);
    }
});

// ---------- GHL mapping, drift and pushes ----------

test('limitPerCustomerFor: limit 1 -> true; >1 or unlimited -> false; affiliate follows ghlLimitPerCustomer; legacy default true', () => {
    assert.equal(ghlService.limitPerCustomerFor({ type: 'general', maxRedemptionsPerCustomer: 1 }), true);
    assert.equal(ghlService.limitPerCustomerFor({ type: 'general', maxRedemptionsPerCustomer: 2 }), false);
    assert.equal(ghlService.limitPerCustomerFor({ type: 'general', maxRedemptionsPerCustomer: null }), false);
    assert.equal(ghlService.limitPerCustomerFor({ type: 'affiliate', maxRedemptionsPerCustomer: null }), true);
    assert.equal(ghlService.limitPerCustomerFor({ type: 'affiliate', ghlLimitPerCustomer: false }), false);
    assert.equal(ghlService.limitPerCustomerFor({ code: 'X' }), true);
});

test('create/update payloads carry the mapped limitPerCustomer', () => {
    const base = { code: 'MAP1', discountPercent: 0.1, type: 'general' };
    assert.equal(ghlService.buildCouponPayload({ ...base, maxRedemptionsPerCustomer: 1 }, 'loc').limitPerCustomer, true);
    assert.equal(ghlService.buildCouponPayload({ ...base, maxRedemptionsPerCustomer: 3 }, 'loc').limitPerCustomer, false);
    assert.equal(ghlService.buildCouponUpdatePayload({ id: 'g1' }, { ...base, maxRedemptionsPerCustomer: null }, 'loc').limitPerCustomer, false);
    assert.equal(ghlService.buildCouponUpdatePayload({ id: 'g1' }, { ...base, type: 'affiliate', ghlLimitPerCustomer: false }, 'loc').limitPerCustomer, false);
});

test('couponNeedsUpdate detects limitPerCustomer drift in both directions', () => {
    const existing = (limitPerCustomer) => ({ discountValue: 10, applyToFuturePayments: false, limitPerCustomer, usageLimit: null, endDate: null });
    const general = (n) => ({ type: 'general', discountPercent: 0.1, maxRedemptionsPerCustomer: n });
    assert.equal(ghlService.couponNeedsUpdate(existing(true), general(1)), false);
    assert.equal(ghlService.couponNeedsUpdate(existing(false), general(1)), true);
    assert.equal(ghlService.couponNeedsUpdate(existing(true), general(null)), true);
    assert.equal(ghlService.couponNeedsUpdate(existing(0), general(5)), false);
    const aff = (flag) => ({ type: 'affiliate', discountPercent: 0.1, ghlLimitPerCustomer: flag });
    assert.equal(ghlService.couponNeedsUpdate(existing(true), aff(false)), true);
    assert.equal(ghlService.couponNeedsUpdate(existing(false), aff(true)), true);
    assert.equal(ghlService.couponNeedsUpdate(existing(false), aff(false)), false);
});

test('pushing a local affiliate coupon uses the global setting: true at 1, false otherwise', async () => {
    const code = await createTestCoupon({ type: 'affiliate' });
    try {
        const created = [];
        ghlService.getTrackedLocations = () => [{ key: 'global', name: 'G', locationId: 'loc_g', privateKey: 'k' }];
        ghlService.listCouponsForLocation = async () => ({ coupons: [] });
        ghlService.createCouponForLocation = async (loc, coupon) => { created.push(ghlService.buildCouponPayload(coupon, loc.locationId).limitPerCustomer); return { id: 'x' }; };
        const coupon = await couponStore.findCoupon(code);
        for (const setting of [1, 2, null]) {
            withAffiliateLimit(setting);
            await ghlCouponPush.pushCoupon(coupon);
        }
        assert.deepEqual(created, [true, false, false]);
    } finally {
        await cleanupCoupon(code);
    }
});

test('changing the affiliate setting re-pushes drifted affiliate coupons, non-fatally', async () => {
    const code = await createTestCoupon({ type: 'affiliate' });
    try {
        const updates = [];
        ghlService.getTrackedLocations = () => [{ key: 'global', name: 'G', locationId: 'loc_g', privateKey: 'k' }];
        ghlService.listCouponsForLocation = async () => ({
            coupons: [{ id: 'g1', code, discountValue: 15, applyToFuturePayments: false, limitPerCustomer: true, usageLimit: null, endDate: null }]
        });
        ghlService.updateCouponForLocation = async (loc, existing, coupon) => { updates.push(ghlService.buildCouponUpdatePayload(existing, coupon, loc.locationId).limitPerCustomer); return { id: 'g1' }; };
        withAffiliateLimit(null);
        await ghlCouponPush.pushAllAffiliateCouponsSafe();
        assert.deepEqual(updates, [false]);

        ghlService.listCouponsForLocation = async () => { throw new Error('GHL down'); };
        await assert.doesNotReject(ghlCouponPush.pushAllAffiliateCouponsSafe());
    } finally {
        await cleanupCoupon(code);
    }
});

test('GHL-origin general coupon: admin changing the limit pushes limitPerCustomer only (other fields preserved); unchanged saves push nothing; GHL failure never fails the save', async () => {
    const code = `GHO${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    try {
        await couponStore.upsertCoupon({ code, type: 'general', discountPercent: 0.2, origin: 'ghl', localEnabled: false, maxRedemptionsPerCustomer: 1 });
        const pushes = [];
        const ghlCoupon = { id: 'g9', code, discountValue: 20, limitPerCustomer: true, productIds: ['p1'], endDate: null };
        ghlService.getTrackedLocations = () => [{ key: 'global', name: 'G', locationId: 'loc_g', privateKey: 'k' }];
        ghlService.listCouponsForLocation = async () => ({ coupons: [ghlCoupon] });
        ghlService.updateCouponProductRestriction = async (loc, existing, productIds, opts) => { pushes.push({ productIds, opts }); };
        const body = { code, discountPercent: 0.2 };

        const same = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: 1 });
        assert.equal(same.status, 200);
        assert.equal(pushes.length, 0, 'unchanged value pushes nothing');

        const changed = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: null });
        assert.equal(changed.status, 200);
        assert.deepEqual(pushes, [{ productIds: ['p1'], opts: { limitPerCustomer: false } }]);

        ghlService.updateCouponProductRestriction = async () => { throw new Error('GHL down'); };
        const failing = await admin(request(app).put(`/api/admin/coupons/${code}`)).send({ ...body, maxRedemptionsPerCustomer: 1 });
        assert.equal(failing.status, 200);
        assert.equal(failing.body.coupon.maxRedemptionsPerCustomer, 1);
    } finally {
        await cleanupCoupon(code);
    }
});

test('buildProductRestrictionPayload only changes limitPerCustomer when asked', () => {
    const existing = { id: 'g', name: 'N', code: 'C', discountType: 'percentage', discountValue: 10, limitPerCustomer: true, usageLimit: 5 };
    assert.equal(ghlService.buildProductRestrictionPayload(existing, [], { locationId: 'l' }).limitPerCustomer, true);
    const changed = ghlService.buildProductRestrictionPayload(existing, [], { locationId: 'l', limitPerCustomer: false });
    assert.equal(changed.limitPerCustomer, false);
    assert.equal(changed.usageLimit, 5);
});

// ---------- GHL-origin default / backfill / import ----------

test('import plan maps GHL limitPerCustomer: true -> 1, false/missing -> unlimited, and records it in meta', () => {
    const mk = (code, limitPerCustomer) => ({ code, discountType: 'percentage', discountValue: 10, locationId: 'l1', locationName: 'L1', limitPerCustomer });
    const plan = buildImportPlan({ ghlCoupons: [mk('AAA', true), mk('BBB', false), mk('CCC', undefined), mk('DDD', 1)], localCodes: new Set() });
    const by = Object.fromEntries(plan.toImport.map((c) => [c.code, c]));
    assert.equal(by.AAA.maxRedemptionsPerCustomer, 1);
    assert.equal(by.BBB.maxRedemptionsPerCustomer, null);
    assert.equal(by.CCC.maxRedemptionsPerCustomer, null);
    assert.equal(by.DDD.maxRedemptionsPerCustomer, 1);
    assert.equal(by.AAA.ghlCouponMeta.limitPerCustomer, true);
});

test('createGhlDiscoveredCoupon (order import) sets 1 when GHL limits per customer, else unlimited', async () => {
    const on = `GDO${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const off = `GDF${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    try {
        await couponStore.createGhlDiscoveredCoupon({ code: on, discountPercent: 0.1, locationId: 'l', limitPerCustomer: true });
        await couponStore.createGhlDiscoveredCoupon({ code: off, discountPercent: 0.1, locationId: 'l' });
        assert.equal((await couponStore.findCoupon(on)).maxRedemptionsPerCustomer, 1);
        assert.equal((await couponStore.findCoupon(off)).maxRedemptionsPerCustomer, null);
    } finally {
        await cleanupCoupon(on);
        await cleanupCoupon(off);
    }
});

test('schema migration block: backfills once (local general = 1, GHL by stored limitPerCustomer) and re-running never resets an admin value', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const at = schema.indexOf('ADD COLUMN max_redemptions_per_customer');
    const block = schema.slice(schema.lastIndexOf('DO $$', at), schema.indexOf('END $$;', at) + 'END $$;'.length);
    const client = await pool.connect();
    try {
        await client.query('DROP SCHEMA IF EXISTS bf_test CASCADE');
        await client.query('CREATE SCHEMA bf_test');
        await client.query('SET search_path TO bf_test');
        await client.query(`CREATE TABLE coupons (code TEXT PRIMARY KEY, type TEXT NOT NULL, origin TEXT NOT NULL, ghl_coupon_meta JSONB)`);
        await client.query(`INSERT INTO coupons VALUES
            ('LOCAL_GEN','general','local',NULL), ('LOCAL_AFF','affiliate','local',NULL),
            ('GHL_TRUE','general','local','{"limitPerCustomer": true}'), ('GHL_FALSE','general','local','{"limitPerCustomer": false}'),
            ('GHL_NOMETA','general','local','{"productIds": []}'), ('GHL_ORIGIN','general','ghl',NULL)`);
        await client.query(block);
        const read = async () => Object.fromEntries((await client.query('SELECT code, max_redemptions_per_customer AS n FROM coupons')).rows.map((r) => [r.code, r.n]));
        assert.deepEqual(await read(), {
            LOCAL_GEN: 1, LOCAL_AFF: null, GHL_TRUE: 1, GHL_FALSE: null, GHL_NOMETA: null, GHL_ORIGIN: null
        });
        await client.query(`UPDATE coupons SET max_redemptions_per_customer = 7 WHERE code = 'LOCAL_GEN'`);
        await client.query(`UPDATE coupons SET max_redemptions_per_customer = NULL WHERE code = 'GHL_TRUE'`);
        await client.query(block);
        const again = await read();
        assert.equal(again.LOCAL_GEN, 7);
        assert.equal(again.GHL_TRUE, null);
        await assert.rejects(client.query(`UPDATE coupons SET max_redemptions_per_customer = 0 WHERE code = 'LOCAL_GEN'`));
    } finally {
        await client.query('SET search_path TO public').catch(() => {});
        await client.query('DROP SCHEMA IF EXISTS bf_test CASCADE').catch(() => {});
        client.release();
    }
});
