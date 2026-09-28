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

test('creates a campaign (no coupon required) and builds linkTemplate correctly, preserving existing query params', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Spring Sale', destinationUrl: ALLOWED_URL, siteId: SITE.id });
    let campaignId;
    try {
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.campaign.name, 'Spring Sale');
        assert.equal(res.body.campaign.slug, 'spring-sale');
        assert.equal(res.body.campaign.active, true);
        assert.equal(res.body.campaign.siteId, SITE.id);
        assert.equal(res.body.campaign.siteChannel, 'local');
        assert.equal(res.body.campaign.couponCode, undefined);
        campaignId = res.body.campaign.id;

        const template = new URL(res.body.campaign.linkTemplate);
        assert.equal(template.origin + template.pathname, `${SITE.url}/offer`);
        assert.equal(template.searchParams.get('utm_source'), 'email');
        assert.equal(template.searchParams.get('ref'), '{CODE}');
        assert.equal(template.searchParams.get('campaign'), 'spring-sale');
    } finally {
        await cleanupCampaign(campaignId);
    }
});

test('overwrites existing ref/campaign params in the destination URL', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({
            name: 'Overwrite Test',
            siteId: SITE.id,
            destinationUrl: `${SITE.url}/offer?ref=OLDCODE&campaign=old-slug&keep=me`
        });
    let campaignId;
    try {
        assert.equal(res.status, 201, JSON.stringify(res.body));
        campaignId = res.body.campaign.id;

        const template = new URL(res.body.campaign.linkTemplate);
        assert.equal(template.searchParams.get('ref'), '{CODE}');
        assert.equal(template.searchParams.get('campaign'), res.body.campaign.slug);
        assert.equal(template.searchParams.get('keep'), 'me');
    } finally {
        await cleanupCampaign(campaignId);
    }
});

test('requires a siteId', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'No Site', destinationUrl: ALLOWED_URL });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /siteId is required/i);
});

test('rejects an unknown siteId', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Bad Site', destinationUrl: ALLOWED_URL, siteId: 'SITE_DOES_NOT_EXIST' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /does not exist/i);
});

test('rejects a destination on a foreign domain (must match the chosen site)', async () => {
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Bad Domain', destinationUrl: 'https://example.com/offer', siteId: SITE.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must match the selected campaign site/i);
});

test('rejects a look-alike/subdomain host that does not exactly match the site host', async () => {
    const foreignHost = `evil${new URL(SITE.url).hostname}`;
    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Lookalike', destinationUrl: `https://${foreignHost}/offer`, siteId: SITE.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must match the selected campaign site/i);
});

test('rejects non-https destinations in production', async (t) => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { process.env.NODE_ENV = originalEnv; });

    const res = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Insecure', destinationUrl: `http://${new URL(SITE.url).hostname}/offer`, siteId: SITE.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /https/i);
});

test('rejects a duplicate slug with 409', async () => {
    const first = await request(app)
        .post('/api/admin/campaigns')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Dup Slug', slug: 'dup-slug-test', destinationUrl: ALLOWED_URL, siteId: SITE.id });
    let firstId;
    try {
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Dup Slug Again', slug: 'dup-slug-test', destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(second.status, 409);
    } finally {
        await cleanupCampaign(firstId);
    }
});

test('auto-generated slugs de-duplicate with a numeric suffix', async () => {
    let firstId, secondId;
    try {
        const first = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Repeatable Name', destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Repeatable Name', destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(second.status, 201);
        secondId = second.body.campaign.id;

        assert.notEqual(first.body.campaign.slug, second.body.campaign.slug);
    } finally {
        await cleanupCampaign(firstId);
        await cleanupCampaign(secondId);
    }
});

test('GET/PUT/DELETE single campaign: 404 on missing, full CRUD works', async () => {
    let campaignId;
    try {
        const missing = await request(app).get('/api/admin/campaigns/DOES_NOT_EXIST').set('x-api-key', ADMIN_KEY);
        assert.equal(missing.status, 404);

        const create = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'CRUD Test', destinationUrl: ALLOWED_URL, siteId: SITE.id });
        assert.equal(create.status, 201);
        campaignId = create.body.campaign.id;

        const get = await request(app).get(`/api/admin/campaigns/${campaignId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(get.status, 200);
        assert.equal(get.body.campaign.id, campaignId);
        // Other test files run concurrently and may have their own real affiliates - just
        // confirm the shape and that none of them have any stats for this brand-new campaign.
        assert.ok(Array.isArray(get.body.campaign.affiliateStats));
        assert.ok(get.body.campaign.affiliateStats.every((a) => a.stats.paidCount === 0));

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
    }
});

test('every active affiliate sees the same campaign with their own personal link, including one registered after the campaign was created', async () => {
    const emailA = `campaign.aff.a.${Date.now()}@example.com`;
    const emailB = `campaign.aff.b.${Date.now()}@example.com`;
    let campaignId;
    try {
        const regA = await request(app).post('/api/affiliates/register').send(registrationPayload(emailA));
        assert.equal(regA.status, 201);
        const tokenA = regA.body.token;
        const couponA = regA.body.couponCode;

        const created = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'All Affiliates Campaign', destinationUrl: ALLOWED_URL, active: true, siteId: SITE.id });
        assert.equal(created.status, 201);
        campaignId = created.body.campaign.id;

        const mineA = await request(app).get('/api/affiliates/me/campaigns').set('Authorization', `Bearer ${tokenA}`);
        assert.equal(mineA.status, 200);
        // Other test files run concurrently against the same DB and may have their own
        // active campaigns/affiliates at this moment, so only assert on OUR campaign
        // rather than the exact list length.
        const mineACampaign = mineA.body.campaigns.find((c) => c.id === campaignId);
        assert.ok(mineACampaign, 'expected the new campaign to appear in affiliate A\'s list');
        assert.match(mineACampaign.link, new RegExp(`ref=${couponA}`));

        // An affiliate that registers AFTER the campaign exists still gets a personal link
        // to it automatically - campaigns are no longer tied to one coupon/affiliate.
        const regB = await request(app).post('/api/affiliates/register').send(registrationPayload(emailB));
        assert.equal(regB.status, 201);
        const tokenB = regB.body.token;
        const couponB = regB.body.couponCode;

        const mineB = await request(app).get('/api/affiliates/me/campaigns').set('Authorization', `Bearer ${tokenB}`);
        assert.equal(mineB.status, 200);
        const mineBCampaign = mineB.body.campaigns.find((c) => c.id === campaignId);
        assert.ok(mineBCampaign, 'expected the new campaign to appear in affiliate B\'s list too, despite registering after it was created');
        assert.match(mineBCampaign.link, new RegExp(`ref=${couponB}`));

        const unauth = await request(app).get('/api/affiliates/me/campaigns');
        assert.equal(unauth.status, 401);

        await cleanupAffiliate(emailA);
        await cleanupAffiliate(emailB);
    } finally {
        await cleanupCampaign(campaignId);
    }
});

test('an inactive campaign is not returned to affiliates, and an inactive site hides its campaigns', async () => {
    const email = `campaign.aff.inactive.${Date.now()}@example.com`;
    let inactiveCampaignId, inactiveSiteCampaignId, inactiveSite;
    try {
        const reg = await request(app).post('/api/affiliates/register').send(registrationPayload(email));
        assert.equal(reg.status, 201);
        const token = reg.body.token;

        const inactive = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Inactive Campaign', destinationUrl: ALLOWED_URL, active: false, siteId: SITE.id });
        assert.equal(inactive.status, 201);
        inactiveCampaignId = inactive.body.campaign.id;

        inactiveSite = await createTestCampaignSite({ name: 'Inactive Site', channel: 'local', active: false });
        const onInactiveSite = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'On Inactive Site', destinationUrl: `${inactiveSite.url}/offer`, active: true, siteId: inactiveSite.id });
        assert.equal(onInactiveSite.status, 201);
        inactiveSiteCampaignId = onInactiveSite.body.campaign.id;

        const mine = await request(app).get('/api/affiliates/me/campaigns').set('Authorization', `Bearer ${token}`);
        assert.equal(mine.status, 200);
        assert.ok(!mine.body.campaigns.some((c) => c.id === inactiveCampaignId), 'an inactive campaign must not appear');
        assert.ok(!mine.body.campaigns.some((c) => c.id === inactiveSiteCampaignId), 'a campaign on an inactive site must not appear');

        await cleanupAffiliate(email);
    } finally {
        await cleanupCampaign(inactiveCampaignId);
        await cleanupCampaign(inactiveSiteCampaignId);
        await cleanupCampaignSite(inactiveSite?.id);
    }
});

test('campaign stats are grouped by currency; currency is null when a campaign spans more than one, and affiliateStats breaks down by affiliate', async () => {
    const code = await createTestCoupon({ type: 'affiliate', discountPercent: 0.1, affiliateFeePercent: 0.1, maxRedemptions: null });
    let campaignId;
    const refPhp = `PAYCURR${Date.now()}PHP`;
    const refUsd = `PAYCURR${Date.now()}USD`;
    try {
        const create = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Mixed Currency', destinationUrl: ALLOWED_URL, siteId: SITE.id });
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

        // Other test files run concurrently and may have their own real affiliates, so
        // affiliateStats may be non-empty - but none of them used THIS campaign's coupon,
        // so every entry's stats for this specific campaign must be all-zero.
        assert.ok(Array.isArray(res.body.campaign.affiliateStats));
        assert.ok(res.body.campaign.affiliateStats.every((a) => a.stats.paidCount === 0 && a.stats.revenue === 0));
    } finally {
        await pool.query('DELETE FROM coupon_redemptions WHERE payment_reference IN ($1, $2)', [refPhp, refUsd]);
        await cleanupCampaign(campaignId);
        await cleanupCoupon(code);
    }
});

test('admin GET /campaigns filters by active', async () => {
    let activeId, inactiveId;
    try {
        const a = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Active', destinationUrl: ALLOWED_URL, active: true, siteId: SITE.id });
        activeId = a.body.campaign.id;
        const b = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Inactive', destinationUrl: ALLOWED_URL, active: false, siteId: SITE.id });
        inactiveId = b.body.campaign.id;

        const activeOnly = await request(app).get('/api/admin/campaigns?active=true').set('x-api-key', ADMIN_KEY);
        assert.equal(activeOnly.status, 200);
        assert.ok(activeOnly.body.campaigns.some((c) => c.id === activeId));
        assert.ok(!activeOnly.body.campaigns.some((c) => c.id === inactiveId));
    } finally {
        await cleanupCampaign(activeId);
        await cleanupCampaign(inactiveId);
    }
});
