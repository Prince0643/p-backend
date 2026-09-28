// tests/couponRules.test.js
// Covers the AFFILIATE vs GENERAL coupon business rules from the coupon-types sprint:
// unlimited affiliate redemptions, the cross-code "one affiliate discount ever" rule,
// the general "once per customer per code" rule, local_enabled gating, and the
// migration "only import into an empty table" safety net.
require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { isTableEmpty } = require('../db/migrate');
const { createTestCoupon, cleanupCoupon } = require('./fixtures');

const PRODUCT_ID = 'test_product';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

function basePayload(overrides = {}) {
    return {
        fullName: 'Test User',
        email: `test.${Math.random().toString(36).slice(2, 8)}@example.com`,
        mobile: '+639171234567',
        productId: PRODUCT_ID,
        ...overrides
    };
}

after(async () => {
    await pool.end();
});

test('migrate.isTableEmpty reports empty vs non-empty correctly', async () => {
    const client = await pool.connect();
    try {
        await client.query('CREATE TEMP TABLE _migrate_empty_check (id int)');
        assert.equal(await isTableEmpty(client, '_migrate_empty_check'), true);
        await client.query('INSERT INTO _migrate_empty_check VALUES (1)');
        assert.equal(await isTableEmpty(client, '_migrate_empty_check'), false);
    } finally {
        client.release();
    }
});

test('an affiliate coupon has no total redemption cap - two different customers can both use it', async () => {
    const code = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    try {
        const first = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'customer.one@example.com' });
        assert.ok(first.coupon, `expected first reservation to succeed: ${first.error}`);
        await couponStore.finalizeCouponReservation(first.client, {
            code, paymentReference: `PAYRULE${Date.now()}A`, productId: PRODUCT_ID, email: 'customer.one@example.com',
            fullName: 'Customer One', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });

        const second = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'customer.two@example.com' });
        assert.ok(second.coupon, `expected a different customer to also succeed: ${second.error}`);
        await couponStore.abortCouponReservation(second.client);
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = $1`, [code]);
        await cleanupCoupon(code);
    }
});

test('a customer who already used one affiliate code cannot get an affiliate discount from a DIFFERENT affiliate code', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'cross-code-customer@example.com';
    try {
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        assert.ok(first.coupon, `expected first reservation to succeed: ${first.error}`);
        const paymentReference = `PAYRULE${Date.now()}B`;
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'Cross Code Customer', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });
        // Must be a genuinely PAID use to block - a merely pending/abandoned attempt is
        // superseded instead (see the dedicated "abandons checkout" test below).
        await couponStore.markReservationPaid({ paymentReference });

        const second = await couponStore.beginCouponReservation({ code: codeB, productId: PRODUCT_ID, email });
        assert.equal(second.coupon, undefined);
        assert.equal(second.reason, 'affiliate_already_used');
        assert.equal(second.error, 'You have already used an affiliate discount.');
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('a customer who abandons checkout and retries within the TTL is NOT blocked by their own dangling pending reservation (affiliate, cross-code)', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'affiliate-abandon-retry@example.com';
    const firstPaymentReference = `PAYRULE${Date.now()}ABANDON1`;
    try {
        // First attempt: reserve codeA and leave it pending (abandoned the PayMongo page -
        // never finalized/paid).
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        assert.ok(first.coupon, `expected first reservation to succeed: ${first.error}`);
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference: firstPaymentReference, productId: PRODUCT_ID, email,
            fullName: 'Affiliate Abandon Retry', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });
        const { rows: beforeRows } = await pool.query('SELECT status FROM coupon_redemptions WHERE payment_reference = $1', [firstPaymentReference]);
        assert.equal(beforeRows[0].status, 'pending');

        // Retry within the TTL with a DIFFERENT affiliate code - must be allowed, not
        // blocked by the still-fresh pending row from the abandoned first attempt. The
        // retry is FINALIZED (checkout actually completes this time), so the supersede of
        // the old row is committed, not rolled back - see the separate "rolled back if
        // aborted" test for the abort case.
        const retry = await couponStore.beginCouponReservation({ code: codeB, productId: PRODUCT_ID, email });
        assert.ok(retry.coupon, `expected the retry to succeed: ${retry.error}`);
        await couponStore.finalizeCouponReservation(retry.client, {
            code: codeB, paymentReference: `PAYRULE${Date.now()}ABANDON2`, productId: PRODUCT_ID, email,
            fullName: 'Affiliate Abandon Retry', baseAmount: 400, discountAmount: 100, affiliateFeeAmount: 40, currency: 'PHP'
        });

        // The old pending row must have been superseded (released), not left dangling.
        const { rows: afterRows } = await pool.query('SELECT status FROM coupon_redemptions WHERE payment_reference = $1', [firstPaymentReference]);
        assert.equal(afterRows[0].status, 'released');
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('after a PAID affiliate use, a retry is still blocked (superseding only applies to unpaid/pending attempts)', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'affiliate-paid-then-retry@example.com';
    try {
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        const paymentReference = `PAYRULE${Date.now()}PAIDRETRY`;
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'Affiliate Paid Then Retry', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });
        await couponStore.markReservationPaid({ paymentReference });

        const retry = await couponStore.beginCouponReservation({ code: codeB, productId: PRODUCT_ID, email });
        assert.equal(retry.coupon, undefined);
        assert.equal(retry.reason, 'affiliate_already_used');
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('superseding a dangling reservation is rolled back if the retry itself ultimately fails/aborts', async () => {
    // Regression guard: beginCouponReservation releases the customer's own dangling
    // pending row INSIDE the same not-yet-committed transaction, so if the retry is
    // aborted (never finalized), the release must roll back too - the original pending
    // row must still be there (and still count toward max_redemptions) rather than being
    // silently lost.
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.1, maxRedemptions: 5 });
    const email = 'general-abandon-then-abort@example.com';
    const paymentReference = `PAYRULE${Date.now()}ABORTED`;
    try {
        const first = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email });
        await couponStore.finalizeCouponReservation(first.client, {
            code, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'General Abandon Then Abort', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });

        const retry = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email });
        assert.ok(retry.coupon, `expected the retry to succeed: ${retry.error}`);
        await couponStore.abortCouponReservation(retry.client);

        const { rows } = await pool.query('SELECT status FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        assert.equal(rows[0].status, 'pending', 'an aborted retry must not leave the earlier reservation released');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        await cleanupCoupon(code);
    }
});

test('markReservationPaid still marks a SUPERSEDED (released) row paid if that specific payment completes anyway', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'superseded-but-paid-anyway@example.com';
    const oldPaymentReference = `PAYRULE${Date.now()}OLDPAY`;
    try {
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference: oldPaymentReference, productId: PRODUCT_ID, email,
            fullName: 'Superseded But Paid Anyway', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });

        // Customer retries with a different code, superseding (releasing) the old row.
        const retry = await couponStore.beginCouponReservation({ code: codeB, productId: PRODUCT_ID, email });
        await couponStore.finalizeCouponReservation(retry.client, {
            code: codeB, paymentReference: `PAYRULE${Date.now()}NEWPAY`, productId: PRODUCT_ID, email,
            fullName: 'Superseded But Paid Anyway', baseAmount: 400, discountAmount: 100, affiliateFeeAmount: 40, currency: 'PHP'
        });

        const { rows: releasedRows } = await pool.query('SELECT status FROM coupon_redemptions WHERE payment_reference = $1', [oldPaymentReference]);
        assert.equal(releasedRows[0].status, 'released');

        // The OLD checkout's PayMongo payment somehow completes anyway (e.g. the customer
        // had two tabs open) - the webhook path must still record it as paid rather than
        // silently dropping real, received money.
        const confirmed = await couponStore.markReservationPaid({ paymentReference: oldPaymentReference });
        assert.ok(confirmed, 'a superseded reservation whose payment actually completes must still be confirmed paid');
        assert.equal(confirmed.status, 'paid');

        const { rows: afterRows } = await pool.query('SELECT status, paid_at FROM coupon_redemptions WHERE payment_reference = $1', [oldPaymentReference]);
        assert.equal(afterRows[0].status, 'paid');
        assert.ok(afterRows[0].paid_at);
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('HTTP: an explicit promoCode that violates the cross-code affiliate rule hard-fails checkout with 400', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'http-cross-code-customer@example.com';
    try {
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        const paymentReference = `PAYRULE${Date.now()}C`;
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'HTTP Cross Code Customer', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });
        await couponStore.markReservationPaid({ paymentReference });

        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ email, promoCode: codeB }));
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error, 'You have already used an affiliate discount.');
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('the soft ref path (nx-ref attribution) never hard-fails on the cross-code affiliate rule - it just proceeds without a discount', async () => {
    const codeA = await createTestCoupon({ type: 'affiliate', discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
    const codeB = await createTestCoupon({ type: 'affiliate', discountPercent: 0.20, affiliateFeePercent: 0.10, maxRedemptions: null });
    const email = 'ref-path-cross-code-customer@example.com';
    const hasPaymongoKey = Boolean(process.env.PAYMONGO_SECRET_KEY);
    try {
        const first = await couponStore.beginCouponReservation({ code: codeA, productId: PRODUCT_ID, email });
        const paymentReference = `PAYRULE${Date.now()}D`;
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeA, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'Ref Path Cross Code Customer', baseAmount: 425, discountAmount: 75, affiliateFeeAmount: 42.5, currency: 'PHP'
        });
        await couponStore.markReservationPaid({ paymentReference });

        if (!hasPaymongoKey) return; // proceeding past reservation requires a real PayMongo call
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ email, attributionRef: codeB }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.promoCode, '');
        assert.equal(res.body.discountAmount, 0);
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeA, codeB]]);
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('a general coupon is once-per-customer-per-code: same code+email blocked, but a different code is fine', async () => {
    const codeC = await createTestCoupon({ type: 'general', discountPercent: 0.10, maxRedemptions: null });
    const codeD = await createTestCoupon({ type: 'general', discountPercent: 0.10, maxRedemptions: null });
    const email = 'general-repeat-customer@example.com';
    try {
        const first = await couponStore.beginCouponReservation({ code: codeC, productId: PRODUCT_ID, email });
        assert.ok(first.coupon, `expected first reservation to succeed: ${first.error}`);
        const paymentReference = `PAYRULE${Date.now()}E`;
        await couponStore.finalizeCouponReservation(first.client, {
            code: codeC, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'General Repeat Customer', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });
        // Must be a genuinely PAID use to block - a merely pending/abandoned attempt is
        // superseded instead (see the dedicated "abandons checkout" test below).
        await couponStore.markReservationPaid({ paymentReference });

        const sameCodeAgain = await couponStore.beginCouponReservation({ code: codeC, productId: PRODUCT_ID, email });
        assert.equal(sameCodeAgain.coupon, undefined);
        assert.equal(sameCodeAgain.reason, 'coupon_already_used');
        assert.equal(sameCodeAgain.error, 'You have already used this coupon.');

        const differentCode = await couponStore.beginCouponReservation({ code: codeD, productId: PRODUCT_ID, email });
        assert.ok(differentCode.coupon, `a different general code must still be usable: ${differentCode.error}`);
        await couponStore.abortCouponReservation(differentCode.client);
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = ANY($1::text[])`, [[codeC, codeD]]);
        await cleanupCoupon(codeC);
        await cleanupCoupon(codeD);
    }
});

test('a customer who abandons a general-coupon checkout and retries within the TTL is NOT blocked by their own dangling pending reservation', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.1, maxRedemptions: null });
    const email = 'general-abandon-retry@example.com';
    const firstPaymentReference = `PAYRULE${Date.now()}GENABANDON`;
    try {
        const first = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email });
        assert.ok(first.coupon, `expected first reservation to succeed: ${first.error}`);
        await couponStore.finalizeCouponReservation(first.client, {
            code, paymentReference: firstPaymentReference, productId: PRODUCT_ID, email,
            fullName: 'General Abandon Retry', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });

        // Same code, same customer, still within the TTL - must be allowed (this is a
        // retry of the abandoned attempt, not a second use). Finalized (not aborted) so
        // the supersede of the old row actually commits.
        const retry = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email });
        assert.ok(retry.coupon, `expected the retry to succeed: ${retry.error}`);
        await couponStore.finalizeCouponReservation(retry.client, {
            code, paymentReference: `PAYRULE${Date.now()}GENABANDON2`, productId: PRODUCT_ID, email,
            fullName: 'General Abandon Retry', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });

        const { rows } = await pool.query('SELECT status FROM coupon_redemptions WHERE payment_reference = $1', [firstPaymentReference]);
        assert.equal(rows[0].status, 'released');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
        await cleanupCoupon(code);
    }
});

test('a different customer\'s fresh pending reservation still counts toward a general coupon\'s max_redemptions', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.1, maxRedemptions: 1 });
    try {
        const holder = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'max-redemptions-holder@example.com' });
        assert.ok(holder.coupon, `expected the first customer's reservation to succeed: ${holder.error}`);
        await couponStore.finalizeCouponReservation(holder.client, {
            code, paymentReference: `PAYRULE${Date.now()}MAXHOLD`, productId: PRODUCT_ID, email: 'max-redemptions-holder@example.com',
            fullName: 'Max Redemptions Holder', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });

        // A totally different customer must be blocked by the fresh (still-pending)
        // hold above, even though THEY have never used this code before - the
        // per-customer-once-per-code supersede logic only releases the REQUESTING
        // customer's own dangling rows, never another customer's.
        const other = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'max-redemptions-other-customer@example.com' });
        assert.equal(other.coupon, undefined);
        assert.equal(other.reason, 'max_redemptions_reached');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
        await cleanupCoupon(code);
    }
});

test('HTTP: an explicit promoCode that repeats a general coupon for the same customer hard-fails checkout with 400', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.10, maxRedemptions: null });
    const email = 'http-general-repeat-customer@example.com';
    try {
        const first = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email });
        const paymentReference = `PAYRULE${Date.now()}F`;
        await couponStore.finalizeCouponReservation(first.client, {
            code, paymentReference, productId: PRODUCT_ID, email,
            fullName: 'HTTP General Repeat Customer', baseAmount: 450, discountAmount: 50, affiliateFeeAmount: 0, currency: 'PHP'
        });
        await couponStore.markReservationPaid({ paymentReference });

        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ email, promoCode: code }));
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error, 'You have already used this coupon.');
    } finally {
        await pool.query(`DELETE FROM coupon_redemptions WHERE code = $1`, [code]);
        await cleanupCoupon(code);
    }
});

test('a general coupon with localEnabled:false is rejected on Local checkout as an invalid code', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.10, localEnabled: false });
    try {
        const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: 'local-disabled@example.com' });
        assert.equal(reservation.coupon, undefined);
        assert.equal(reservation.reason, 'not_local_enabled');
        assert.equal(reservation.error, 'This coupon is not valid for this checkout.');
    } finally {
        await cleanupCoupon(code);
    }
});

test('HTTP: a localEnabled:false coupon typed explicitly hard-fails checkout with the invalid-coupon message', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.10, localEnabled: false });
    try {
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ promoCode: code }));
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error, 'This coupon is not valid for this checkout.');
    } finally {
        await cleanupCoupon(code);
    }
});

test('applying a coupon without an email is rejected (the checkout itself still requires email as a top-level field)', async () => {
    const code = await createTestCoupon({ type: 'general', discountPercent: 0.1 });
    try {
        const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID, email: '' });
        assert.equal(reservation.coupon, undefined);
        assert.equal(reservation.reason, 'email_required');
    } finally {
        await cleanupCoupon(code);
    }
});

test('affiliate registration creates a type=affiliate coupon with an unlimited (null) max_redemptions', async () => {
    const email = `couponrules.affiliate.${Date.now()}@example.com`;
    try {
        const reg = await request(app).post('/api/affiliates/register').send({
            firstName: 'Rules', lastName: 'Affiliate', email, password: 'testpassword123', contactNumber: '+639171234567',
            paymentRegion: 'GLOBAL', preferredBank: 'WISE', globalAccountName: 'Rules Affiliate', globalAccountEmail: email, termsAccepted: true
        });
        assert.equal(reg.status, 201);
        const coupon = await couponStore.findCoupon(reg.body.couponCode);
        assert.equal(coupon.type, 'affiliate');
        assert.equal(coupon.maxRedemptions, null);
        assert.equal(coupon.localEnabled, true);
    } finally {
        const { rows } = await pool.query('SELECT coupon_code FROM affiliates WHERE email = $1', [email]);
        await pool.query('DELETE FROM affiliates WHERE email = $1', [email]);
        for (const row of rows) if (row.coupon_code) await cleanupCoupon(row.coupon_code);
    }
});

test('admins cannot create an affiliate-type coupon, and cannot change an existing coupon\'s type', async () => {
    const createAttempt = await request(app)
        .post('/api/admin/coupons')
        .set('x-api-key', ADMIN_KEY)
        .send({ code: `NOPE${Date.now()}`, type: 'affiliate', discountPercent: 0.1 });
    assert.equal(createAttempt.status, 400);

    const code = await createTestCoupon({ type: 'general', discountPercent: 0.1 });
    try {
        const changeAttempt = await request(app)
            .put(`/api/admin/coupons/${code}`)
            .set('x-api-key', ADMIN_KEY)
            .send({ discountPercent: 0.2, type: 'affiliate' });
        assert.equal(changeAttempt.status, 400);

        const unchanged = await couponStore.findCoupon(code);
        assert.equal(unchanged.type, 'general');
    } finally {
        await cleanupCoupon(code);
    }
});

test('GET /api/admin/coupons?type= filters by coupon type', async () => {
    const generalCode = await createTestCoupon({ type: 'general', discountPercent: 0.1 });
    try {
        const res = await request(app).get('/api/admin/coupons?type=general').set('x-api-key', ADMIN_KEY);
        assert.equal(res.status, 200);
        assert.ok(res.body.coupons.every((c) => c.type === 'general'));
        assert.ok(res.body.coupons.some((c) => c.code === generalCode));
    } finally {
        await cleanupCoupon(generalCode);
    }
});

test('GET /api/admin/coupons/ghl-locations requires admin auth and returns the configured locations', async () => {
    const unauth = await request(app).get('/api/admin/coupons/ghl-locations');
    assert.equal(unauth.status, 401);

    const res = await request(app).get('/api/admin/coupons/ghl-locations').set('x-api-key', ADMIN_KEY);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.locations));
});

test('POST /api/admin/coupons/ghl/sync?dryRun=1 reports a plan without needing configured GHL locations to error the whole coupon list', async () => {
    const res = await request(app).post('/api/admin/coupons/ghl/sync?dryRun=1').set('x-api-key', ADMIN_KEY);
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.dryRun, true);
});
