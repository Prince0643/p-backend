require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon, signWebhookBody, paymentEventPayload } = require('./fixtures');

const PRODUCT_ID = 'test_product';

/** Reserves a coupon directly (no real PayMongo call needed) to set up a webhook test. */
async function reserveDirectly(code, paymentReference) {
    const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID });
    assert.ok(reservation.coupon, `expected reservation to succeed: ${reservation.error}`);
    return couponStore.finalizeCouponReservation(reservation.client, {
        code,
        paymentReference,
        productId: PRODUCT_ID,
        email: 'webhook-test@example.com',
        fullName: 'Webhook Test',
        baseAmount: 425,
        discountAmount: 75,
        affiliateFeeAmount: 42.5,
        currency: 'PHP'
    });
}

test('rejects a forged webhook signature', async () => {
    const { body } = signWebhookBody(paymentEventPayload('payment.pending', {}));
    const res = await request(app)
        .post('/api/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('Paymongo-Signature', 't=1234567890,te=deadbeef')
        .send(body);
    assert.equal(res.status, 401);
});

test('accepts a correctly signed webhook', async () => {
    const { body, header } = signWebhookBody(paymentEventPayload('payment.pending', {}));
    const res = await request(app)
        .post('/api/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('Paymongo-Signature', header)
        .send(body);
    assert.equal(res.status, 200);
});

test('payment.paid confirms the reservation and is idempotent on a retried delivery', async () => {
    const code = await createTestCoupon({ maxRedemptions: 1 });
    const paymentReference = `PAYTEST${Date.now()}A`;
    try {
        await reserveDirectly(code, paymentReference);

        const eventPayload = paymentEventPayload('payment.paid', {
            paymentReference,
            promoCode: code,
            baseAmount: '425',
            discountAmount: '75',
            email: 'webhook-test@example.com',
            fullName: 'Webhook Test',
            productId: PRODUCT_ID
        });

        const first = signWebhookBody(eventPayload);
        const firstRes = await request(app)
            .post('/api/payments/webhook')
            .set('Content-Type', 'application/json')
            .set('Paymongo-Signature', first.header)
            .send(first.body);
        assert.equal(firstRes.status, 200);

        let { rows } = await pool.query(
            'SELECT status FROM coupon_redemptions WHERE payment_reference = $1',
            [paymentReference]
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'paid');

        // PayMongo retries webhook delivery on its own schedule - simulate a second,
        // freshly-signed delivery of the same event.
        const retry = signWebhookBody(eventPayload);
        const retryRes = await request(app)
            .post('/api/payments/webhook')
            .set('Content-Type', 'application/json')
            .set('Paymongo-Signature', retry.header)
            .send(retry.body);
        assert.equal(retryRes.status, 200);

        ({ rows } = await pool.query('SELECT status FROM coupon_redemptions WHERE code = $1', [code]));
        assert.equal(rows.length, 1, 'retry must not insert a duplicate redemption row');
        assert.equal(rows[0].status, 'paid');
    } finally {
        await cleanupCoupon(code);
    }
});

test('payment.failed releases the reservation so the coupon is usable again', async () => {
    const code = await createTestCoupon({ maxRedemptions: 1 });
    const paymentReference = `PAYTEST${Date.now()}F`;
    try {
        await reserveDirectly(code, paymentReference);

        const eventPayload = paymentEventPayload('payment.failed', {
            paymentReference,
            promoCode: code,
            baseAmount: '425',
            discountAmount: '75',
            email: 'webhook-test@example.com',
            fullName: 'Webhook Test',
            productId: PRODUCT_ID
        });
        const { body, header } = signWebhookBody(eventPayload);
        const res = await request(app)
            .post('/api/payments/webhook')
            .set('Content-Type', 'application/json')
            .set('Paymongo-Signature', header)
            .send(body);
        assert.equal(res.status, 200);

        const { rows } = await pool.query(
            'SELECT status FROM coupon_redemptions WHERE payment_reference = $1',
            [paymentReference]
        );
        assert.equal(rows[0].status, 'released');

        const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID });
        assert.ok(reservation.coupon, 'coupon should be reservable again after the failed payment released it');
        await couponStore.abortCouponReservation(reservation.client);
    } finally {
        await cleanupCoupon(code);
    }
});

test('in production, a missing PAYMONGO_WEBHOOK_SECRET fails closed instead of processing the webhook', async () => {
    const originalSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    const originalEnv = process.env.NODE_ENV;
    delete process.env.PAYMONGO_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    try {
        const res = await request(app)
            .post('/api/payments/webhook')
            .send({ data: { attributes: { type: 'payment.pending' } } });
        assert.equal(res.status, 500);
    } finally {
        process.env.PAYMONGO_WEBHOOK_SECRET = originalSecret;
        process.env.NODE_ENV = originalEnv;
    }
});

after(async () => {
    await pool.end();
});
