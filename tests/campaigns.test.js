require('./setupEnv');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate, createTestCampaignSite, cleanupCampaignSite } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;

// NODE_ENV is forced to 'test' by setupEnv.js, so the store's "allow http/localhost
// outside production" branch is active here.
let SITE;
let ALLOWED_URL;

before(async () => {
    SITE = await createTestCampaignSite({ name: 'Campaign Test Site', channel: 'local' });
    ALLOWED_URL = `${SITE.url}/offer?utm_source=email`;
});

after(async () => {
    await cleanupCampaignSite(SITE?.id);
    await pool.end();
});

async function cleanupCampaign(id) {
    if (!id) return;
    await pool.query('DELETE FROM campaigns WHERE id = $1', [id]);
}

function registrationPayload(email) {
    return {
        firstName: 'Campaign',
        lastName: 'Affiliate',
        email,
        password: 'testpassword123',
        contactNumber: '+639171234567',
        paymentRegion: 'GLOBAL',
        preferredBank: 'WISE',
        globalAccountName: 'Campaign Affiliate',
        globalAccountEmail: email,
        termsAccepted: true
    };
}

test('admin routes require authentication', async () => {
    const res = await request(app).get('/api/admin/campaigns');
    assert.equal(res.status, 401);
});

test('creates a campaign and builds the link correctly, preserving existing query params', async () => {
    const code = await createTestCoupon();
    let campaignId;
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Spring Sale', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.campaign.name, 'Spring Sale');
        assert.equal(res.body.campaign.slug, 'spring-sale');
        assert.equal(res.body.campaign.couponCode, code);
        assert.equal(res.body.campaign.active, true);
        assert.equal(res.body.campaign.siteId, SITE.id);
        assert.equal(res.body.campaign.siteChannel, 'local');
        campaignId = res.body.campaign.id;

        const link = new URL(res.body.campaign.link);
        assert.equal(link.origin + link.pathname, `${SITE.url}/offer`);
        assert.equal(link.searchParams.get('utm_source'), 'email');
        assert.equal(link.searchParams.get('ref'), code);
        assert.equal(link.searchParams.get('campaign'), 'spring-sale');
    } finally {
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

test('overwrites existing ref/campaign params in the destination URL', async () => {
    const code = await createTestCoupon();
    let campaignId;
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({
                name: 'Overwrite Test',
                couponCode: code,
                siteId: SITE.id,
                destinationUrl: `${SITE.url}/offer?ref=OLDCODE&campaign=old-slug&keep=me`
            });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        campaignId = res.body.campaign.id;

        const link = new URL(res.body.campaign.link);
        assert.equal(link.searchParams.get('ref'), code);
        assert.equal(link.searchParams.get('campaign'), res.body.campaign.slug);
        assert.equal(link.searchParams.get('keep'), 'me');
    } finally {
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

test('requires a siteId', async () => {
    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'No Site', couponCode: code, destinationUrl: ALLOWED_URL });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /siteId is required/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects an unknown siteId', async () => {
    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Bad Site', couponCode: code, destinationUrl: ALLOWED_URL, siteId: 'SITE_DOES_NOT_EXIST' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /does not exist/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects a destination on a foreign domain (must match the chosen site)', async () => {
    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Bad Domain', couponCode: code, destinationUrl: 'https://example.com/offer', siteId: SITE.id });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /must match the selected campaign site/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects a look-alike/subdomain host that does not exactly match the site host', async () => {
    const code = await createTestCoupon();
    const foreignHost = `evil${new URL(SITE.url).hostname}`;
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Lookalike', couponCode: code, destinationUrl: `https://${foreignHost}/offer`, siteId: SITE.id });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /must match the selected campaign site/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects non-https destinations in production', async (t) => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { process.env.NODE_ENV = originalEnv; });

    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Insecure', couponCode: code, destinationUrl: `http://${new URL(SITE.url).hostname}/offer`, siteId: SITE.id });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /https/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects an unknown coupon code', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'No Coupon', couponCode: 'NOPE99', destinationUrl: ALLOWED_URL, siteId: SITE.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /does not exist/i);
});

test('rejects a duplicate slug with 409', async () => {
    const code = await createTestCoupon();
    let firstId;
    try {
        const first = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Dup Slug', slug: 'dup-slug-test', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Dup Slug Again', slug: 'dup-slug-test', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(second.status, 409);
    } finally {
        await cleanupCampaign(firstId);
        await cleanupCoupon(code);
    }
});

test('auto-generated slugs de-duplicate with a numeric suffix', async () => {
    const code = await createTestCoupon();
    let firstId, secondId;
    try {
        const first = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Repeatable Name', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Repeatable Name', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(second.status, 201);
        secondId = second.body.campaign.id;

        assert.notEqual(first.body.campaign.slug, second.body.campaign.slug);
    } finally {
        await cleanupCampaign(firstId);
        await cleanupCampaign(secondId);
        await cleanupCoupon(code);
    }
});

test('GET/PUT/DELETE single campaign: 404 on missing, full CRUD works', async () => {
    const code = await createTestCoupon();
    let campaignId;
    try {
        const missing = await request(app).get('/api/admin/campaigns/DOES_NOT_EXIST').set('x-api-key', ADMIN_KEY);
        assert.equal(missing.status, 404);

        const create = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'CRUD Test', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(create.status, 201);
        campaignId = create.body.campaign.id;

        const get = await request(app).get(`/api/admin/campaigns/${campaignId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(get.status, 200);
        assert.equal(get.body.campaign.id, campaignId);

        const update = await request(app)
            .put(`/api/admin/campaigns/${campaignId}`)
            .set('x-api-key', ADMIN_KEY)
            .send({ active: false, notes: 'paused' });
        assert.equal(update.status, 200);
        assert.equal(update.body.campaign.active, false);
        assert.equal(update.body.campaign.notes, 'paused');
        // Unrelated fields should be untouched by the partial update.
        assert.equal(update.body.campaign.name, 'CRUD Test');

        const del = await request(app).delete(`/api/admin/campaigns/${campaignId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(del.status, 200);
        campaignId = null;

        const afterDelete = await request(app).get(`/api/admin/campaigns/${create.body.campaign.id}`).set('x-api-key', ADMIN_KEY);
        assert.equal(afterDelete.status, 404);

        const deleteMissing = await request(app).delete(`/api/admin/campaigns/${create.body.campaign.id}`).set('x-api-key', ADMIN_KEY);
        assert.equal(deleteMissing.status, 404);
    } finally {
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

test('affiliate sees only their own active campaigns', async () => {
    const emailA = `campaign.aff.a.${Date.now()}@example.com`;
    const emailB = `campaign.aff.b.${Date.now()}@example.com`;
    let campaignActiveId, campaignInactiveId, otherCampaignId;
    try {
        const regA = await request(app).post('/api/affiliates/register').send(registrationPayload(emailA));
        assert.equal(regA.status, 201);
        const regB = await request(app).post('/api/affiliates/register').send(registrationPayload(emailB));
        assert.equal(regB.status, 201);

        const tokenA = regA.body.token;
        const couponA = regA.body.couponCode;
        const couponB = regB.body.couponCode;

        const activeRes = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Affiliate A Active', couponCode: couponA, destinationUrl: ALLOWED_URL, active: true, siteId: SITE.id });
        assert.equal(activeRes.status, 201);
        campaignActiveId = activeRes.body.campaign.id;

        const inactiveRes = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Affiliate A Inactive', couponCode: couponA, destinationUrl: ALLOWED_URL, active: false, siteId: SITE.id });
        assert.equal(inactiveRes.status, 201);
        campaignInactiveId = inactiveRes.body.campaign.id;

        const otherRes = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Affiliate B Active', couponCode: couponB, destinationUrl: ALLOWED_URL, active: true, siteId: SITE.id });
        assert.equal(otherRes.status, 201);
        otherCampaignId = otherRes.body.campaign.id;

        const mine = await request(app).get('/api/affiliates/me/campaigns').set('Authorization', `Bearer ${tokenA}`);
        assert.equal(mine.status, 200);
        const ids = mine.body.campaigns.map((c) => c.id);
        assert.deepEqual(ids, [campaignActiveId]);

        const unauth = await request(app).get('/api/affiliates/me/campaigns');
        assert.equal(unauth.status, 401);
    } finally {
        await cleanupCampaign(campaignActiveId);
        await cleanupCampaign(campaignInactiveId);
        await cleanupCampaign(otherCampaignId);
        await cleanupAffiliate(emailA);
        await cleanupAffiliate(emailB);
    }
});

test('campaign stats are grouped by currency; currency is null when a campaign spans more than one', async () => {
    const code = await createTestCoupon({ discountPercent: 0.1, affiliateFeePercent: 0.1, maxRedemptions: null });
    let campaignId;
    const refPhp = `PAYCURR${Date.now()}PHP`;
    const refUsd = `PAYCURR${Date.now()}USD`;
    try {
        const create = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Mixed Currency', couponCode: code, destinationUrl: ALLOWED_URL, siteId: SITE.id });
        campaignId = create.body.campaign.id;

        await pool.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, base_amount, discount_amount, affiliate_fee_amount, currency, status, campaign_id, paid_at)
             VALUES ($1,$2,$3,100,10,10,'PHP','paid',$4, now())`,
            [`RDM${refPhp}`, code, refPhp, campaignId]
        );
        await pool.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, base_amount, discount_amount, affiliate_fee_amount, currency, status, campaign_id, source, paid_at)
             VALUES ($1,$2,$3,50,5,5,'USD','paid',$4,'ghl', now())`,
            [`RDM${refUsd}`, code, refUsd, campaignId]
        );

        const res = await request(app).get(`/api/admin/campaigns/${campaignId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(res.status, 200);
        assert.equal(res.body.campaign.currency, null);
        assert.equal(res.body.campaign.statsByCurrency.PHP.revenue, 100);
        assert.equal(res.body.campaign.statsByCurrency.USD.revenue, 50);
        // Scalar `stats` stays as the (currency-mixed) sum for backward compatibility.
        assert.equal(res.body.campaign.stats.revenue, 150);
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference IN ($1, $2)', [refPhp, refUsd]);
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

test('admin GET /campaigns filters by couponCode and active', async () => {
    const code = await createTestCoupon();
    let activeId, inactiveId;
    try {
        const a = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Active', couponCode: code, destinationUrl: ALLOWED_URL, active: true, siteId: SITE.id });
        activeId = a.body.campaign.id;
        const b = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Inactive', couponCode: code, destinationUrl: ALLOWED_URL, active: false, siteId: SITE.id });
        inactiveId = b.body.campaign.id;

        const byCoupon = await request(app).get(`/api/admin/campaigns?couponCode=${code}`).set('x-api-key', ADMIN_KEY);
        assert.equal(byCoupon.status, 200);
        assert.equal(byCoupon.body.campaigns.length, 2);

        const activeOnly = await request(app).get(`/api/admin/campaigns?couponCode=${code}&active=true`).set('x-api-key', ADMIN_KEY);
        assert.equal(activeOnly.body.campaigns.length, 1);
        assert.equal(activeOnly.body.campaigns[0].id, activeId);
    } finally {
        await cleanupCampaign(activeId);
        await cleanupCampaign(inactiveId);
        await cleanupCoupon(code);
    }
});
