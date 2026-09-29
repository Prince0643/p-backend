require('./setupEnv');
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const { pushCoupon, retryPendingPushes } = require('../services/ghlCouponPush');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate, signWebhookBody, paymentEventPayload } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const LOCS = [
    { key: 'global', name: 'Global', locationId: 'loc_g', privateKey: 'k1' },
    { key: 'main', name: 'Main', locationId: 'loc_m', privateKey: 'k2' }
];
const names = ['getTrackedLocations', 'listCouponsForLocation', 'createCouponForLocation', 'updateCouponForLocation', 'resolveGlobalLocation', 'resolveMainLocation', 'createClient'];
const originals = Object.fromEntries(names.map((n) => [n, ghlService[n]]));
afterEach(() => Object.assign(ghlService, originals));
after(async () => {
    await pool.end();
});


/** Makes a recorded push attempt look old enough for the retry to pick it up. */
async function backdateSync(code) {
    await pool.query(
        `UPDATE coupons SET ghl_sync = (SELECT jsonb_object_agg(k, jsonb_set(v, '{at}', to_jsonb(to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))) FROM jsonb_each(ghl_sync) AS t(k, v)) WHERE code = $1`,
        [code]
    );
}

/** In-memory fake of GHL coupons per location id; `failCreateAt` makes creates at that location throw. */
function fakeGhl({ existing = {}, failCreateAt = null } = {}) {
    const store = { loc_g: [...(existing.loc_g || [])], loc_m: [...(existing.loc_m || [])] };
    const calls = { create: [], update: [] };
    ghlService.getTrackedLocations = () => LOCS;
    ghlService.listCouponsForLocation = async (location) => ({ coupons: store[location.locationId] });
    ghlService.createCouponForLocation = async (location, coupon) => {
        if (failCreateAt === location.locationId) throw new Error('GHL down');
        calls.create.push({ locationId: location.locationId, code: coupon.code, name: coupon.name, discountPercent: coupon.discountPercent });
        const created = { id: `id_${location.locationId}_${coupon.code}`, code: coupon.code, status: 'active', discountValue: 15, applyToFuturePayments: false, limitPerCustomer: true };
        store[location.locationId].push(created);
        return created;
    };
    ghlService.updateCouponForLocation = async (location, existingCoupon, coupon) => {
        calls.update.push({ locationId: location.locationId, code: coupon.code });
        return { id: existingCoupon.id };
    };
    return { store, calls };
}

const register = (email) => request(app).post('/api/affiliates/register').send({
    firstName: 'Push', lastName: 'Test', email, password: 'testpassword123', contactNumber: '+639171234567',
    paymentRegion: 'GLOBAL', preferredBank: 'WISE', globalAccountName: 'P T', globalAccountEmail: email, termsAccepted: true
});

test('registration pushes the affiliate coupon to GLOBAL and MAIN and records per-location sync state', async () => {
    const email = `push.reg.${Date.now()}@example.com`;
    const { calls } = fakeGhl();
    try {
        const res = await register(email);
        assert.equal(res.status, 201);
        assert.deepEqual(calls.create.map((c) => c.locationId).sort(), ['loc_g', 'loc_m']);
        assert.equal(calls.create[0].name, 'Push Test Affiliate');
        assert.equal(calls.create[0].discountPercent, 0.15);
        assert.equal(res.body.ghlCouponId, `id_loc_m_${res.body.couponCode}`);

        const coupon = await couponStore.findCoupon(res.body.couponCode);
        assert.equal(coupon.ghlSync.global.status, 'synced');
        assert.equal(coupon.ghlSync.main.status, 'synced');
        assert.equal(coupon.ghlSync.main.ghlCouponId, `id_loc_m_${res.body.couponCode}`);
    } finally {
        await cleanupAffiliate(email);
    }
});

test('a failed push never breaks registration, is recorded, and can be retried', async () => {
    const email = `push.retry.${Date.now()}@example.com`;
    const fake = fakeGhl({ failCreateAt: 'loc_m' });
    try {
        const res = await register(email);
        assert.equal(res.status, 201);
        let coupon = await couponStore.findCoupon(res.body.couponCode);
        assert.equal(coupon.ghlSync.global.status, 'synced');
        assert.equal(coupon.ghlSync.main.status, 'error');
        assert.match(coupon.ghlSync.main.error, /GHL down/);

        // GHL recovers; a retry fixes it.
        ghlService.createCouponForLocation = async (location, c) => {
            const created = { id: `retry_${location.locationId}`, code: c.code, status: 'active', discountValue: 15, applyToFuturePayments: false, limitPerCustomer: true };
            fake.store[location.locationId].push(created);
            return created;
        };
        // (Assertions are scoped to this coupon: test files share one database and run in
        // parallel, so the retry may also pick up other files' pending coupons.)
        // A fresh attempt is not retried (it may still be in flight)...
        await retryPendingPushes();
        assert.equal((await couponStore.findCoupon(res.body.couponCode)).ghlSync.main.status, 'error');
        await backdateSync(res.body.couponCode);
        await retryPendingPushes();
        coupon = await couponStore.findCoupon(res.body.couponCode);
        assert.equal(coupon.ghlSync.main.status, 'synced');
    } finally {
        await cleanupAffiliate(email);
    }
});

test('admin update of an affiliate coupon pushes to GHL; existing drifted coupons are updated, not duplicated', async () => {
    const email = `push.admin.${Date.now()}@example.com`;
    const fake = fakeGhl();
    try {
        const reg = await register(email);
        fake.calls.create.length = 0;
        // Present in GHL with a stale discount -> update, not create.
        fake.store.loc_g.find((c) => c.code === reg.body.couponCode).discountValue = 5;

        const res = await request(app).put(`/api/admin/coupons/${reg.body.couponCode}`).set('x-api-key', ADMIN_KEY)
            .send({ discountPercent: 0.15, affiliateFeePercent: 0.1, affiliateEmail: email, active: true });
        assert.equal(res.status, 200);
        assert.equal(fake.calls.create.length, 0);
        assert.deepEqual(fake.calls.update.map((c) => c.locationId), ['loc_g']);
    } finally {
        await cleanupAffiliate(email);
    }
});

test('an admin cannot smuggle origin=ghl in through the coupon upsert body', async () => {
    const code = `NOORIGIN${Date.now().toString(36).toUpperCase()}`;
    try {
        const res = await request(app).post('/api/admin/coupons').set('x-api-key', ADMIN_KEY).send({ code, discountPercent: 0.1, origin: 'ghl' });
        assert.equal(res.status, 200);
        assert.equal(res.body.coupon.origin, 'local');
    } finally {
        await cleanupCoupon(code);
    }
});

test('GHL-origin coupons are never pushed or synced back to GHL', async () => {
    const code = `GHLNEVER${Date.now().toString(36).toUpperCase()}`;
    const fake = fakeGhl();
    await couponStore.upsertCoupon({ code, type: 'affiliate', affiliateEmail: 'x@example.com', discountPercent: 0.2, origin: 'ghl', localEnabled: false });
    try {
        const coupon = await couponStore.findCoupon(code);
        const outcome = await pushCoupon(coupon);
        assert.equal(outcome.skipped, 'ghl_origin');

        // The pre-existing multi-location sync path must skip them too.
        ghlService.getConfiguredLocations = () => LOCS;
        try {
            const result = await ghlService.syncCouponsToGhlLocations([coupon], { dryRun: false });
            assert.equal(result.results.length, 0);
        } finally {
            delete ghlService.getConfiguredLocations; // fall back to the prototype method
        }
        assert.equal(fake.calls.create.length + fake.calls.update.length, 0);

        // Editing it through the admin upsert must not push either, nor drop its affiliate link.
        const res = await request(app).put(`/api/admin/coupons/${code}`).set('x-api-key', ADMIN_KEY).send({ discountPercent: 0.25, notes: 'edited' });
        assert.equal(res.status, 200);
        assert.equal(res.body.coupon.origin, 'ghl');
        assert.equal(res.body.coupon.affiliateEmail, 'x@example.com');
        assert.equal(fake.calls.create.length + fake.calls.update.length, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('pushCoupon dry-run and updateExisting:false never write; present coupons are reported as existing', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'dry@example.com' });
    const fake = fakeGhl({ existing: { loc_g: [{ id: 'gx', code, status: 'active', discountValue: 1 }] } });
    try {
        const coupon = await couponStore.findCoupon(code);
        const dry = await pushCoupon(coupon, { dryRun: true, updateExisting: false });
        assert.deepEqual(dry.results.map((r) => r.action), ['exists', 'would_create']);
        assert.equal(fake.calls.create.length, 0);
        assert.equal((await couponStore.findCoupon(code)).ghlSync, null);

        const applied = await pushCoupon(coupon, { updateExisting: false });
        assert.deepEqual(applied.results.map((r) => r.action), ['exists', 'created']);
        assert.equal(fake.calls.update.length, 0);
        assert.deepEqual(fake.calls.create.map((c) => c.locationId), ['loc_m']);
    } finally {
        await cleanupCoupon(code);
    }
});

test('retryPendingPushes ignores coupons that were never attempted or are already synced', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'never@example.com' });
    fakeGhl();
    try {
        const before = await retryPendingPushes();
        assert.equal((await couponStore.findCoupon(code)).ghlSync, null);
        assert.equal(before.failed, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('local PayMongo commission is on the post-discount, pre-tax base and commission_base is stored (webhook fallback path)', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'local.aff@example.com', affiliateFeePercent: 0.10 });
    const paymentReference = `PAYCOMM${Date.now()}`;
    try {
        // metadata.baseAmount is what createPaymentIntent stores: catalog 500 - 75 discount = 425 (pre-tax).
        const { body, header } = signWebhookBody(paymentEventPayload('payment.paid', {
            paymentReference, promoCode: code, baseAmount: '425', discountAmount: '75',
            email: 'buyer@example.com', fullName: 'Buyer', productId: 'test_product'
        }));
        const res = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(body);
        assert.equal(res.status, 200);
        const { rows } = await pool.query('SELECT commission_base, affiliate_fee_amount, campaign_id FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        assert.equal(Number(rows[0].commission_base), 425);
        assert.equal(Number(rows[0].affiliate_fee_amount), 42.5);
        assert.equal(rows[0].campaign_id, null);
    } finally {
        await cleanupCoupon(code);
    }
});
