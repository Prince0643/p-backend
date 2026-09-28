require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const PRODUCT_ID = 'test_product';

after(async () => {
    await pool.end();
});

// Each call defaults to a distinct customer email (derived from paymentReference) - the
// once-per-customer coupon rules would otherwise block a second redemption of the same
// code for tests that intentionally create two paid redemptions on one coupon.
async function paidRedemption({ code, paymentReference, baseAmount = 100, affiliateFeeAmount = 10, currency = 'PHP', email }) {
    const customerEmail = email || `payout-test.${paymentReference}@example.com`;
    const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: customerEmail });
    assert.ok(reservation.coupon, `expected reservation to succeed: ${reservation.error}`);
    await couponStore.finalizeCouponReservation(reservation.client, {
        code, paymentReference, productId: PRODUCT_ID, email: customerEmail, fullName: 'Payout Test',
        baseAmount, discountAmount: 0, affiliateFeeAmount, currency
    });
    return couponStore.markReservationPaid({ paymentReference });
}

test('markRedemptionsPaid only sets affiliate_paid_at, never touches status', async () => {
    const code = await createTestCoupon({ discountPercent: 0.1, affiliateFeePercent: 0.1, maxRedemptions: null });
    const paymentReference = `PAYOUT${Date.now()}A`;
    try {
        const redemption = await paidRedemption({ code, paymentReference });
        assert.equal(redemption.status, 'paid');
        assert.equal(redemption.affiliatePaidAt, null);

        const result = await couponStore.markRedemptionsPaid([redemption.id]);
        assert.deepEqual(result.updated, [redemption.id]);
        assert.deepEqual(result.skipped, []);

        const { rows } = await pool.query('SELECT status, affiliate_paid_at FROM coupon_redemptions WHERE id = $1', [redemption.id]);
        assert.equal(rows[0].status, 'paid');
        assert.ok(rows[0].affiliate_paid_at);

        // Re-running with the same id is a no-op (already paid out) - reported as skipped.
        const second = await couponStore.markRedemptionsPaid([redemption.id]);
        assert.deepEqual(second.updated, []);
        assert.deepEqual(second.skipped, [redemption.id]);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        await cleanupCoupon(code);
    }
});

test('markRedemptionsPaid skips a redemption whose customer payment never completed (status pending)', async () => {
    const code = await createTestCoupon({ discountPercent: 0.1, affiliateFeePercent: 0.1, maxRedemptions: null });
    try {
        const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'payout-test-pending@example.com' });
        const paymentReference = `PAYOUT${Date.now()}B`;
        const pending = await couponStore.finalizeCouponReservation(reservation.client, {
            code, paymentReference, productId: PRODUCT_ID, email: 'payout-test-pending@example.com', baseAmount: 100, discountAmount: 0, affiliateFeeAmount: 10, currency: 'PHP'
        });
        assert.equal(pending.status, 'pending');

        const result = await couponStore.markRedemptionsPaid([pending.id]);
        assert.deepEqual(result.updated, []);
        assert.deepEqual(result.skipped, [pending.id]);

        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
    } finally {
        await cleanupCoupon(code);
    }
});

test('admin GET redemptions supports payout=unpaid|paid filter and returns additive fields', async () => {
    const code = await createTestCoupon({ discountPercent: 0.1, affiliateFeePercent: 0.1, maxRedemptions: null });
    const refUnpaid = `PAYOUT${Date.now()}UNPAID`;
    const refPaid = `PAYOUT${Date.now()}PAID`;
    try {
        const unpaid = await paidRedemption({ code, paymentReference: refUnpaid });
        const paid = await paidRedemption({ code, paymentReference: refPaid });
        await couponStore.markRedemptionsPaid([paid.id]);

        const unpaidRes = await request(app).get(`/api/admin/coupons/redemptions?code=${code}&payout=unpaid`).set('x-api-key', ADMIN_KEY);
        assert.equal(unpaidRes.status, 200);
        assert.deepEqual(unpaidRes.body.redemptions.map((r) => r.id).sort(), [unpaid.id].sort());

        const paidRes = await request(app).get(`/api/admin/coupons/redemptions?code=${code}&payout=paid`).set('x-api-key', ADMIN_KEY);
        assert.equal(paidRes.status, 200);
        assert.deepEqual(paidRes.body.redemptions.map((r) => r.id).sort(), [paid.id].sort());

        const row = paidRes.body.redemptions[0];
        assert.equal(row.source, 'paymongo');
        assert.equal(row.channel, 'local');
        assert.equal(row.currency, 'PHP');
        assert.ok(row.affiliatePaidAt);
        assert.equal(row.needsReview, false);
        assert.equal(row.refundedAt, null);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference IN ($1, $2)', [refUnpaid, refPaid]);
        await cleanupCoupon(code);
    }
});

test('affiliate GET /me returns totalsByCurrency with earned/paidOut/unpaid split', async () => {
    const email = `payout.affiliate.${Date.now()}@example.com`;
    const regRes = await request(app).post('/api/affiliates/register').send({
        firstName: 'Payout', lastName: 'Affiliate', email, password: 'testpassword123', contactNumber: '+639171234567',
        paymentRegion: 'GLOBAL', preferredBank: 'PAYPAL', globalAccountName: 'Payout Affiliate', globalAccountEmail: email, termsAccepted: true
    });
    assert.equal(regRes.status, 201);
    const token = regRes.body.token;
    const code = regRes.body.couponCode;

    const refA = `PAYOUT${Date.now()}TOTA`;
    const refB = `PAYOUT${Date.now()}TOTB`;
    try {
        // maxRedemptions on the auto-generated affiliate coupon is 1, so bump it up for this test.
        await couponStore.upsertCoupon({ ...(await couponStore.findCoupon(code)), maxRedemptions: null });

        const a = await paidRedemption({ code, paymentReference: refA, baseAmount: 100, affiliateFeeAmount: 10, currency: 'PHP' });
        const b = await paidRedemption({ code, paymentReference: refB, baseAmount: 50, affiliateFeeAmount: 5, currency: 'PHP' });
        await couponStore.markRedemptionsPaid([a.id]);

        const meRes = await request(app).get('/api/affiliates/me').set('Authorization', `Bearer ${token}`);
        assert.equal(meRes.status, 200);
        const totals = meRes.body.totalsByCurrency.PHP;
        assert.equal(totals.earned, 15);
        assert.equal(totals.paidOut, 10);
        assert.equal(totals.unpaid, 5);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference IN ($1, $2)', [refA, refB]);
        await pool.query('DELETE FROM affiliates WHERE email = $1', [email]);
        await cleanupCoupon(code);
    }
});
