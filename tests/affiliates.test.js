require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const ghlService = require('../services/ghlService');
const { cleanupAffiliate } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const PRODUCT_ID = 'test_product';

function registrationPayload(email) {
    return {
        firstName: 'Affiliate',
        lastName: 'Test',
        email,
        password: 'testpassword123',
        contactNumber: '+639171234567',
        paymentRegion: 'GLOBAL',
        preferredBank: 'WISE',
        globalAccountName: 'Affiliate Test',
        globalAccountEmail: email,
        termsAccepted: true
    };
}

test('affiliate suspension deactivates their linked coupon', async () => {
    const email = `affiliate.suspend.${Date.now()}@example.com`;
    try {
        const reg = await request(app).post('/api/affiliates/register').send(registrationPayload(email));
        assert.equal(reg.status, 201);
        const { affiliateId, couponCode } = reg.body;

        let coupon = await couponStore.findCoupon(couponCode);
        assert.equal(coupon.active, true);

        const suspend = await request(app)
            .patch(`/api/admin/affiliates/${affiliateId}/status`)
            .set('x-api-key', ADMIN_KEY)
            .send({ status: 'suspended' });
        assert.equal(suspend.status, 200);

        coupon = await couponStore.findCoupon(couponCode);
        assert.equal(coupon.active, false);
    } finally {
        await cleanupAffiliate(email);
    }
});

test('affiliate registration creates the generated coupon in GHL when configured', async () => {
    const email = `affiliate.ghl.${Date.now()}@example.com`;
    const originalPrivateKey = ghlService.privateKey;
    const originalLocationId = ghlService.locationId;
    const originalClient = ghlService.client;
    const calls = [];

    ghlService.privateKey = 'test_ghl_key';
    ghlService.locationId = 'test_location_id';
    ghlService.client = {
        post: async (path, payload, config) => {
            calls.push({ path, payload, config });
            return { data: { _id: 'ghl_coupon_id', code: payload.code } };
        }
    };

    try {
        const reg = await request(app).post('/api/affiliates/register').send(registrationPayload(email));
        assert.equal(reg.status, 201);
        assert.equal(reg.body.ghlCouponId, 'ghl_coupon_id');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].path, '/payments/coupon');
        assert.equal(calls[0].payload.altId, 'test_location_id');
        assert.equal(calls[0].payload.altType, 'location');
        assert.equal(calls[0].payload.code, reg.body.couponCode);
        assert.equal(calls[0].payload.discountType, 'percentage');
        assert.equal(calls[0].payload.discountValue, 15);
        assert.equal(calls[0].payload.usageLimit, 1);
        assert.equal(calls[0].payload.limitPerCustomer, true);
        assert.equal(calls[0].config.headers.Version, '2021-04-15');
    } finally {
        ghlService.privateKey = originalPrivateKey;
        ghlService.locationId = originalLocationId;
        ghlService.client = originalClient;
        await cleanupAffiliate(email);
    }
});

test('reactivating an affiliate does not bypass the coupon redemption cap', async () => {
    const email = `affiliate.reactivate.${Date.now()}@example.com`;
    try {
        const reg = await request(app).post('/api/affiliates/register').send(registrationPayload(email));
        assert.equal(reg.status, 201);
        const { affiliateId, couponCode } = reg.body;

        // Consume the coupon's one redemption slot directly (reserve + confirm paid),
        // without needing a real PayMongo call.
        const reservation = await couponStore.beginCouponReservation({ code: couponCode, productId: PRODUCT_ID });
        assert.ok(reservation.coupon, `expected reservation to succeed: ${reservation.error}`);
        const paymentReference = `PAYTEST${Date.now()}`;
        await couponStore.finalizeCouponReservation(reservation.client, {
            code: couponCode,
            paymentReference,
            productId: PRODUCT_ID,
            email,
            fullName: 'Affiliate Test',
            baseAmount: 425,
            discountAmount: 75,
            affiliateFeeAmount: 42.5,
            currency: 'PHP'
        });
        await couponStore.markReservationPaid({ paymentReference });

        // Suspend then reactivate the affiliate.
        await request(app)
            .patch(`/api/admin/affiliates/${affiliateId}/status`)
            .set('x-api-key', ADMIN_KEY)
            .send({ status: 'suspended' });
        const reactivate = await request(app)
            .patch(`/api/admin/affiliates/${affiliateId}/status`)
            .set('x-api-key', ADMIN_KEY)
            .send({ status: 'active' });
        assert.equal(reactivate.status, 200);

        const coupon = await couponStore.findCoupon(couponCode);
        assert.equal(coupon.active, true, 'reactivation should turn the coupon back on');

        // But the already-used redemption slot must still be exhausted - reactivating
        // the affiliate must not reset or ignore the redemption count.
        const second = await couponStore.beginCouponReservation({ code: couponCode, productId: PRODUCT_ID });
        assert.equal(second.coupon, undefined);
        assert.equal(second.reason, 'max_redemptions_reached');
    } finally {
        await cleanupAffiliate(email);
    }
});

after(async () => {
    await pool.end();
});
