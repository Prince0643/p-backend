require('./setupEnv');
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const LOCATION_ID = 'loc_global_sol';
const admin = (req) => req.set('x-api-key', ADMIN_KEY);
const originalGetTrackedLocations = ghlService.getTrackedLocations;
const orderIds = [];

afterEach(async () => {
    ghlService.getTrackedLocations = originalGetTrackedLocations;
    const refs = orderIds.splice(0).map((id) => `ghl:${id}`);
    if (refs.length) {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE transaction_id = ANY($1)', [refs]);
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = ANY($1)', [refs]);
    }
});

after(async () => {
    await pool.end();
});

async function seedGhlOrder(orderId, { isTest = false, code = null, items = [{ name: 'Item One', productId: 'gp_1' }] } = {}) {
    orderIds.push(orderId);
    await digitalSolutionsStore.upsertGhlOrder({
        orderId, customerEmail: 'buyer@example.com', customerName: 'Buyer', productName: 'Item One', ghlProductIds: ['gp_1'],
        amount: 85, currency: 'USD', promoCode: code, status: 'paid', ghlPaymentStatus: 'paid', createdAt: '2026-09-01T10:00:00.000Z',
        isTest, ghlLocationId: LOCATION_ID,
        raw: { total: 85, subtotal: 100, discount: 15, liveMode: !isTest, items }
    });
}

test('admin detail endpoint returns the linked redemption, test orders return none, list filters by isTest', async () => {
    const code = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, affiliateEmail: `sol.aff2.${Date.now()}@example.com` });
    const liveId = `soladm_live_${Date.now()}`;
    const testId = `soladm_test_${Date.now()}`;
    ghlService.getTrackedLocations = () => [{ key: 'global', locationId: LOCATION_ID }];
    try {
        await seedGhlOrder(liveId, { code });
        await seedGhlOrder(testId, { isTest: true });
        await couponStore.insertGhlRedemption({
            orderId: liveId, code, email: 'buyer@example.com', fullName: 'Buyer', baseAmount: 100, discountAmount: 15, commissionBase: 85,
            affiliateFeeAmount: 8.5, affiliateEmail: 'aff@example.com', currency: 'USD', createdAt: '2026-09-01T10:00:00.000Z', ghlLocationId: LOCATION_ID, ghlProductIds: ['gp_1']
        });

        const liveRes = await admin(request(app).get(`/api/admin/solutions/ghl:${liveId}`));
        assert.equal(liveRes.status, 200);
        assert.equal(liveRes.body.transaction.ghlOrderId, liveId);
        assert.equal(liveRes.body.transaction.ghlLocationKey, 'global');
        assert.equal(liveRes.body.transaction.isTest, false);
        assert.equal(liveRes.body.transaction.raw.total, 85);
        assert.equal(liveRes.body.redemption.code, code);
        assert.equal(liveRes.body.redemption.state, 'active');
        assert.equal(liveRes.body.redemption.affiliateEmail, 'aff@example.com');
        assert.equal(liveRes.body.redemption.commissionBase, 85);
        assert.equal(liveRes.body.redemption.affiliateFeeAmount, 8.5);

        // Refund flips the redemption state the admin sees.
        await couponStore.applyGhlRefund(liveId);
        const refunded = await admin(request(app).get(`/api/admin/solutions/ghl:${liveId}`));
        assert.equal(refunded.body.redemption.state, 'refunded');

        const testRes = await admin(request(app).get(`/api/admin/solutions/ghl:${testId}`));
        assert.equal(testRes.body.transaction.isTest, true);
        assert.equal(testRes.body.redemption, null);

        const listed = await admin(request(app).get('/api/admin/solutions?type=ghl_order&isTest=true'));
        const ids = listed.body.transactions.map((t) => t.ghlOrderId);
        assert.ok(ids.includes(testId));
        assert.ok(!ids.includes(liveId));
    } finally {
        await cleanupCoupon(code);
    }
});
