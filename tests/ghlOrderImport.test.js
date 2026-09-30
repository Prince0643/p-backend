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
let originalResolveMainLocation;
let originalCreateClient;
let originalGlobalLocationIdEnv;

const MAIN_LOCATION_ID = 'loc_main_test';
const MAIN_PRIVATE_KEY = 'pit_main_test';

/**
 * Mocks GLOBAL (always) and, when `mainOrders` is given, MAIN. `failListingFor` makes the
 * order listing of that location id throw.
 */
function mockOrdersApi({ orders = [], mainOrders = null, detailByIdFn, failListingFor = null } = {}) {
    ghlService.resolveGlobalLocation = () => ({ name: 'Nexistry Core Global', locationId: GLOBAL_LOCATION_ID, privateKey: GLOBAL_PRIVATE_KEY });
    ghlService.resolveMainLocation = () => (mainOrders ? { name: 'Main', locationId: MAIN_LOCATION_ID, privateKey: MAIN_PRIVATE_KEY } : null);
    ghlService.createClient = ({ locationId }) => ({
        get: async (url, { params } = {}) => {
            if (url === '/payments/orders') {
                if (failListingFor === locationId) throw new Error('token rejected');
                const source = locationId === MAIN_LOCATION_ID ? mainOrders : orders;
                const offset = params?.offset || 0;
                const limit = params?.limit || 100;
                return { data: { data: source.slice(offset, offset + limit) } };
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
    originalResolveMainLocation = ghlService.resolveMainLocation;
    originalCreateClient = ghlService.createClient;
    originalGlobalLocationIdEnv = process.env.GHL_GLOBAL_LOCATION_ID;
});

afterEach(() => {
    ghlService.resolveGlobalLocation = originalResolveGlobalLocation;
    ghlService.resolveMainLocation = originalResolveMainLocation;
    ghlService.createClient = originalCreateClient;
    if (originalGlobalLocationIdEnv === undefined) delete process.env.GHL_GLOBAL_LOCATION_ID;
    else process.env.GHL_GLOBAL_LOCATION_ID = originalGlobalLocationIdEnv;
});

after(async () => {
    await pool.end();
});

test('returns an empty summary with an error when no GHL location is configured', async () => {
    ghlService.resolveGlobalLocation = () => null;
    ghlService.resolveMainLocation = () => null;
    const summary = await importGlobalOrders({});
    assert.equal(summary.scanned, 0);
    assert.equal(summary.imported, 0);
    assert.ok(summary.errors.length > 0);
});

test('imports a paid order with a matching affiliate coupon, USD currency and correct fee formula', async () => {
    const email = `ghl.affiliate.${Date.now()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, affiliateEmail: email });
    const order = baseOrder({ couponCode: code, amount: 85 });

    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { discount: 15 }, items: [{ product: { _id: 'prod_ghl_1' } }], contactSnapshot: { email: order.contactEmail, name: order.contactName } })
    });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.scanned, 1);
        assert.equal(summary.imported, 1);
        assert.deepEqual(summary.skipped, { noCoupon: 0, invoice: 0, test: 0 });

        const { rows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'ghl');
        assert.equal(rows[0].currency, 'USD');
        assert.equal(Number(rows[0].base_amount), 100); // pre-discount subtotal
        assert.equal(Number(rows[0].discount_amount), 15);
        assert.equal(Number(rows[0].commission_base), 85); // subtotal - discount
        assert.equal(Number(rows[0].affiliate_fee_amount), 8.5); // 85 * 0.10
        assert.equal(rows[0].ghl_order_id, order._id);
        assert.equal(rows[0].ghl_location_id, GLOBAL_LOCATION_ID);
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
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'someone@example.com' });
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

test('an unknown coupon code is auto-created as a general, GHL-origin, non-local coupon and the buyer is still recorded with 0 fee', async () => {
    const code = `GHLNEW${Date.now().toString(36).toUpperCase()}`;
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({
            amountSummary: { subtotal: 100, discount: 20 },
            coupon: { _id: 'c1', code, discountType: 'percentage', discountValue: 20 },
            contactSnapshot: { email: 'buyer@example.com', name: 'Buyer One' },
            items: []
        })
    });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 1);
        assert.equal(summary.couponsCreated, 1);
        assert.equal(summary.unassigned, 1);

        const { rows: couponRows } = await pool.query('SELECT * FROM coupons WHERE code = $1', [code]);
        assert.equal(couponRows[0].origin, 'ghl');
        assert.equal(couponRows[0].type, 'general');
        assert.equal(couponRows[0].local_enabled, false);
        assert.equal(Number(couponRows[0].discount_percent), 0.2);
        assert.equal(couponRows[0].notes, 'Discovered from GHL order');
        assert.deepEqual(couponRows[0].ghl_location_ids, [GLOBAL_LOCATION_ID]);

        const { rows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows[0].affiliate_email, null);
        assert.equal(Number(rows[0].affiliate_fee_amount), 0);
        assert.equal(rows[0].email, 'buyer@example.com');
        assert.equal(rows[0].full_name, 'Buyer One');
        assert.equal(Number(rows[0].commission_base), 80);

        // Can't be used at Local checkout.
        const validation = await couponStore.validateCouponReadOnly({ code, productId: 'test_product', email: 'x@example.com' });
        assert.equal(validation.reason, 'not_local_enabled');
    } finally {
        await cleanupCoupon(code);
    }
});

test('a non-percentage GHL coupon is created with discount_percent 0', async () => {
    const code = `GHLFLAT${Date.now().toString(36).toUpperCase()}`;
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 10 }, coupon: { code, discountType: 'amount', discountValue: 10 } })
    });
    try {
        await importGlobalOrders({});
        const { rows } = await pool.query('SELECT discount_percent FROM coupons WHERE code = $1', [code]);
        assert.equal(Number(rows[0].discount_percent), 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('imports from BOTH locations, with per-location summaries, and one location failing does not stop the other', async () => {
    const code = await createTestCoupon({ type: 'general' });
    const globalOrder = baseOrder({ couponCode: code });
    const mainOrder = baseOrder({ couponCode: code, altId: MAIN_LOCATION_ID });
    try {
        mockOrdersApi({ orders: [globalOrder], mainOrders: [mainOrder], detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } }) });
        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 2);
        assert.equal(summary.locations.global.imported, 1);
        assert.equal(summary.locations.main.imported, 1);
        assert.equal(summary.locations.main.locationId, MAIN_LOCATION_ID);

        const { rows } = await pool.query('SELECT ghl_location_id FROM coupon_redemptions WHERE code = $1 ORDER BY ghl_location_id', [code]);
        assert.deepEqual(rows.map((r) => r.ghl_location_id), [GLOBAL_LOCATION_ID, MAIN_LOCATION_ID].sort());

        // Global listing fails; main still imports a new order.
        const mainOrder2 = baseOrder({ couponCode: code, altId: MAIN_LOCATION_ID });
        mockOrdersApi({ orders: [globalOrder], mainOrders: [mainOrder2], failListingFor: GLOBAL_LOCATION_ID, detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } }) });
        const partial = await importGlobalOrders({});
        assert.equal(partial.locations.main.imported, 1);
        assert.equal(partial.locations.global.imported, 0);
        assert.ok(partial.errors.some((e) => e.startsWith('[global]') && /token rejected/.test(e)));
    } finally {
        await cleanupCoupon(code);
    }
});

test('the same unknown code seen at a second location extends the GHL-origin coupon location list', async () => {
    const code = `GHLBOTH${Date.now().toString(36).toUpperCase()}`;
    mockOrdersApi({
        orders: [baseOrder({ couponCode: code })],
        mainOrders: [baseOrder({ couponCode: code, altId: MAIN_LOCATION_ID })],
        detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } })
    });
    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.couponsCreated, 1);
        const { rows } = await pool.query('SELECT ghl_location_ids FROM coupons WHERE code = $1', [code]);
        assert.deepEqual([...rows[0].ghl_location_ids].sort(), [GLOBAL_LOCATION_ID, MAIN_LOCATION_ID].sort());
    } finally {
        await cleanupCoupon(code);
    }
});

test('a coupon with no linked affiliate is recorded with affiliate_email NULL and 0 fee', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: null });
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({ orders: [order], detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } }) });

    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 1);
        assert.equal(summary.unassigned, 1);
        const { rows } = await pool.query('SELECT affiliate_email, affiliate_fee_amount FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rows[0].affiliate_email, null);
        assert.equal(Number(rows[0].affiliate_fee_amount), 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('the affiliate fee is computed on subtotal - discount, excluding tax and shipping', async () => {
    const email = `ghl.fee.${Date.now()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: email, affiliateFeePercent: 0.10 });
    const order = baseOrder({ couponCode: code, amount: 165, subtotal: 200, discount: 50 }); // amount includes 15 tax
    mockOrdersApi({
        orders: [order],
        detailByIdFn: () => ({ amountSummary: { subtotal: 200, discount: 50, tax: 15, shipping: 0 } })
    });
    try {
        await importGlobalOrders({});
        const { rows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(Number(rows[0].commission_base), 150);
        assert.equal(Number(rows[0].affiliate_fee_amount), 15);
        assert.equal(Number(rows[0].base_amount), 200);
        assert.equal(rows[0].affiliate_email, email);
    } finally {
        await cleanupCoupon(code);
    }
});

test('dry run reads GHL but writes nothing (no redemptions, no coupons)', async () => {
    const code = `GHLDRY${Date.now().toString(36).toUpperCase()}`;
    const order = baseOrder({ couponCode: code });
    mockOrdersApi({ orders: [order], detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } }) });

    const summary = await importGlobalOrders({ backfill: true, dryRun: true });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.wouldImport, 1);
    assert.equal(summary.imported, 0);
    assert.deepEqual(summary.wouldCreateCoupons, [code]);
    const { rowCount: couponCount } = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [code]);
    const { rowCount: redemptionCount } = await pool.query('SELECT 1 FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
    assert.equal(couponCount, 0);
    assert.equal(redemptionCount, 0);
});

test('a refunded MAIN-location order releases its redemption', async () => {
    const code = await createTestCoupon({ type: 'general' });
    const order = baseOrder({ couponCode: code, altId: MAIN_LOCATION_ID });
    try {
        mockOrdersApi({ orders: [], mainOrders: [order], detailByIdFn: () => ({ amountSummary: { subtotal: 100, discount: 15 } }) });
        await importGlobalOrders({});
        mockOrdersApi({ orders: [], mainOrders: [{ ...order, paymentStatus: 'refunded' }] });
        const summary = await importGlobalOrders({});
        assert.equal(summary.locations.main.refunded, 1);
        assert.equal((await couponStore.findRedemptionByPaymentReference(`ghl:${order._id}`)).status, 'released');
    } finally {
        await cleanupCoupon(code);
    }
});

test('skips test/non-live orders', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'someone2@example.com' });
    const order = baseOrder({ couponCode: code, liveMode: false });
    const markedTest = baseOrder({ couponCode: code });
    mockOrdersApi({ orders: [order, markedTest], detailByIdFn: () => ({ markAsTest: true }) });

    try {
        const summary = await importGlobalOrders({});
        // Order 1 is liveMode:false on the list item; order 2 is only markAsTest on its detail.
        assert.equal(summary.skipped.test, 2);
        assert.equal(summary.imported, 0);
    } finally {
        await cleanupCoupon(code);
    }
});

test('never attributes a campaign, even when exactly one active GLOBAL campaign matches the order product', async () => {
    const email = `ghl.campaign.${Date.now()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: email, affiliateFeePercent: 0.10 });
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
        assert.equal(rows[0].campaign_id, null);
    } finally {
        if (campaignId) await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await cleanupCampaignSite(site.id);
        await cleanupCoupon(code);
    }
});

test('imports a recent order even when it is listed after an old (out-of-cutoff) order (sort-order independence)', async () => {
    const email = `ghl.sortorder.${Date.now()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: email, affiliateFeePercent: 0.10 });

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
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: email, affiliateFeePercent: 0.10 });
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
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: email, affiliateFeePercent: 0.10 });
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

test('every import run first retries pending affiliate-coupon pushes', async () => {
    const code = await createTestCoupon({ type: 'affiliate', affiliateEmail: 'retry@example.com' });
    await couponStore.setGhlSyncState(code, 'main', { status: 'error', locationId: MAIN_LOCATION_ID, error: 'GHL down' });
    await pool.query(`UPDATE coupons SET ghl_sync = jsonb_set(ghl_sync, '{main,at}', to_jsonb((now() - interval '5 minutes')::text)) WHERE code = $1`, [code]);

    mockOrdersApi({ orders: [], mainOrders: [] });
    ghlService.listCouponsForLocation = async () => ({ coupons: [] });
    ghlService.createCouponForLocation = async (location) => {
        return { id: `pushed_${location.locationId}` };
    };

    try {
        const summary = await importGlobalOrders({});
        // Scoped to this coupon: other test files share the database and may retry it too.
        assert.ok(summary.pushRetry, 'the import ran the pending-push retry');
        assert.equal((await couponStore.findCoupon(code)).ghlSync.main.status, 'synced');
    } finally {
        delete ghlService.listCouponsForLocation;
        delete ghlService.createCouponForLocation;
        await cleanupCoupon(code);
    }
});

// ---- Solutions page mirror (digital_solutions_transactions) ----
const solOrderIds = [];
let detailCalls = [];

/** Same as mockOrdersApi but records order-detail fetches so tests can assert on API-call frugality. */
function mockSolApi(orders, detailById) {
    detailCalls = [];
    mockOrdersApi({
        orders,
        detailByIdFn: (id) => {
            detailCalls.push(id);
            return detailById(id);
        }
    });
}

function solOrder(overrides = {}) {
    const order = baseOrder({ _id: `solorder_${Math.random().toString(36).slice(2, 10)}`, couponCode: undefined, amount: 85, createdAt: '2026-09-01T10:00:00.000Z', ...overrides });
    solOrderIds.push(order._id);
    return order;
}

afterEach(async () => {
    if (!solOrderIds.length) return;
    const refs = solOrderIds.splice(0).map((id) => `ghl:${id}`);
    await pool.query('DELETE FROM digital_solutions_transactions WHERE transaction_id = ANY($1)', [refs]);
    await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = ANY($1)', [refs]);
});

const solutionRow = async (order) => (await pool.query('SELECT * FROM digital_solutions_transactions WHERE transaction_id = $1', [`ghl:${order._id}`])).rows;

const detailFor = (order, extra = {}) => ({
    amount: order.amount,
    amountSummary: { subtotal: order.subtotal, discount: order.discount, tax: 0, shipping: 0 },
    contactSnapshot: { id: 'contact_sol', email: 'Detail.Email@Example.com', firstName: 'Detail', lastName: 'Buyer' },
    items: [
        { name: 'Item One', qty: 1, product: { _id: 'gp_1', name: 'Item One' }, price: { amount: 60 } },
        { name: 'Item Two', qty: 1, product: { _id: 'gp_2', name: 'Item Two' }, price: { amount: 40 } }
    ],
    markAsTest: false,
    ...extra
});

test('live paid coupon order: redemption (affiliate credit) AND a solutions row', async () => {
    const email = `sol.aff.${Date.now()}@example.com`;
    const code = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, affiliateEmail: email });
    const order = solOrder({ couponCode: code });
    mockSolApi([order], () => detailFor(order));
    try {
        const summary = await importGlobalOrders({});
        assert.equal(summary.imported, 1);
        assert.equal(summary.solutionsRecorded, 1);
        assert.equal(summary.solutionsUpdated, 0);

        const rows = await solutionRow(order);
        assert.equal(rows.length, 1);
        const r = rows[0];
        assert.equal(r.type, 'ghl_order');
        assert.equal(r.source, 'ghl');
        assert.equal(r.status, 'paid');
        assert.equal(r.is_test, false);
        assert.equal(r.promo_code, code);
        assert.equal(Number(r.amount), 85);
        assert.equal(r.currency, 'USD');
        assert.equal(r.customer_email, 'detail.email@example.com');
        assert.equal(r.customer_name, 'Detail Buyer');
        assert.equal(r.product_name, 'Item One, Item Two');
        assert.deepEqual(r.ghl_product_ids, ['gp_1', 'gp_2']);
        assert.equal(r.ghl_location_id, GLOBAL_LOCATION_ID);
        assert.equal(new Date(r.created_at).toISOString(), order.createdAt);

        const { rows: red } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(red.length, 1);
        assert.equal(Number(red[0].affiliate_fee_amount), 8.5);
        assert.equal(detailCalls.length, 1, 'detail fetched once and shared by both paths');
    } finally {
        await cleanupCoupon(code);
    }
});

test('test-mode order (liveMode false or markAsTest): solutions row with is_test, no redemption, no coupon created', async () => {
    const code = `GHLTEST${Date.now().toString(36).toUpperCase()}`;
    const listTest = solOrder({ couponCode: code, liveMode: false });
    const detailTest = solOrder({ couponCode: code });
    mockSolApi([listTest, detailTest], (id) => detailFor(id === detailTest._id ? detailTest : listTest, id === detailTest._id ? { markAsTest: true } : {}));
    const summary = await importGlobalOrders({});
    assert.equal(summary.solutionsRecorded, 2);
    assert.equal(summary.imported, 0);
    assert.equal(summary.skipped.test, 2);
    for (const order of [listTest, detailTest]) {
        const rows = await solutionRow(order);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].is_test, true);
        assert.equal(rows[0].promo_code, code);
        const { rowCount } = await pool.query('SELECT 1 FROM coupon_redemptions WHERE payment_reference = $1', [`ghl:${order._id}`]);
        assert.equal(rowCount, 0);
    }
    const { rowCount: couponRows } = await pool.query('SELECT 1 FROM coupons WHERE code = $1', [code]);
    assert.equal(couponRows, 0);
});

test('no-coupon order: solutions row only', async () => {
    const order = solOrder({ amount: 100, discount: 0 });
    mockSolApi([order], () => detailFor(order));
    const summary = await importGlobalOrders({});
    assert.equal(summary.solutionsRecorded, 1);
    assert.equal(summary.imported, 0);
    assert.equal(summary.skipped.noCoupon, 1);
    const rows = await solutionRow(order);
    assert.equal(rows[0].promo_code, null);
    assert.equal(rows[0].is_test, false);
});

test('invoice-sourced order is skipped everywhere', async () => {
    const order = solOrder({ sourceType: 'invoice', couponCode: undefined });
    mockSolApi([order], () => detailFor(order));
    const summary = await importGlobalOrders({});
    assert.equal(summary.solutionsRecorded, 0);
    assert.equal((await solutionRow(order)).length, 0);
    assert.equal(detailCalls.length, 0);
});

test('re-run does not duplicate or re-fetch; a status change (paid -> refunded) updates the row', async () => {
    const order = solOrder();
    mockSolApi([order], () => detailFor(order));
    await importGlobalOrders({});
    assert.equal(detailCalls.length, 1);

    const rerun = await importGlobalOrders({});
    assert.equal(rerun.solutionsRecorded, 0);
    assert.equal(rerun.solutionsUpdated, 0);
    assert.equal(detailCalls.length, 1, 'unchanged order is not re-fetched');
    assert.equal((await solutionRow(order)).length, 1);

    order.paymentStatus = 'refunded';
    const refunded = await importGlobalOrders({});
    assert.equal(refunded.solutionsUpdated, 1);
    assert.equal(refunded.solutionsRecorded, 0);
    assert.equal(detailCalls.length, 2);
    const rows = await solutionRow(order);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'refunded');
    assert.equal(new Date(rows[0].created_at).toISOString(), order.createdAt);

    order.paymentStatus = 'unpaid';
    await importGlobalOrders({});
    assert.equal((await solutionRow(order))[0].status, 'pending');
});

test('dry run writes no solutions rows', async () => {
    const order = solOrder();
    mockSolApi([order], () => detailFor(order));
    const summary = await importGlobalOrders({ dryRun: true });
    assert.equal(summary.wouldRecordSolutions, 1);
    assert.equal((await solutionRow(order)).length, 0);
});

