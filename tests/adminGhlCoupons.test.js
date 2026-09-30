require('./setupEnv');
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const LOCS = [
    { key: 'global', name: 'Global', locationId: 'loc_g', privateKey: 'k1' },
    { key: 'main', name: 'Main', locationId: 'loc_m', privateKey: 'k2' }
];

const originals = {
    getTrackedLocations: ghlService.getTrackedLocations,
    listCouponsForLocation: ghlService.listCouponsForLocation,
    createCouponForLocation: ghlService.createCouponForLocation
};
afterEach(() => {
    Object.assign(ghlService, originals);
});
after(async () => {
    await pool.end();
});

const admin = (req) => req.set('x-api-key', ADMIN_KEY);

function stubGhl(couponsByLocationId, failIds = []) {
    ghlService.getTrackedLocations = () => LOCS;
    ghlService.createCouponForLocation = async () => ({ id: 'stub_created' });
    ghlService.listCouponsForLocation = async (location) => {
        if (failIds.includes(location.locationId)) throw new Error('token rejected');
        return { coupons: (couponsByLocationId[location.locationId] || []).map((c) => ({ id: c.id, code: c.code, status: 'active', discountType: c.discountType || 'percentage', discountValue: c.discountValue ?? 0 })) };
    };
}

async function registerAffiliate(email) {
    const res = await request(app).post('/api/affiliates/register').send({
        firstName: 'Assign', lastName: 'Target', email, password: 'testpassword123', contactNumber: '+639171234567',
        paymentRegion: 'GLOBAL', preferredBank: 'WISE', globalAccountName: 'A T', globalAccountEmail: email, termsAccepted: true
    });
    assert.equal(res.status, 201);
    return res.body;
}

async function ghlCoupon(code, overrides = {}) {
    await couponStore.upsertCoupon({
        code, type: 'general', discountPercent: 0.2, origin: 'ghl', localEnabled: false, ghlLocationIds: ['loc_g'], ...overrides
    });
}

let orderSeq = 0;
async function ghlRedemption(code, { subtotal = 100, discount = 20, currency = 'USD', locationId = 'loc_g', isTest = false } = {}) {
    orderSeq += 1;
    return couponStore.insertGhlRedemption({
        orderId: `adm_${Date.now()}_${orderSeq}`, code, email: `b${orderSeq}@example.com`, fullName: 'Buyer',
        baseAmount: subtotal, discountAmount: discount, commissionBase: subtotal - discount,
        affiliateFeeAmount: 0, affiliateEmail: null, currency, ghlLocationId: locationId, isTest
    });
}

test('ghl-coupons endpoints require admin auth', async () => {
    assert.equal((await request(app).get('/api/admin/ghl-coupons')).status, 401);
    assert.equal((await request(app).post('/api/admin/ghl-coupons/X/assign').send({})).status, 401);
    assert.equal((await request(app).get('/api/admin/coupons/X/usage')).status, 401);
});

test('GET /ghl-coupons merges live GHL lists with DB coupons and reports a failing location as an error string', async () => {
    const code = `GHLLIST${Date.now().toString(36).toUpperCase()}`;
    const localCode = await createTestCoupon({ type: 'general' }); // in GHL main, origin local
    const absentCode = await createTestCoupon({ type: 'general' }); // no GHL presence: excluded
    await ghlCoupon(code);
    await ghlRedemption(code);
    await ghlRedemption(code);
    await ghlRedemption(code, { isTest: true }); // test-mode rows never count as usage
    stubGhl({ loc_g: [{ id: 'g1', code }], loc_m: [{ id: 'm1', code: localCode }] }, []);

    try {
        let res = await admin(request(app).get('/api/admin/ghl-coupons'));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.errors, []);
        const item = res.body.coupons.find((c) => c.code === code);
        assert.equal(item.origin, 'ghl');
        assert.equal(item.type, 'general');
        assert.equal(item.discountPercent, 0.2);
        assert.equal(item.affiliate, null);
        assert.deepEqual(item.usage, { paidCount: 2, unassignedCount: 2 });
        assert.deepEqual(item.locations, [
            { key: 'global', locationId: 'loc_g', ghlCouponId: 'g1', status: 'active' },
            { key: 'main', locationId: 'loc_m', ghlCouponId: null, status: 'missing' }
        ]);
        const local = res.body.coupons.find((c) => c.code === localCode);
        assert.equal(local.origin, 'local');
        assert.equal(local.locations[1].ghlCouponId, 'm1');
        assert.equal(res.body.coupons.some((c) => c.code === absentCode), false);

        stubGhl({ loc_g: [{ id: 'g1', code }] }, ['loc_m']);
        res = await admin(request(app).get('/api/admin/ghl-coupons'));
        assert.equal(res.status, 200);
        assert.equal(res.body.errors.length, 1);
        assert.match(res.body.errors[0], /main.*token rejected/);
        assert.equal(res.body.coupons.find((c) => c.code === code).locations[1].status, 'unknown');
    } finally {
        await cleanupCoupon(code);
        await cleanupCoupon(localCode);
        await cleanupCoupon(absentCode);
    }
});

test('assign -> credit-past math, idempotency, and unassign rules', async () => {
    const email = `assign.${Date.now()}@example.com`;
    const code = `GHLASSIGN${Date.now().toString(36).toUpperCase()}`;
    await ghlCoupon(code);
    stubGhl({});
    const r1 = await ghlRedemption(code, { subtotal: 100, discount: 20 }); // commission_base 80
    const r2 = await ghlRedemption(code, { subtotal: 200, discount: 50, currency: 'PHP' }); // commission_base 150

    try {
        await registerAffiliate(email);

        // Error cases
        assert.equal((await admin(request(app).post('/api/admin/ghl-coupons/NOPE_UNKNOWN/assign').send({ affiliateEmail: email }))).status, 404);
        assert.equal((await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: 'nobody@example.com' }))).status, 400);
        assert.equal((await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email, affiliateFeePercent: 5 }))).status, 400);
        // credit-past before any assignment -> 409
        assert.equal((await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({}))).status, 409);

        // Assign with the default fee (the registration rate, 10%)
        let res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email }));
        assert.equal(res.status, 200);
        assert.equal(res.body.coupon.type, 'affiliate');
        assert.equal(res.body.coupon.affiliate.email, email);
        assert.equal(res.body.coupon.origin, 'ghl');
        assert.equal(res.body.creditable.length, 2);
        assert.deepEqual(res.body.creditable.map((r) => r.id).sort(), [r1.id, r2.id].sort());
        assert.equal((await couponStore.findCoupon(code)).affiliateFeePercent, 0.1);

        // Credit just one
        res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({ redemptionIds: [r1.id] }));
        assert.equal(res.status, 200);
        assert.equal(res.body.credited, 1);
        assert.deepEqual(res.body.totalsByCurrency, { USD: { commission: 8 } }); // 80 * 10%

        // Credit the rest (omit ids = all creditable); already-credited row is untouched
        res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({}));
        assert.equal(res.body.credited, 1);
        assert.deepEqual(res.body.totalsByCurrency, { PHP: { commission: 15 } }); // 150 * 10%

        res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({}));
        assert.equal(res.body.credited, 0);
        assert.deepEqual(res.body.totalsByCurrency, {});

        const { rows } = await pool.query('SELECT id, affiliate_email, affiliate_fee_amount FROM coupon_redemptions WHERE code = $1', [code]);
        assert.ok(rows.every((r) => r.affiliate_email === email));
        assert.equal(Number(rows.find((r) => r.id === r1.id).affiliate_fee_amount), 8);

        // Bad body
        assert.equal((await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({ redemptionIds: 'x' }))).status, 400);

        // Unassign: future orders earn nothing, past credited rows untouched
        res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/unassign`).send({}));
        assert.equal(res.status, 200);
        assert.equal(res.body.coupon.type, 'general');
        assert.equal(res.body.coupon.affiliate, null);
        const after = await couponStore.findCoupon(code);
        assert.equal(after.affiliateEmail, '');
        const { rows: kept } = await pool.query('SELECT affiliate_email FROM coupon_redemptions WHERE id = $1', [r1.id]);
        assert.equal(kept[0].affiliate_email, email);

        // GHL-origin coupons stay non-local even while assigned
        await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email }));
        const v = await couponStore.validateCouponReadOnly({ code, productId: 'test_product', email: 'someone@example.com' });
        assert.equal(v.reason, 'not_local_enabled');
    } finally {
        await cleanupCoupon(code);
        await cleanupAffiliate(email);
    }
});

test('unassign is rejected for local-origin coupons, and registration coupons cannot be reassigned', async () => {
    const email = `unassign.${Date.now()}@example.com`;
    stubGhl({});
    try {
        const reg = await registerAffiliate(email);
        let res = await admin(request(app).post(`/api/admin/ghl-coupons/${reg.couponCode}/unassign`).send({}));
        assert.equal(res.status, 400);
        res = await admin(request(app).post(`/api/admin/ghl-coupons/${reg.couponCode}/assign`).send({ affiliateEmail: email }));
        assert.equal(res.status, 400);
        assert.equal((await couponStore.findCoupon(reg.couponCode)).type, 'affiliate');
        assert.equal((await admin(request(app).post('/api/admin/ghl-coupons/NOPE_UNKNOWN/unassign').send({}))).status, 404);
    } finally {
        await cleanupAffiliate(email);
    }
});

test('an assigned custom fee percent is used by credit-past', async () => {
    const email = `fee.${Date.now()}@example.com`;
    const code = `GHLFEE${Date.now().toString(36).toUpperCase()}`;
    await ghlCoupon(code);
    stubGhl({});
    await ghlRedemption(code, { subtotal: 100, discount: 0 });
    try {
        await registerAffiliate(email);
        await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email, affiliateFeePercent: 0.25 }));
        const res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({}));
        assert.deepEqual(res.body.totalsByCurrency, { USD: { commission: 25 } });
    } finally {
        await cleanupCoupon(code);
        await cleanupAffiliate(email);
    }
});

test('GET /coupons/:code/usage lists redemptions and totals paid ones per currency', async () => {
    const code = await createTestCoupon({ type: 'general' });
    stubGhl({});
    try {
        await ghlRedemption(code, { subtotal: 100, discount: 20, currency: 'USD' });
        await ghlRedemption(code, { subtotal: 50, discount: 0, currency: 'USD' });
        await couponStore.recordRedemption({
            code, paymentReference: `PAYUSAGE${Date.now()}`, email: 'local@example.com', fullName: 'Local Buyer',
            baseAmount: 425, discountAmount: 75, commissionBase: 425, affiliateFeeAmount: 42.5, affiliateEmail: 'aff@example.com', currency: 'PHP'
        });
        // Legacy PayMongo row without commission_base: revenue falls back to base_amount (already post-discount).
        await pool.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, base_amount, discount_amount, affiliate_fee_amount, currency, status)
             VALUES ($1,$2,$3,300,100,0,'PHP','paid')`, [`legacy_${Date.now()}`, code, `legacy_ref_${Date.now()}`]);
        // Non-paid rows are listed but excluded from totals.
        await pool.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, base_amount, discount_amount, affiliate_fee_amount, currency, status)
             VALUES ($1,$2,$3,999,0,99,'PHP','pending')`, [`pend_${Date.now()}`, code, `pend_ref_${Date.now()}`]);

        const res = await admin(request(app).get(`/api/admin/coupons/${code}/usage`));
        assert.equal(res.status, 200);
        assert.equal(res.body.code, code);
        assert.equal(res.body.redemptions.length, 5);
        const ghlRow = res.body.redemptions.find((r) => r.source === 'ghl');
        assert.deepEqual(Object.keys(ghlRow).sort(), [
            'affiliateEmail', 'affiliateFeeAmount', 'baseAmount', 'commissionBase', 'createdAt', 'currency', 'discountAmount',
            'email', 'fullName', 'ghlLocationKey', 'ghlOrderId', 'id', 'isTest', 'source', 'status'
        ]);
        assert.equal(ghlRow.ghlLocationKey, 'global');
        assert.ok(ghlRow.ghlOrderId);
        assert.equal(ghlRow.affiliateEmail, null);
        assert.deepEqual(res.body.totalsByCurrency, {
            USD: { orders: 2, revenue: 130, discount: 20, commission: 0 },
            PHP: { orders: 2, revenue: 725, discount: 175, commission: 42.5 }
        });

        assert.equal((await admin(request(app).get('/api/admin/coupons/NOPE_UNKNOWN/usage'))).status, 404);
    } finally {
        await cleanupCoupon(code);
    }
});

test('affiliate + admin affiliate endpoints expose totalsByCurrency (commission) including assigned GHL coupons', async () => {
    const email = `totals.${Date.now()}@example.com`;
    const code = `GHLTOT${Date.now().toString(36).toUpperCase()}`;
    await ghlCoupon(code);
    stubGhl({});
    await ghlRedemption(code, { subtotal: 100, discount: 20 }); // credited later: 80 * 10% = 8 USD
    try {
        const reg = await registerAffiliate(email);
        await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email }));
        await admin(request(app).post(`/api/admin/ghl-coupons/${code}/credit-past`).send({}));
        await couponStore.recordRedemption({
            code: reg.couponCode, paymentReference: `PAYTOT${Date.now()}`, email: 'c@example.com', baseAmount: 425, discountAmount: 75,
            commissionBase: 425, affiliateFeeAmount: 42.5, affiliateEmail: email, currency: 'PHP'
        });

        const me = await request(app).get('/api/affiliates/me').set('Authorization', `Bearer ${reg.token}`);
        assert.equal(me.status, 200);
        assert.equal(me.body.totalsByCurrency.PHP.commission, 42.5);
        assert.equal(me.body.totalsByCurrency.PHP.sales, 425);
        assert.equal(me.body.totalsByCurrency.USD.commission, 8);
        assert.equal(me.body.totalsByCurrency.USD.sales, 80); // net (subtotal 100 - discount 20), not the pre-discount subtotal
        assert.equal(me.body.totalsByCurrency.USD.unpaid, 8);
        assert.equal(me.body.stats.totalEarnings, 50.5); // existing field kept

        const list = await admin(request(app).get('/api/admin/affiliates'));
        const row = list.body.affiliates.find((a) => a.email === email);
        assert.equal(row.totalsByCurrency.PHP.commission, 42.5);
        assert.equal(row.totalsByCurrency.USD.commission, 8);
        assert.equal(row.totalsByCurrency.USD.sales, 80);

        const one = await admin(request(app).get(`/api/admin/affiliates/${reg.affiliateId}`));
        assert.equal(one.body.totalsByCurrency.USD.commission, 8);
        assert.equal(one.body.totalsByCurrency.USD.sales, 80);
        // Legacy rows (no commission_base) use the same definition as usage revenue.
        assert.equal(couponStore.affiliateTotalsByCurrency([
            { status: 'paid', currency: 'USD', source: 'ghl', baseAmount: 100, discountAmount: 20, commissionBase: null, affiliateFeeAmount: 0 },
            { status: 'paid', currency: 'PHP', source: 'paymongo', baseAmount: 425, discountAmount: 75, commissionBase: null, affiliateFeeAmount: 0 }
        ]).USD.sales, 80);
    } finally {
        await cleanupCoupon(code);
        await cleanupAffiliate(email);
    }
});

test('GHL-only coupons (in GHL, not in our DB) are listed and can be assigned before any order uses them', async () => {
    const email = `ghlonly.${Date.now()}@example.com`;
    const code = `HANDMADE${Date.now().toString(36).toUpperCase()}`;
    const flatCode = `FLAT${Date.now().toString(36).toUpperCase()}`;
    stubGhl({
        loc_g: [{ id: 'hg1', code, discountValue: 25 }, { id: 'hf1', code: flatCode, discountType: 'amount', discountValue: 10 }],
        loc_m: [{ id: 'hm1', code, discountValue: 25 }]
    });
    try {
        await registerAffiliate(email);

        const list = await admin(request(app).get('/api/admin/ghl-coupons'));
        const item = list.body.coupons.find((c) => c.code === code);
        assert.equal(item.origin, 'ghl');
        assert.equal(item.type, 'general');
        assert.equal(item.affiliate, null);
        assert.equal(item.discountPercent, 0.25);
        assert.equal(item.affiliateFeePercent, 0);
        assert.deepEqual(item.usage, { paidCount: 0, unassignedCount: 0 });
        assert.deepEqual(item.locations.map((l) => [l.key, l.ghlCouponId]), [['global', 'hg1'], ['main', 'hm1']]);
        assert.equal(list.body.coupons.find((c) => c.code === flatCode).discountPercent, 0);
        assert.equal((await couponStore.findCoupon(code)), null, 'listing must not persist anything');

        // 404 only when in neither the DB nor GHL
        assert.equal((await admin(request(app).post('/api/admin/ghl-coupons/NOWHERE_CODE/assign').send({ affiliateEmail: email }))).status, 404);
        // Validation failures do not create the DB row
        assert.equal((await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: 'nobody@example.com' }))).status, 400);
        assert.equal(await couponStore.findCoupon(code), null);

        const res = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email, affiliateFeePercent: 0.2 }));
        assert.equal(res.status, 200);
        assert.equal(res.body.coupon.type, 'affiliate');
        assert.equal(res.body.coupon.origin, 'ghl');
        assert.equal(res.body.coupon.affiliateFeePercent, 0.2);
        assert.equal(res.body.coupon.affiliate.email, email);
        assert.equal(res.body.coupon.discountPercent, 0.25);
        assert.deepEqual(res.body.creditable, []);

        const row = (await pool.query('SELECT * FROM coupons WHERE code = $1', [code])).rows[0];
        assert.equal(row.origin, 'ghl');
        assert.equal(row.local_enabled, false);
        assert.equal(row.notes, 'Discovered from GHL order');
        assert.deepEqual([...row.ghl_location_ids].sort(), ['loc_g', 'loc_m']);

        // Now unassign reports the fee too
        const un = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/unassign`).send({}));
        assert.equal(un.body.coupon.affiliateFeePercent, 0.2);
        const listAfter = await admin(request(app).get('/api/admin/ghl-coupons'));
        assert.equal(listAfter.body.coupons.filter((c) => c.code === code).length, 1, 'no duplicate once it is in the DB');
    } finally {
        await cleanupCoupon(code);
        await cleanupAffiliate(email);
    }
});

test('affiliateFeePercent is present on every coupon in list/assign/unassign responses', async () => {
    const email = `feefield.${Date.now()}@example.com`;
    const code = `GHLFF${Date.now().toString(36).toUpperCase()}`;
    await ghlCoupon(code);
    stubGhl({});
    try {
        await registerAffiliate(email);
        const list = await admin(request(app).get('/api/admin/ghl-coupons'));
        assert.ok(list.body.coupons.every((c) => typeof c.affiliateFeePercent === 'number'));
        const assign = await admin(request(app).post(`/api/admin/ghl-coupons/${code}/assign`).send({ affiliateEmail: email }));
        assert.equal(assign.body.coupon.affiliateFeePercent, 0.1);
    } finally {
        await cleanupCoupon(code);
        await cleanupAffiliate(email);
    }
});
