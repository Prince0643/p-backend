require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const PASSWORD = 'testpassword123';

function registrationPayload(email) {
    return {
        firstName: 'Affiliate', lastName: 'TestMode', email, password: PASSWORD, contactNumber: '+639171234567',
        paymentRegion: 'GLOBAL', preferredBank: 'WISE', globalAccountName: 'Affiliate Test', globalAccountEmail: email, termsAccepted: true
    };
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One live and one test GHL redemption (USD) on `code`, credited to `affiliateEmail`. */
async function seedPair(code, affiliateEmail, { buyer = `buyer.${uid()}@example.com` } = {}) {
    const live = `live${uid()}`;
    const testId = `test${uid()}`;
    await couponStore.insertGhlRedemption({
        orderId: live, code, email: buyer, fullName: 'Live Buyer', baseAmount: 100, discountAmount: 15, commissionBase: 85,
        affiliateFeeAmount: 8.5, affiliateEmail, currency: 'USD', ghlProductIds: []
    });
    await couponStore.insertGhlRedemption({
        orderId: testId, code, email: buyer, fullName: 'Test Buyer', baseAmount: 200, discountAmount: 30, commissionBase: 170,
        affiliateFeeAmount: 17, affiliateEmail, currency: 'USD', ghlProductIds: [], isTest: true
    });
    return { live, testId };
}

test('test redemptions are excluded from every total but appear in lists with isTest', async () => {
    const email = `testmode.aff.${uid()}@example.com`;
    try {
        const reg = await request(app).post('/api/affiliates/register').send(registrationPayload(email));
        assert.equal(reg.status, 201);
        const { affiliateId, couponCode } = reg.body;
        await seedPair(couponCode, email);

        // admin affiliates list + detail
        const list = await request(app).get('/api/admin/affiliates').set('x-api-key', ADMIN_KEY);
        const row = list.body.affiliates.find((a) => a.id === affiliateId);
        assert.equal(row.totalsByCurrency.USD.commission, 8.5);
        assert.equal(row.totalsByCurrency.USD.sales, 85);
        assert.deepEqual(row.testTotalsByCurrency, { USD: { sales: 170, commission: 17 } });

        const one = await request(app).get(`/api/admin/affiliates/${affiliateId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(one.body.totalsByCurrency.USD.commission, 8.5);
        assert.equal(one.body.testTotalsByCurrency.USD.commission, 17);
        assert.equal(one.body.redemptions.filter((r) => r.isTest).length, 1);

        // admin redemptions list includes both, flagged
        const reds = await request(app).get('/api/admin/coupons/redemptions').query({ code: couponCode }).set('x-api-key', ADMIN_KEY);
        assert.equal(reds.body.redemptions.length, 2);
        assert.equal(reds.body.redemptions.filter((r) => r.isTest).length, 1);

        // coupon usage (admin "who used this coupon"): totals live-only, rows include the test one
        const { rows: coupon } = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [couponCode]);
        assert.equal(coupon.length, 1);
        const totals = require('../utils/couponStore').totalsByCurrencyForCoupon(await couponStore.listRedemptions({ code: couponCode }));
        assert.deepEqual(totals, { USD: { orders: 1, revenue: 85, discount: 15, commission: 8.5 } });

        // affiliate self dashboard
        const login = await request(app).post('/api/affiliates/login').send({ email, password: PASSWORD });
        const me = await request(app).get('/api/affiliates/me').set('Authorization', `Bearer ${login.body.token}`);
        assert.equal(me.status, 200);
        assert.equal(me.body.redemptions.length, 2);
        assert.equal(me.body.redemptions.filter((r) => r.isTest).length, 1);
        assert.equal(me.body.totalsByCurrency.USD.earned, 8.5);
        assert.equal(me.body.testTotalsByCurrency.USD.commission, 17);
        assert.equal(me.body.stats.totalEarnings, 8.5);
        assert.equal(me.body.stats.paidRedemptions, 1);
        assert.equal(me.body.stats.totalRedemptions, 1);
        assert.equal(me.body.stats.testRedemptions, 1);
    } finally {
        await cleanupAffiliate(email);
    }
});

test('test redemptions never count toward max_redemptions, one-per-customer rules, or payouts', async () => {
    const buyer = `testmode.buyer.${uid()}@example.com`;
    const general = await createTestCoupon({ type: 'general', maxRedemptions: 1, affiliateFeePercent: 0 });
    const affiliateCode = await createTestCoupon({ type: 'affiliate', affiliateEmail: `testmode.owner.${uid()}@example.com` });
    try {
        // test rows on both coupons for this buyer
        await couponStore.insertGhlRedemption({ orderId: `t${uid()}`, code: general, email: buyer, baseAmount: 100, discountAmount: 10, commissionBase: 90, currency: 'USD', isTest: true });
        const testAff = `t${uid()}`;
        await couponStore.insertGhlRedemption({ orderId: testAff, code: affiliateCode, email: buyer, baseAmount: 100, discountAmount: 10, commissionBase: 90, affiliateFeeAmount: 9, affiliateEmail: 'x@example.com', currency: 'USD', isTest: true });

        const gRes = await couponStore.validateCouponReadOnly({ code: general, email: buyer });
        assert.ok(gRes.coupon, `limit-1 coupon must still be usable: ${gRes.error}`);
        const aRes = await couponStore.validateCouponReadOnly({ code: affiliateCode, email: buyer });
        assert.ok(aRes.coupon, `affiliate discount must still be available: ${aRes.error}`);
        const reservation = await couponStore.beginCouponReservation({ code: general, email: `other.${uid()}@example.com` });
        assert.ok(reservation.coupon, 'reservation not blocked by a test row');
        await couponStore.abortCouponReservation(reservation.client);

        // a REAL paid row does consume the limit (live behaviour unchanged)
        await couponStore.insertGhlRedemption({ orderId: `l${uid()}`, code: general, email: `real.${uid()}@example.com`, baseAmount: 100, discountAmount: 10, commissionBase: 90, currency: 'USD' });
        const after1 = await couponStore.validateCouponReadOnly({ code: general, email: `next.${uid()}@example.com` });
        assert.equal(after1.reason, 'max_redemptions_reached');

        // payouts: a test row can't be marked paid out
        const result = await couponStore.markRedemptionsPaid([`ghl_${testAff}`]);
        assert.deepEqual(result.updated, []);
        assert.deepEqual(result.skipped, [`ghl_${testAff}`]);
    } finally {
        await cleanupCoupon(general);
        await cleanupCoupon(affiliateCode);
    }
});

test('coupon usage view and unassigned/creditable lists ignore test rows', async () => {
    const affEmail = `testmode.counts.${uid()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: affEmail });
    try {
        await seedPair(code, affEmail);
        const { rows } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'paid' AND is_test = false)::int AS live, COUNT(*) FILTER (WHERE is_test)::int AS test
             FROM coupon_redemptions WHERE code = $1`, [code]);
        assert.deepEqual(rows[0], { live: 1, test: 1 });

        const creditable = await couponStore.listCreditableRedemptions(code);
        assert.equal(creditable.length, 0);

        // admin "who used this coupon": both rows listed (test flagged), totals live-only
        const usage = await request(app).get(`/api/admin/coupons/${code}/usage`).set('x-api-key', ADMIN_KEY);
        assert.equal(usage.status, 200);
        assert.equal(usage.body.redemptions.length, 2);
        assert.equal(usage.body.redemptions.filter((r) => r.isTest).length, 1);
        assert.deepEqual(usage.body.totalsByCurrency, { USD: { orders: 1, revenue: 85, discount: 15, commission: 8.5 } });
    } finally {
        await cleanupCoupon(code);
    }
});

after(async () => {
    await pool.end();
});
