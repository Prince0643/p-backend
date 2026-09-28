require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const { seedCampaignSites } = require('../db/migrate');
const { invalidateActiveSiteOriginsCache, getActiveSiteOrigins } = require('../utils/corsOrigins');
const { createTestCampaignSite, cleanupCampaignSite } = require('./fixtures');

const ADMIN_KEY = process.env.ADMIN_API_KEY;

after(async () => {
    await pool.end();
});

test('admin routes require authentication', async () => {
    const res = await request(app).get('/api/admin/campaign-sites');
    assert.equal(res.status, 401);
});

test('creates a campaign site with products and lists it', async () => {
    const url = `https://crud-${Date.now()}.example.com`;
    let siteId;
    try {
        const res = await request(app)
            .post('/api/admin/campaign-sites')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'CRUD Site', url, channel: 'local', active: true, products: [{ kind: 'local', ref: 'test_product', name: 'Test Product' }] });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.site.url, url);
        assert.equal(res.body.site.channel, 'local');
        assert.equal(res.body.site.products.length, 1);
        assert.equal(res.body.site.campaignCount, 0);
        siteId = res.body.site.id;

        const list = await request(app).get('/api/admin/campaign-sites').set('x-api-key', ADMIN_KEY);
        assert.equal(list.status, 200);
        assert.ok(list.body.sites.some((s) => s.id === siteId));
    } finally {
        await cleanupCampaignSite(siteId);
    }
});

test('normalizes a url with a path/trailing slash down to its origin', async () => {
    let siteId;
    try {
        const res = await request(app)
            .post('/api/admin/campaign-sites')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Normalize Site', url: `https://normalize-${Date.now()}.example.com/some/path/`, channel: 'local' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.ok(!res.body.site.url.includes('/some/path'));
        siteId = res.body.site.id;
    } finally {
        await cleanupCampaignSite(siteId);
    }
});

test('rejects a duplicate url', async () => {
    const url = `https://dup-${Date.now()}.example.com`;
    let siteId;
    try {
        const first = await request(app).post('/api/admin/campaign-sites').set('x-api-key', ADMIN_KEY).send({ name: 'A', url, channel: 'local' });
        assert.equal(first.status, 201);
        siteId = first.body.site.id;

        const second = await request(app).post('/api/admin/campaign-sites').set('x-api-key', ADMIN_KEY).send({ name: 'B', url, channel: 'local' });
        assert.equal(second.status, 409);
    } finally {
        await cleanupCampaignSite(siteId);
    }
});

test('rejects a local product ref that does not exist', async () => {
    const res = await request(app)
        .post('/api/admin/campaign-sites')
        .set('x-api-key', ADMIN_KEY)
        .send({ name: 'Bad Product', url: `https://badprod-${Date.now()}.example.com`, channel: 'local', products: [{ kind: 'local', ref: 'no_such_product' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /does not exist/i);
});

test('PUT fully replaces products', async () => {
    let siteId;
    try {
        const create = await request(app)
            .post('/api/admin/campaign-sites')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Replace Site', url: `https://replace-${Date.now()}.example.com`, channel: 'global', products: [{ kind: 'ghl', ref: 'ghl_prod_1' }] });
        assert.equal(create.status, 201);
        siteId = create.body.site.id;

        const update = await request(app)
            .put(`/api/admin/campaign-sites/${siteId}`)
            .set('x-api-key', ADMIN_KEY)
            .send({ products: [{ kind: 'ghl', ref: 'ghl_prod_2', name: 'New' }] });
        assert.equal(update.status, 200);
        assert.equal(update.body.site.products.length, 1);
        assert.equal(update.body.site.products[0].ref, 'ghl_prod_2');
    } finally {
        await cleanupCampaignSite(siteId);
    }
});

test('DELETE returns 409 when a campaign still references the site, succeeds after deactivating the campaign instead', async () => {
    const { createTestCoupon, cleanupCoupon } = require('./fixtures');
    const campaignStore = require('../utils/campaignStore');
    let siteId, campaignId, code;
    try {
        const siteRes = await request(app)
            .post('/api/admin/campaign-sites')
            .set('x-api-key', ADMIN_KEY)
            .send({ name: 'Delete Guard Site', url: `https://deleteguard-${Date.now()}.example.com`, channel: 'local' });
        siteId = siteRes.body.site.id;

        code = await createTestCoupon();
        const campaign = await campaignStore.createCampaign({
            name: 'Blocks Delete', couponCode: code, destinationUrl: siteRes.body.site.url, siteId
        });
        campaignId = campaign.id;

        const del = await request(app).delete(`/api/admin/campaign-sites/${siteId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(del.status, 409);
        assert.match(del.body.error, /deactivate/i);

        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        campaignId = null;

        const delAgain = await request(app).delete(`/api/admin/campaign-sites/${siteId}`).set('x-api-key', ADMIN_KEY);
        assert.equal(delAgain.status, 200);
        siteId = null;
    } finally {
        if (campaignId) await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await cleanupCampaignSite(siteId);
        if (code) await cleanupCoupon(code);
    }
});

test('DELETE 404s for a missing site', async () => {
    const res = await request(app).delete('/api/admin/campaign-sites/SITE_DOES_NOT_EXIST').set('x-api-key', ADMIN_KEY);
    assert.equal(res.status, 404);
});

test('CORS allows the origin of an active campaign site and excludes an inactive one', async (t) => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { process.env.NODE_ENV = originalEnv; invalidateActiveSiteOriginsCache(); });

    const activeSite = await createTestCampaignSite({ active: true });
    const inactiveSite = await createTestCampaignSite({ active: false });
    invalidateActiveSiteOriginsCache();

    try {
        const origins = await getActiveSiteOrigins();
        assert.ok(origins.includes(activeSite.url));
        assert.ok(!origins.includes(inactiveSite.url));

        const activeRes = await request(app).get('/health').set('Origin', activeSite.url);
        assert.equal(activeRes.headers['access-control-allow-origin'], activeSite.url);

        const inactiveRes = await request(app).get('/health').set('Origin', inactiveSite.url);
        assert.notEqual(inactiveRes.headers['access-control-allow-origin'], inactiveSite.url);
    } finally {
        await cleanupCampaignSite(activeSite.id);
        await cleanupCampaignSite(inactiveSite.id);
        invalidateActiveSiteOriginsCache();
    }
});

test('GET ghl-products returns 502 when the Global location is not configured', async () => {
    const ghlService = require('../services/ghlService');
    const original = ghlService.resolveGlobalLocation;
    ghlService.resolveGlobalLocation = () => null;
    try {
        const res = await request(app).get('/api/admin/campaign-sites/ghl-products').set('x-api-key', ADMIN_KEY);
        assert.equal(res.status, 502);
    } finally {
        ghlService.resolveGlobalLocation = original;
    }
});

test('GET ghl-products lists products from the configured Global location', async () => {
    const ghlService = require('../services/ghlService');
    const originalResolve = ghlService.resolveGlobalLocation;
    const originalCreateClient = ghlService.createClient;
    ghlService.resolveGlobalLocation = () => ({ name: 'Nexistry Core Global', locationId: 'loc_global', privateKey: 'pit_global' });
    ghlService.createClient = () => ({
        get: async (url) => {
            if (url === '/products/') return { data: { products: [{ _id: 'prod_1', name: 'Widget', prices: [{ amount: 1000, currency: 'USD' }] }] } };
            throw new Error(`Unexpected call: ${url}`);
        }
    });
    try {
        const res = await request(app).get('/api/admin/campaign-sites/ghl-products').set('x-api-key', ADMIN_KEY);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.products, [{ ref: 'prod_1', name: 'Widget', price: 1000, currency: 'USD' }]);
    } finally {
        ghlService.resolveGlobalLocation = originalResolve;
        ghlService.createClient = originalCreateClient;
    }
});

test('seeding only runs when campaign_sites is completely empty', async (t) => {
    const { rows: countBefore } = await pool.query('SELECT COUNT(*)::int AS count FROM campaign_sites');
    const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
    t.after(() => {
        if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    });

    if (countBefore[0].count > 0) {
        // Table already has rows (from earlier tests or a real deploy) - seeding must be a no-op.
        process.env.ALLOWED_ORIGINS = 'https://should-not-be-seeded.example.com';
        const client = await pool.connect();
        try {
            await seedCampaignSites(client);
        } finally {
            client.release();
        }
        const { rows } = await pool.query('SELECT 1 FROM campaign_sites WHERE url = $1', ['https://should-not-be-seeded.example.com']);
        assert.equal(rows.length, 0);
        return;
    }

    process.env.ALLOWED_ORIGINS = 'https://seed-local.example.com,https://nexistrycoreglobal.com';
    const client = await pool.connect();
    try {
        await seedCampaignSites(client);
    } finally {
        client.release();
    }
    const { rows } = await pool.query('SELECT url, channel FROM campaign_sites ORDER BY url ASC');
    const byUrl = Object.fromEntries(rows.map((r) => [r.url, r.channel]));
    assert.equal(byUrl['https://seed-local.example.com'], 'local');
    assert.equal(byUrl['https://nexistrycoreglobal.com'], 'global');

    // Re-running with a different ALLOWED_ORIGINS must not add/change anything - table is non-empty now.
    process.env.ALLOWED_ORIGINS = 'https://should-not-be-seeded-2.example.com';
    const client2 = await pool.connect();
    try {
        await seedCampaignSites(client2);
    } finally {
        client2.release();
    }
    const { rows: after2 } = await pool.query('SELECT 1 FROM campaign_sites WHERE url = $1', ['https://should-not-be-seeded-2.example.com']);
    assert.equal(after2.length, 0);

    await pool.query('DELETE FROM campaign_sites WHERE url IN ($1, $2)', ['https://seed-local.example.com', 'https://nexistrycoreglobal.com']);
});
