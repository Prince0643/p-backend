require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const { createTestCoupon, cleanupCoupon, cleanupAffiliate } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;

// NODE_ENV is forced to 'test' by setupEnv.js, so the store's "allow http/localhost
// outside production" branch is active here - use nexistryacademy.com (allowlisted by
// default) over https to also exercise the normal production-shaped path.
const ALLOWED_URL = 'https://nexistryacademy.com/offer?utm_source=email';

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
            .send({ name: 'Spring Sale', couponCode: code, destinationUrl: ALLOWED_URL });
        assert.equal(res.status, 201);
        assert.equal(res.body.campaign.name, 'Spring Sale');
        assert.equal(res.body.campaign.slug, 'spring-sale');
        assert.equal(res.body.campaign.couponCode, code);
        assert.equal(res.body.campaign.active, true);
        campaignId = res.body.campaign.id;

        const link = new URL(res.body.campaign.link);
        assert.equal(link.origin + link.pathname, 'https://nexistryacademy.com/offer');
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
                destinationUrl: `https://nexistryacademy.com/offer?ref=OLDCODE&campaign=old-slug&keep=me`
            });
        assert.equal(res.status, 201);
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

test('rejects a destination on a foreign domain', async () => {
    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Bad Domain', couponCode: code, destinationUrl: 'https://example.com/offer' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /not on the allowed domain list/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('rejects a look-alike suffix domain (not a real subdomain)', async () => {
    const code = await createTestCoupon();
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Lookalike', couponCode: code, destinationUrl: 'https://evilnexistryacademy.com/offer' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /not on the allowed domain list/i);
    } finally {
        await cleanupCoupon(code);
    }
});

test('allows a real subdomain of an allowlisted domain', async () => {
    const code = await createTestCoupon();
    let campaignId;
    try {
        const res = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Subdomain', couponCode: code, destinationUrl: 'https://promo.nexistryacademy.com/offer' });
        assert.equal(res.status, 201);
        campaignId = res.body.campaign.id;
    } finally {
        await cleanupCampaign(campaignId);
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
            .send({ name: 'Insecure', couponCode: code, destinationUrl: 'http://nexistryacademy.com/offer' });
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
        .send({ name: 'No Coupon', couponCode: 'NOPE99', destinationUrl: ALLOWED_URL });
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
            .send({ name: 'Dup Slug', slug: 'dup-slug-test', couponCode: code, destinationUrl: ALLOWED_URL });
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Dup Slug Again', slug: 'dup-slug-test', couponCode: code, destinationUrl: ALLOWED_URL });
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
            .send({ name: 'Repeatable Name', couponCode: code, destinationUrl: ALLOWED_URL });
        assert.equal(first.status, 201);
        firstId = first.body.campaign.id;

        const second = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Repeatable Name', couponCode: code, destinationUrl: ALLOWED_URL });
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
            .send({ name: 'CRUD Test', couponCode: code, destinationUrl: ALLOWED_URL });
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
            .send({ name: 'Affiliate A Active', couponCode: couponA, destinationUrl: ALLOWED_URL, active: true });
        assert.equal(activeRes.status, 201);
        campaignActiveId = activeRes.body.campaign.id;

        const inactiveRes = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Affiliate A Inactive', couponCode: couponA, destinationUrl: ALLOWED_URL, active: false });
        assert.equal(inactiveRes.status, 201);
        campaignInactiveId = inactiveRes.body.campaign.id;

        const otherRes = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Affiliate B Active', couponCode: couponB, destinationUrl: ALLOWED_URL, active: true });
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

test('admin GET /campaigns filters by couponCode and active', async () => {
    const code = await createTestCoupon();
    let activeId, inactiveId;
    try {
        const a = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Active', couponCode: code, destinationUrl: ALLOWED_URL, active: true });
        activeId = a.body.campaign.id;
        const b = await request(app)
            .post('/api/admin/campaigns')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Filter Inactive', couponCode: code, destinationUrl: ALLOWED_URL, active: false });
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

after(async () => {
    await pool.end();
});
