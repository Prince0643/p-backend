// utils/campaignSiteStore.js
// Campaign sites are the distinct storefronts/funnels campaigns can point traffic at -
// either LOCAL (our PayMongo checkout) or GLOBAL (native GHL checkout in the "Nexistry
// Core Global" GHL location). Their active URLs double as an additional CORS allowlist
// (see index.js) on top of the permanent ALLOWED_ORIGINS env list.
const pool = require('../db/pool');
const productCatalog = require('./productCatalog');

function generateId() {
    return `SITE${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

/** Validates and normalizes a site URL down to its origin (scheme+host, no path/trailing slash). */
function normalizeSiteUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) throw new Error('url is required');

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('url must be a valid absolute URL');
    }

    const isProd = process.env.NODE_ENV === 'production';
    if (parsed.protocol === 'https:') {
        // always fine
    } else if (parsed.protocol === 'http:' && !isProd) {
        // allowed only outside production (localhost testing)
    } else {
        throw new Error('url must use https (http is only allowed outside production)');
    }

    return `${parsed.protocol}//${parsed.host}`;
}

function normalizeChannel(channel) {
    const value = String(channel || '').trim().toLowerCase();
    if (!['local', 'global'].includes(value)) {
        throw new Error('channel must be "local" or "global"');
    }
    return value;
}

/** Validates the products array; throws a descriptive Error on the first invalid entry. */
async function normalizeProducts(products) {
    if (products === undefined || products === null) return [];
    if (!Array.isArray(products)) throw new Error('products must be an array');

    const normalized = [];
    for (const p of products) {
        if (!p || typeof p !== 'object') throw new Error('Each product entry must be an object');
        const kind = String(p.kind || '').trim().toLowerCase();
        if (!['local', 'ghl'].includes(kind)) throw new Error('product kind must be "local" or "ghl"');
        const ref = String(p.ref || '').trim();
        if (!ref) throw new Error('product ref is required');
        const name = p.name ? String(p.name).trim() : null;

        if (kind === 'local') {
            const product = await productCatalog.findProduct({ productId: ref });
            if (!product) throw new Error(`Local product "${ref}" does not exist`);
        }

        normalized.push({ kind, ref, name });
    }
    return normalized;
}

function rowToSite(row, products = [], campaignCount = 0) {
    return {
        id: row.id,
        name: row.name,
        url: row.url,
        channel: row.channel,
        active: row.active,
        products: products.map((p) => ({ kind: p.kind, ref: p.ref, name: p.name || '' })),
        campaignCount: Number(campaignCount) || 0,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

async function attachDetails(sites) {
    if (sites.length === 0) return [];
    const ids = sites.map((s) => s.id);
    const [{ rows: productRows }, { rows: countRows }] = await Promise.all([
        pool.query('SELECT * FROM campaign_site_products WHERE site_id = ANY($1::text[])', [ids]),
        pool.query(
            `SELECT site_id, COUNT(*)::int AS count FROM campaigns WHERE site_id = ANY($1::text[]) GROUP BY site_id`,
            [ids]
        )
    ]);
    const productsBySite = {};
    for (const p of productRows) {
        if (!productsBySite[p.site_id]) productsBySite[p.site_id] = [];
        productsBySite[p.site_id].push(p);
    }
    const countBySite = {};
    for (const c of countRows) countBySite[c.site_id] = c.count;

    return sites.map((s) => rowToSite(s, productsBySite[s.id] || [], countBySite[s.id] || 0));
}

async function listSites() {
    const { rows } = await pool.query('SELECT * FROM campaign_sites ORDER BY name ASC');
    return attachDetails(rows);
}

async function findSiteById(id) {
    if (!id) return null;
    const { rows } = await pool.query('SELECT * FROM campaign_sites WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const [site] = await attachDetails([rows[0]]);
    return site;
}

/** Returns the origin URLs of every currently-active site, for CORS allowlisting. */
async function listActiveSiteOrigins() {
    const { rows } = await pool.query('SELECT url FROM campaign_sites WHERE active = true');
    return rows.map((r) => r.url);
}

async function createSite(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid campaign site payload');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('name is required');
    const url = normalizeSiteUrl(payload.url);
    const channel = normalizeChannel(payload.channel);
    const active = payload.active === undefined ? true : Boolean(payload.active);
    const products = await normalizeProducts(payload.products);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: existing } = await client.query('SELECT 1 FROM campaign_sites WHERE url = $1', [url]);
        if (existing.length > 0) {
            const err = new Error(`A campaign site for "${url}" already exists`);
            err.statusCode = 409;
            throw err;
        }

        const id = generateId();
        await client.query(
            `INSERT INTO campaign_sites (id, name, url, channel, active) VALUES ($1,$2,$3,$4,$5)`,
            [id, name, url, channel, active]
        );
        for (const p of products) {
            await client.query(
                `INSERT INTO campaign_site_products (site_id, kind, ref, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
                [id, p.kind, p.ref, p.name]
            );
        }

        await client.query('COMMIT');
        return findSiteById(id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function updateSite(id, payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid campaign site payload');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: existingRows } = await client.query('SELECT * FROM campaign_sites WHERE id = $1 FOR UPDATE', [id]);
        const existing = existingRows[0];
        if (!existing) {
            await client.query('ROLLBACK');
            client.release();
            return null;
        }

        const name = payload.name !== undefined ? String(payload.name || '').trim() : existing.name;
        if (!name) throw new Error('name is required');

        const url = payload.url !== undefined ? normalizeSiteUrl(payload.url) : existing.url;
        if (url !== existing.url) {
            const { rows: conflict } = await client.query('SELECT 1 FROM campaign_sites WHERE url = $1 AND id != $2', [url, id]);
            if (conflict.length > 0) {
                const err = new Error(`A campaign site for "${url}" already exists`);
                err.statusCode = 409;
                throw err;
            }
        }

        const channel = payload.channel !== undefined ? normalizeChannel(payload.channel) : existing.channel;
        const active = payload.active !== undefined ? Boolean(payload.active) : existing.active;
        const products = payload.products !== undefined ? await normalizeProducts(payload.products) : null;

        await client.query(
            `UPDATE campaign_sites SET name = $2, url = $3, channel = $4, active = $5, updated_at = now() WHERE id = $1`,
            [id, name, url, channel, active]
        );

        if (products !== null) {
            await client.query('DELETE FROM campaign_site_products WHERE site_id = $1', [id]);
            for (const p of products) {
                await client.query(
                    `INSERT INTO campaign_site_products (site_id, kind, ref, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
                    [id, p.kind, p.ref, p.name]
                );
            }
        }

        await client.query('COMMIT');
        return findSiteById(id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Deliberately not ON DELETE CASCADE on campaigns.site_id - deleting a site that
// campaigns still reference would silently orphan/attribute-break those campaigns.
async function deleteSite(id) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM campaigns WHERE site_id = $1', [id]);
    if (rows[0].count > 0) {
        const err = new Error('Cannot delete this campaign site because campaigns still reference it - deactivate it instead.');
        err.statusCode = 409;
        throw err;
    }
    const { rowCount } = await pool.query('DELETE FROM campaign_sites WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    normalizeSiteUrl,
    listSites,
    findSiteById,
    listActiveSiteOrigins,
    createSite,
    updateSite,
    deleteSite
};
