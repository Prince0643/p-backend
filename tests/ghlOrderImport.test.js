require('./setupEnv');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const { importGlobalOrders } = require('../services/ghlOrderImport');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate, createTestCampaignSite, cleanupCampaignSite } = require('./fixtures');

const GLOBAL_LOCATION_ID = 'loc_global_test';
const GLOBAL_PRIVATE_KEY = 'pit_global_test';

let originalResolveGlobalLocation;
let originalCreateClient;
let originalGlobalLocationIdEnv;

function mockOrdersApi({ orders = [], detailByIdFn } = {}) {
    ghlService.resolveGlobalLocation = () => ({ name: 'Nexistry Core Global', locationId: GLOBAL_LOCATION_ID, privateKey: GLOBAL_PRIVATE_KEY });
    ghlService.createClient = () => ({
        get: async (url, { params } = {}) => {
            if (url === '/payments/orders') {
                const offset = params?.offset || 0;
                const limit = params?.limit || 100;
                return { data: { data: orders.slice(offset, offset + limit) } };
            }
            const match = url.match(/^\/payments\/orders\/(.+)$/);
            if (match) {
                const detail = detailByIdFn ? detailByIdFn(match[1]) : {};
                return { data: { data: detail } };
            }
            throw new Error(`Unexpected GHL API call: ${url}`);
        }
    });
}

function baseOrder(overrides = {}) {
    return {
        _id: `order_${Math.random().toString(36).slice(2, 8)}`,
        altId: GLOBAL_LOCATION_ID,
        altType: 'location',
        contactId: 'contact_1',
        contactName: 'Global Customer',
        contactEmail: 'global.customer@example.com',
        currency: 'USD',
        amount: 85,
        subtotal: 100,
        discount: 15,
        status: 'completed',
        paymentStatus: 'paid',
        liveMode: true,
        sourceType: 'form',
        sourceName: 'Checkout Form',
        sourceId: 'src_1',
        couponCode: 'OCTFEST15',
        createdAt: new Date().toISOString(),
        ...overrides
    };
}

beforeEach(() => {
    originalResolveGlobalLocation = ghlService.resolveGlobalLocation;
    originalCreateClient = ghlService.createClient;
    originalGlobalLocationIdEnv = process.env.GHL_GLOBAL_LOCATION_ID;
});

afterEach(() => {
    ghlService.resolveGlobalLocation = originalResolveGlobalLocation;
    ghlService.createClient = originalCreateClient;
    if (originalGlobalLocationIdEnv === undefined) delete process.env.GHL_GLOBAL_LOCATION_ID;
    else process.env.GHL_GLOBAL_LOCATION_ID = originalGlobalLocationIdEnv;
});

after(async () => {
    await pool.end();
});

test('returns an empty summary with an error when the Global location is not configured', async () => {
    ghlService.resolveGlobalLocation = () => null;
    const summary = await importGlobalOrders({});
    assert.equal(summary.scanned, 0);
    assert.equal(summary.imported, 0);
    assert.ok(summary.errors.length > 0);
});

test('imports a paid order with a matching affiliate coupon, USD currency and correct fee formula', async () => {
    const email = `ghl.affiliate.${Date.now()}@example.com`;
    const code = await createTestCoupon({ discountPercent: 0.15, affiliateFeePercent: 0.10, affiliateEmail: email });
    const order = baseOrder({ couponCode: code, amount: 85 });

    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [{ product: { _id: 'prod_ghl_1' } }], contactSnapshot: { email: order.contactEmail, name: order.contactName } })
    });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.scanned, 1);
        assert.equal(summary.imported, 1);
        assert.deepEqual(summary.skipped, { noCoupon: 0, invoice: 0, unknownCode: 0, noAffiliate: 0, test: 0 });

        const { rows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'ghl');
        assert.equal(rows[0].currency, 'USD');
        assert.equal(Number(rows[0].base_amount), 85);
        assert.equal(Number(rows[0].discount_amount), 15);
        assert.equal(Number(rows[0].affiliate_fee_amount), 8.5); // 85 * 0.10
        assert.equal(rows[0].affiliate_email, email);
        assert.equal(rows[0].status, 'paid');

        // Idempotent rerun: same order, no duplicate row, imported count is 0 this time.
        const secondSummary = await importGlobalOrders({});
        assert.equal(secondSummary.imported, 0);
        const { rows: rowsAfterRerun } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rowsAfterRerun.length, 1);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        await cleanupCoupon(code);
    }
});

test('skips invoice-sourced orders (would double-count PayMongo mirror invoices)', async () => {
    const code = await createTestCoupon({ affiliateEmail: 'someone@example.com' });
    const order = baseOrder({ couponCode: code, sourceType: 'invoice' });
    mockOrdersApi({ orders: [order] });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.skipped.invoice, 1);
        assert.equal(summary.imported, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('skips orders with an unknown coupon code', async () => {
    const order = baseOrder({ couponCode: 'TOTALLY_UNKNOWN_CODE_XYZ' });
    mockOrdersApi({ orders: [order] });

    const summary = await importGlobalOrders({});
    assert.equal(summary.skipped.unknownCode, 1);
    assert.equal(summary.imported, 0);
});

test('skips orders whose coupon has no linked affiliate', async () => {
    const code = await createTestCoupon({ affiliateEmail: null });
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({ orders: [order] });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.skipped.noAffiliate, 1);
        assert.equal(summary.imported, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('skips test/non-live orders', async () => {
    const code = await createTestCoupon({ affiliateEmail: 'someone2@example.com' });
    const order = baseOrder({ couponCode: code, liveMode: false });
    mockOrdersApi({ orders: [order] });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.skipped.test, 1);
        assert.equal(summary.imported, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('attributes to a campaign only when exactly one active GLOBAL campaign matches the order product', async () => {
    const email = `ghl.campaign.${Date.now()}@example.com`;
    const code = await createTestCoupon({ affiliateEmail: email, affiliateFeePercent: 0.10 });
    const site = await createTestCampaignSite({ channel: 'global', products: [{ kind: 'ghl', ref: 'prod_match', name: 'Matched Product' }] });

    let campaignId;
    try {
        const campaignRes = await require('../utils/campaignStore').createCampaign({
            name: 'Global Campaign', couponCode: code, destinationUrl: site.url, siteId: site.id
        });
        campaignId = campaignRes.id;

        const order = baseOrder({ couponCode: code });
        mockOrdersApi({
            orders: [order],
            detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [{ product: { _id: 'prod_match' } }] })
        });

        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 1);
        const { rows } = await pool.query('SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows[0].campaign_id, campaignId);

        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
    } finally {
        if (campaignId) await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await cleanupCampaignSite(site.id);
        await cleanupCoupon(code);
    }
});

test('leaves campaign_id null when the order product matches zero or multiple active campaigns', async () => {
    const email = `ghl.ambiguous.${Date.now()}@example.com`;
    const code = await createTestCoupon({ affiliateEmail: email });
    const site = await createTestCampaignSite({ channel: 'global', products: [{ kind: 'ghl', ref: 'prod_ambiguous', name: 'Ambiguous Product' }] });

    let campaignIdA, campaignIdB;
    try {
        const campaignStore = require('../utils/campaignStore');
        const campA = await campaignStore.createCampaign({ name: 'Global Campaign A', couponCode: code, destinationUrl: site.url, siteId: site.id });
        campaignIdA = campA.id;
        const campB = await campaignStore.createCampaign({ name: 'Global Campaign B', couponCode: code, destinationUrl: site.url, siteId: site.id });
        campaignIdB = campB.id;

        const order = baseOrder({ couponCode: code });
        mockOrdersApi({
            orders: [order],
            detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [{ product: { _id: 'prod_ambiguous' } }] })
        });

        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 1);
        const { rows } = await pool.query('SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows[0].campaign_id, null);

        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
    } finally {
        if (campaignIdA) await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignIdA]);
        if (campaignIdB) await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignIdB]);
        await cleanupCampaignSite(site.id);
        await cleanupCoupon(code);
    }
});

test('imports a recent order even when it is listed after an old (out-of-cutoff) order (sort-order independence)', async () => {
    const email = `ghl.sortorder.${Date.now()}@example.com`;
    const code = await createTestCoupon({ affiliateEmail: email, affiliateFeePercent: 0.10 });

    const oldOrder = baseOrder({
        couponCode: code,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() // 90 days ago, outside the 45-day window
    });
    const recentOrder = baseOrder({ couponCode: code, createdAt: new Date().toISOString() });

    // Oldest-first page - a page listing recentOrder AFTER oldOrder must not cause the
    // import to stop early and skip recentOrder.
    mockOrdersApi({
        orders: [oldOrder, recentOrder],
        detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [] })
    });

    try {
        const summary = await importGlobalOrders({});
        // The out-of-window order is filtered before it's ever "scanned" (it's not one
        // of the tracked skip categories) - only the recent order reaches processOrder.
        assert.equal(summary.scanned, 1);
        assert.equal(summary.imported, 1);

        const { rows: oldRows } = await pool.query('SELECT 1 FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${oldOrder._id}`]);
        assert.equal(oldRows.length, 0, 'the out-of-window order must not be imported');

        const { rows: recentRows } = await pool.query('SELECT 1 FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${recentOrder._id}`]);
        assert.equal(recentRows.length, 1, 'the recent order must still be imported despite being listed after an old one');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference IN ($1, $2)', [`ghl:${oldOrder._id}`, `ghl:${recentOrder._id}`]);
        await cleanupCoupon(code);
    }
});

test('refund before affiliate payout releases the redemption', async () => {
    const email = `ghl.refund.before.${Date.now()}@example.com`;
    const code = await createTestCoupon({ affiliateEmail: email, affiliateFeePercent: 0.10 });
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [] })
    });

    try {
        await importGlobalOrders({});

        const refundedOrder = { ...order, paymentStatus: 'refunded' };
        mockOrdersApi({ orders: [refundedOrder] });
        const summary = await importGlobalOrders({});
        assert.equal(summary.refunded, 1);

        const redemption = await couponStore.findRedemptionByPaymentReference(`ghl:${order._id}`);
        assert.equal(redemption.status, 'released');
        assert.ok(redemption.refundedAt);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        await cleanupCoupon(code);
    }
});

test('refund after affiliate payout flags for review instead of clawing back', async () => {
    const email = `ghl.refund.after.${Date.now()}@example.com`;
    const code = await createTestCoupon({ affiliateEmail: email, affiliateFeePercent: 0.10 });
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [] })
    });

    try {
        await importGlobalOrders({});
        const redemption = await couponStore.findRedemptionByPaymentReference(`ghl:${order._id}`);
        await couponStore.markRedemptionsPaid([redemption.id]);

        const refundedOrder = { ...order, paymentStatus: 'refunded' };
        mockOrdersApi({ orders: [refundedOrder] });
        const summary = await importGlobalOrders({});
        assert.equal(summary.flagged, 1);

        const afterRefund = await couponStore.findRedemptionByPaymentReference(`ghl:${order._id}`);
        assert.equal(afterRefund.status, 'paid');
        assert.equal(afterRefund.needsReview, true);
        assert.ok(afterRefund.refundedAt);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        await cleanupCoupon(code);
    }
});
