require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const PRODUCT_ID = 'test_product';
const hasPaymongoKey = Boolean(process.env.PAYMONGO_SECRET_KEY);

function basePayload(overrides = {}) {
    return {
        fullName: 'Test User',
        email: `test.${Math.random().toString(36).slice(2, 8)}@example.com`,
        mobile: '+639171234567',
        productId: PRODUCT_ID,
        ...overrides
    };
}

test('rejects an unknown promo code', async () => {
    const res = await request(app)
        .post('/api/payments/create-payment-intent')
        .send(basePayload({ promoCode: 'DOES_NOT_EXIST_CODE' }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid promo code/i);
});

test('rejects an inactive coupon', async () => {
    const code = await createTestCoupon({ active: false });
    try {
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ promoCode: code }));
        assert.equal(res.status, 400);
        assert.match(res.body.error, /no longer active/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects an expired coupon', async () => {
    const code = await createTestCoupon({ expiresAt: new Date(Date.now() - 86400000).toISOString() });
    try {
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ promoCode: code }));
        assert.equal(res.status, 400);
        assert.match(res.body.error, /expired/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects a coupon that is not eligible for the selected product', async () => {
    const code = await createTestCoupon({ productIds: ['test_product_2'] });
    try {
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ promoCode: code }));
        assert.equal(res.status, 400);
        assert.match(res.body.error, /not valid for the selected product/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test(
    'a valid coupon discounts the server-side price, ignoring client-sent amounts',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ discountPercent: 0.15 });
        try {
            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: code, amount: 999999, discountAmount: 999999 }));
            assert.equal(res.status, 200);
            assert.equal(res.body.discountAmount, 75); // 500 * 0.15
            assert.equal(res.body.baseAmount, 425); // 500 - 75
            assert.equal(res.body.amount, 467.5); // 425 * 1.10 (TAX_RATE=0.10)
            assert.equal(res.body.promoCode, code);
        } finally {
            await cleanupCoupon(code);
        }
    }
);

test(
    'a maxRedemptions:1 coupon cannot be reserved by two concurrent checkouts',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ maxRedemptions: 1 });
        try {
            const [a, b] = await Promise.all([
                request(app).post('/api/payments/create-payment-intent').send(basePayload({ promoCode: code })),
                request(app).post('/api/payments/create-payment-intent').send(basePayload({ promoCode: code }))
            ]);

            const statuses = [a.status, b.status].sort((x, y) => x - y);
            assert.deepEqual(statuses, [200, 400], 'exactly one of the two concurrent checkouts should succeed');

            const failed = a.status === 400 ? a : b;
            assert.match(failed.body.error, /redemption limit/i);

            const { rows } = await pool.query('SELECT status FROM coupon_redemptions WHERE code = $1', [code]);
            assert.equal(rows.length, 1, 'only one reservation row should exist, not two');
            assert.equal(rows[0].status, 'pending');
        } finally {
            await cleanupCoupon(code);
        }
    }
);

test('a coupon code longer than 6 characters (but within the 50-char cap) can be created', async () => {
    const code = 'FATHERSDAY15';
    await cleanupCoupon(code);
    try {
        const created = await createTestCoupon({ code });
        assert.equal(created, code);
        const found = await couponStore.findCoupon(code);
        assert.ok(found, 'coupon should be findable after creation');
        assert.equal(found.code, code);
    } finally {
        await cleanupCoupon(code);
    }
});

test('a coupon code over 50 characters is rejected', async () => {
    const code = 'A'.repeat(51);
    await assert.rejects(
        () => createTestCoupon({ code }),
        /must be at most 50 characters/i
    );
});

after(async () => {
    await pool.end();
});
