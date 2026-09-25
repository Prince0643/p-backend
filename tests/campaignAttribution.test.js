require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const { createTestCoupon, cleanupCoupon, signWebhookBody, paymentEventPayload } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const PRODUCT_ID = 'test_product';
const ALLOWED_URL = 'https://nexistryacademy.com/offer';
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

async function createTestCampaign({ couponCode, active = true, name = 'Attribution Campaign' } = {}) {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name, couponCode, destinationUrl: ALLOWED_URL, active });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.campaign;
}

async function cleanupCampaign(id) {
    if (!id) return;
    await pool.query('DELETE FROM campaigns WHERE id = $1', [id]);
}

// ---- (a) empty promoCode + valid attributionRef -> coupon applied + campaign_id set ----

test(
    'empty promoCode with a valid attributionRef applies the coupon and attributes the campaign',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ discountPercent: 0.15 });
        let campaignId;
        try {
            const campaign = await createTestCampaign({ couponCode: code });
            campaignId = campaign.id;

            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ attributionRef: code, campaign: campaign.slug }));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.promoCode, code);
            assert.equal(res.body.discountAmount, 75); // 500 * 0.15

            const { rows } = await pool.query(
                'SELECT campaign_id, code FROM coupon_redemptions WHERE payment_reference = $1',
                [res.body.paymentReference]
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].campaign_id, campaignId);
            assert.equal(rows[0].code, code);
        } finally {
            await cleanupCampaign(campaignId);
            await cleanupCoupon(code);
        }
    }
);

// ---- (b) typed promoCode different from ref wins; campaign not attributed ----

test(
    'a typed promoCode overrides attributionRef, and campaign is not attributed when the coupons differ',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const typedCode = await createTestCoupon({ discountPercent: 0.10 });
        const refCode = await createTestCoupon({ discountPercent: 0.20 });
        let campaignId;
        try {
            const campaign = await createTestCampaign({ couponCode: refCode });
            campaignId = campaign.id;

            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: typedCode, attributionRef: refCode, campaign: campaign.slug }));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.promoCode, typedCode);

            const { rows } = await pool.query(
                'SELECT campaign_id, code FROM coupon_redemptions WHERE payment_reference = $1',
                [res.body.paymentReference]
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].code, typedCode);
            assert.equal(rows[0].campaign_id, null);
        } finally {
            await cleanupCampaign(campaignId);
            await cleanupCoupon(typedCode);
            await cleanupCoupon(refCode);
        }
    }
);

// ---- (c) invalid/inactive attributionRef with no typed promoCode -> checkout still succeeds, no discount, no row ----

test(
    'an invalid attributionRef with no typed promoCode does not fail checkout and applies no discount',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const res = await request(app)
            .post('/api/payments/create-payment-intent')
            .send(basePayload({ attributionRef: 'NOPE99' }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.promoCode, '');
        assert.equal(res.body.discountAmount, 0);

        const { rows } = await pool.query(
            'SELECT * FROM coupon_redemptions WHERE payment_reference = $1',
            [res.body.paymentReference]
        );
        assert.equal(rows.length, 0);
    }
);

test(
    'an inactive coupon as attributionRef does not fail checkout',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ active: false });
        try {
            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ attributionRef: code }));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.promoCode, '');
        } finally {
            await cleanupCoupon(code);
        }
    }
);

// ---- (d) campaign slug whose coupon doesn't match applied coupon -> campaign_id NULL ----

test(
    'a campaign slug whose coupon does not match the applied coupon is not attributed',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const appliedCode = await createTestCoupon({ discountPercent: 0.10 });
        const otherCode = await createTestCoupon({ discountPercent: 0.10 });
        let campaignId;
        try {
            const campaign = await createTestCampaign({ couponCode: otherCode });
            campaignId = campaign.id;

            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: appliedCode, campaign: campaign.slug }));
            assert.equal(res.status, 200, JSON.stringify(res.body));

            const { rows } = await pool.query(
                'SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1',
                [res.body.paymentReference]
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].campaign_id, null);
        } finally {
            await cleanupCampaign(campaignId);
            await cleanupCoupon(appliedCode);
            await cleanupCoupon(otherCode);
        }
    }
);

// ---- (e) campaign slug exists but inactive -> not attributed even though coupon matches ----

test(
    'an inactive campaign is not attributed even when its coupon matches the applied coupon',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ discountPercent: 0.10 });
        let campaignId;
        try {
            const campaign = await createTestCampaign({ couponCode: code, active: false });
            campaignId = campaign.id;

            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: code, campaign: campaign.slug }));
            assert.equal(res.status, 200, JSON.stringify(res.body));

            const { rows } = await pool.query(
                'SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1',
                [res.body.paymentReference]
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].campaign_id, null);
        } finally {
            await cleanupCampaign(campaignId);
            await cleanupCoupon(code);
        }
    }
);

// ---- (f) webhook payment.paid transitions status and campaign stats reflect it ----

test(
    'payment.paid webhook confirms the reservation and campaign stats reflect paid count/revenue/commission',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ discountPercent: 0.15, affiliateFeePercent: 0.10 });
        let campaignId;
        try {
            const campaign = await createTestCampaign({ couponCode: code });
            campaignId = campaign.id;

            const createRes = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ attributionRef: code, campaign: campaign.slug }));
            assert.equal(createRes.status, 200, JSON.stringify(createRes.body));
            const paymentReference = createRes.body.paymentReference;

            const eventPayload = paymentEventPayload('payment.paid', {
                paymentReference,
                promoCode: code,
                campaignId,
                baseAmount: String(createRes.body.baseAmount),
                discountAmount: String(createRes.body.discountAmount),
                email: 'webhook-test@example.com',
                fullName: 'Webhook Test',
                productId: PRODUCT_ID
            });
            const { body, header } = signWebhookBody(eventPayload);
            const webhookRes = await request(app)
                .post('/api/payments/webhook')
                .set('Content-Type', 'application/json')
                .set('Paymongo-Signature', header)
                .send(body);
            assert.equal(webhookRes.status, 200);

            const { rows } = await pool.query(
                'SELECT status, campaign_id FROM coupon_redemptions WHERE payment_reference = $1',
                [paymentReference]
            );
            assert.equal(rows[0].status, 'paid');
            assert.equal(rows[0].campaign_id, campaignId);

            const statsRes = await request(app)
                .get(`/api/admin/campaigns/${campaignId}`)
                .set('x-api-key', ADMIN_KEY);
            assert.equal(statsRes.status, 200);
            assert.equal(statsRes.body.campaign.stats.paidCount, 1);
            assert.equal(statsRes.body.campaign.stats.revenue, createRes.body.baseAmount);
            assert.ok(statsRes.body.campaign.stats.commissionTotal > 0);
        } finally {
            await cleanupCampaign(campaignId);
            await cleanupCoupon(code);
        }
    }
);

// ---- (g) deleting a campaign with redemptions still succeeds; campaign_id becomes NULL ----

test('deleting a campaign with existing redemptions succeeds and sets campaign_id to NULL', async () => {
    const code = await createTestCoupon({ discountPercent: 0.10, affiliateFeePercent: 0.05 });
    let campaignId;
    const paymentReference = `PAYTEST${Date.now()}CAMP`;
    try {
        const campaign = await createTestCampaign({ couponCode: code });
        campaignId = campaign.id;

        const reservation = await couponStore.beginCouponReservation({ code, productId: PRODUCT_ID });
        assert.ok(reservation.coupon, `expected reservation to succeed: ${reservation.error}`);
        await couponStore.finalizeCouponReservation(reservation.client, {
            code,
            paymentReference,
            productId: PRODUCT_ID,
            email: 'fk-test@example.com',
            fullName: 'FK Test',
            baseAmount: 450,
            discountAmount: 50,
            affiliateFeeAmount: 22.5,
            currency: 'PHP',
            campaignId
        });

        let { rows } = await pool.query('SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        assert.equal(rows[0].campaign_id, campaignId);

        const del = await request(app)
            .delete(`/api/admin/campaigns/${campaignId}`)
            .set('x-api-key', ADMIN_KEY);
        assert.equal(del.status, 200);
        campaignId = null;

        const redemption = await couponStore.findRedemptionByPaymentReference(paymentReference);
        assert.ok(redemption);
        assert.equal(redemption.campaignId, null);

        ({ rows } = await pool.query('SELECT campaign_id FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]));
        assert.equal(rows[0].campaign_id, null);
    } finally {
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

// ---- (h) GET /public/nx-ref.js headers ----

test('GET /public/nx-ref.js serves cross-origin CORP and JS content-type', async () => {
    const res = await request(app).get('/public/nx-ref.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(res.headers['content-type'], /javascript/);
});

// ---- (i) nx-ref.js fetch-wrapper smoke test via vm ----

function loadNxRefInFakeWindow({ locationSearch = '', cookie = '', localStorageData = null } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'nx-ref.js'), 'utf8');

    const calls = [];
    const fakeFetch = (input, init) => {
        calls.push({ input, init });
        return Promise.resolve({ ok: true, json: async () => ({}) });
    };

    const storageBacking = localStorageData ? { nx_ref: JSON.stringify(localStorageData) } : {};
    const fakeLocalStorage = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(storageBacking, k) ? storageBacking[k] : null),
        setItem: (k, v) => { storageBacking[k] = String(v); },
        removeItem: (k) => { delete storageBacking[k]; }
    };

    const fakeDocument = {
        cookie: cookie,
        readyState: 'complete',
        body: {},
        addEventListener: () => {},
        querySelector: () => null,
        createElement: () => ({})
    };

    const sandbox = {
        window: {
            location: { search: locationSearch, hostname: 'checkout.example.com', protocol: 'https:', href: `https://checkout.example.com/${locationSearch}` },
            localStorage: fakeLocalStorage,
            fetch: fakeFetch
        },
        document: fakeDocument,
        localStorage: fakeLocalStorage,
        URL,
        URLSearchParams,
        MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
        setTimeout,
        clearTimeout,
        Request: typeof Request !== 'undefined' ? Request : undefined,
        console
    };
    sandbox.window.document = fakeDocument;
    sandbox.global = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'nx-ref.js' });

    return { sandbox, calls };
}

test('nx-ref.js fetch wrapper injects promoCode/campaign/attributionRef when ref is available', async () => {
    const { sandbox } = loadNxRefInFakeWindow({ locationSearch: '?ref=ABC123&campaign=spring-sale' });

    assert.equal(sandbox.window.NexistryRef.ref, 'ABC123');
    assert.equal(sandbox.window.NexistryRef.campaign, 'spring-sale');

    const result = await sandbox.window.fetch('/api/payments/create-payment-intent', {
        method: 'POST',
        body: JSON.stringify({ fullName: 'Test' })
    });
    assert.ok(result.ok);
});

test('nx-ref.js fetch wrapper passes through unrelated URLs unmodified', async () => {
    const { sandbox, calls } = loadNxRefInFakeWindow({ locationSearch: '?ref=ABC123' });

    await sandbox.window.fetch('/api/products', {
        method: 'POST',
        body: JSON.stringify({ hello: 'world' })
    });

    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).hello, 'world');
    assert.equal(JSON.parse(calls[0].init.body).promoCode, undefined);
});

test('nx-ref.js fetch wrapper does not overwrite an already-present promoCode', async () => {
    const { sandbox, calls } = loadNxRefInFakeWindow({ locationSearch: '?ref=ABC123&campaign=spring-sale' });

    await sandbox.window.fetch('/api/payments/create-payment-intent', {
        method: 'POST',
        body: JSON.stringify({ fullName: 'Test', promoCode: 'TYPEDCODE' })
    });

    assert.equal(calls.length, 1);
    const parsed = JSON.parse(calls[0].init.body);
    assert.equal(parsed.promoCode, 'TYPEDCODE');
    // attributionRef/campaign are still attached even when promoCode was already present.
    assert.equal(parsed.attributionRef, 'ABC123');
    assert.equal(parsed.campaign, 'spring-sale');
});

// ---- promoCode === attributionRef bug fix: nx-ref.js prefills #promoCode with the ref,
// so the request's promoCode is just an echo of attributionRef, not something the
// customer typed. That must still be treated as the soft ref path (never a 400), while
// a promoCode that genuinely differs from attributionRef keeps hard-failing checkout. ----

test(
    'promoCode equal to attributionRef with an inactive coupon does not fail checkout (auto-filled field, not customer-typed)',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ active: false });
        try {
            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                // Mirrors what nx-ref.js actually sends once it has prefilled #promoCode:
                // promoCode and attributionRef carry the identical value.
                .send(basePayload({ promoCode: code, attributionRef: code }));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.promoCode, '');
            assert.equal(res.body.discountAmount, 0);

            const { rows } = await pool.query(
                'SELECT * FROM coupon_redemptions WHERE payment_reference = $1',
                [res.body.paymentReference]
            );
            assert.equal(rows.length, 0);
        } finally {
            await cleanupCoupon(code);
        }
    }
);

test(
    'promoCode equal to attributionRef but case/format-different still counts as auto-filled, not typed',
    { skip: hasPaymongoKey ? false : 'requires PAYMONGO_SECRET_KEY to create a real test-mode payment intent' },
    async () => {
        const code = await createTestCoupon({ active: false });
        try {
            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: code.toLowerCase(), attributionRef: code }));
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.promoCode, '');
        } finally {
            await cleanupCoupon(code);
        }
    }
);

test(
    'a typed promoCode that differs from attributionRef and is itself invalid still hard-fails checkout with 400',
    async () => {
        const validRefCode = await createTestCoupon();
        try {
            const res = await request(app)
                .post('/api/payments/create-payment-intent')
                .send(basePayload({ promoCode: 'TOTALLY-BOGUS-CODE', attributionRef: validRefCode }));
            assert.equal(res.status, 400, JSON.stringify(res.body));
            assert.ok(res.body.error);
        } finally {
            await cleanupCoupon(validRefCode);
        }
    }
);

// ---- webhook fallback FK robustness: campaignId in PayMongo metadata can go stale if the
// campaign was deleted between checkout and the payment.paid webhook firing. The redemption
// must still be recorded (with campaign_id nulled), never dropped. ----

test(
    'webhook fallback records the redemption even if the referenced campaign was deleted before payment.paid arrives',
    async () => {
        const code = await createTestCoupon({ discountPercent: 0.15, affiliateFeePercent: 0.10, maxRedemptions: null });
        const campaign = await createTestCampaign({ couponCode: code });
        // Simulate the campaign being deleted after checkout metadata was captured but
        // before the payment.paid webhook is processed - the stale campaignId below is
        // exactly what a real PayMongo metadata payload would still be carrying.
        await cleanupCampaign(campaign.id);

        const paymentReference = `PAYSTALECAMP${Date.now().toString(36).toUpperCase()}`;
        try {
            const eventPayload = paymentEventPayload('payment.paid', {
                paymentReference,
                promoCode: code,
                campaignId: campaign.id,
                baseAmount: '500',
                discountAmount: '75',
                email: 'stale-campaign-webhook@example.com',
                fullName: 'Stale Campaign Webhook',
                productId: PRODUCT_ID
            });
            const { body, header } = signWebhookBody(eventPayload);
            const webhookRes = await request(app)
                .post('/api/payments/webhook')
                .set('Content-Type', 'application/json')
                .set('Paymongo-Signature', header)
                .send(body);
            assert.equal(webhookRes.status, 200);

            const { rows } = await pool.query(
                'SELECT status, campaign_id, code FROM coupon_redemptions WHERE payment_reference = $1',
                [paymentReference]
            );
            assert.equal(rows.length, 1, 'redemption must still be recorded despite the stale campaign_id');
            assert.equal(rows[0].status, 'paid');
            assert.equal(rows[0].code, code);
            assert.equal(rows[0].campaign_id, null);
        } finally {
            await cleanupCoupon(code);
        }
    }
);

test('couponStore.recordRedemption falls back to campaign_id null on a foreign-key violation', async () => {
    const code = await createTestCoupon();
    const paymentReference = `PAYFKUNIT${Date.now().toString(36).toUpperCase()}`;
    try {
        const redemption = await couponStore.recordRedemption({
            code,
            paymentReference,
            productId: PRODUCT_ID,
            email: 'fk-unit-test@example.com',
            fullName: 'FK Unit Test',
            baseAmount: 100,
            discountAmount: 0,
            affiliateFeeAmount: 0,
            currency: 'PHP',
            campaignId: 'CMP_DOES_NOT_EXIST'
        });
        assert.ok(redemption);
        assert.equal(redemption.campaignId, null);
        assert.equal(redemption.status, 'paid');
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
        await cleanupCoupon(code);
    }
});

after(async () => {
    await pool.end();
});
