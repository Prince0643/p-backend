// utils/campaignStore.js
// Named, admin-created custom links that attribute traffic/sales to one affiliate via
// their coupon code. No redirect service: the "link" is just the destination URL with
// ref/campaign query params appended, computed on every read so it always reflects the
// current destination_url (see buildCampaignLink).
const pool = require('../db/pool');
const couponStore = require('./couponStore');

const SLUG_MIN_LENGTH = 2;
const SLUG_MAX_LENGTH = 60;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

function getAllowedDomains() {
    const raw = process.env.CAMPAIGN_ALLOWED_DOMAINS;
    const list = (raw && raw.trim() ? raw : 'nexistrydigitalsolutions.com,nexistryacademy.com')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
    return list;
}

/** True if hostname equals an allowlisted domain, or is a proper subdomain of one (dot-boundary match). */
function isAllowedHostname(hostname, allowedDomains) {
    const host = String(hostname || '').toLowerCase();
    return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Validates a destination URL against the domain allowlist and protocol rules.
 * Throws a descriptive Error on failure; returns the parsed URL on success.
 */
function validateDestinationUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) throw new Error('destinationUrl is required');

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('destinationUrl must be a valid absolute URL');
    }

    const isProd = process.env.NODE_ENV === 'production';
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

    if (parsed.protocol === 'https:') {
        // always fine
    } else if (parsed.protocol === 'http:' && !isProd) {
        // allowed only outside production (localhost testing)
    } else {
        throw new Error('destinationUrl must use https (http is only allowed outside production)');
    }

    if (!isProd && isLocalhost) {
        return parsed;
    }

    const allowedDomains = getAllowedDomains();
    if (!isAllowedHostname(parsed.hostname, allowedDomains)) {
        throw new Error(`destinationUrl host "${parsed.hostname}" is not on the allowed domain list (${allowedDomains.join(', ')})`);
    }

    return parsed;
}

/** Builds the shareable campaign link: destination URL with ref/campaign params set, preserving other params/hash. */
function buildCampaignLink(destinationUrl, couponCode, slug) {
    const url = new URL(destinationUrl);
    url.searchParams.set('ref', couponCode);
    url.searchParams.set('campaign', slug);
    return url.toString();
}

function slugify(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX_LENGTH);
}

function validateSlugFormat(slug) {
    if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
        throw new Error(`slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters`);
    }
    if (!SLUG_PATTERN.test(slug)) {
        throw new Error('slug must contain only lowercase letters, numbers, and hyphens');
    }
}

/** Generates a unique slug from name, de-duplicating with a numeric suffix (e.g. "sale", "sale-2", "sale-3"). */
async function generateUniqueSlug(client, name, { excludeId } = {}) {
    let base = slugify(name);
    if (base.length < SLUG_MIN_LENGTH) base = `campaign-${base}`.slice(0, SLUG_MAX_LENGTH);
    if (base.length < SLUG_MIN_LENGTH) base = 'campaign';

    let candidate = base;
    let suffix = 1;
    // Bounded loop: guards against an unexpected infinite loop if something is very wrong.
    for (let attempts = 0; attempts < 1000; attempts++) {
        const params = excludeId ? [candidate, excludeId] : [candidate];
        const query = excludeId
            ? 'SELECT 1 FROM campaigns WHERE slug = $1 AND id != $2'
            : 'SELECT 1 FROM campaigns WHERE slug = $1';
        const { rows } = await client.query(query, params);
        if (rows.length === 0) return candidate;
        suffix += 1;
        const suffixStr = `-${suffix}`;
        candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffixStr.length)}${suffixStr}`;
    }
    throw new Error('Failed to generate a unique slug, please retry');
}

function generateId() {
    return `CMP${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

function rowToCampaign(row) {
    const campaign = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        couponCode: row.coupon_code,
        destinationUrl: row.destination_url,
        notes: row.notes || '',
        active: row.active,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        link: buildCampaignLink(row.destination_url, row.coupon_code, row.slug)
    };
    if (row.affiliate_id !== undefined) {
        campaign.affiliate = row.affiliate_id
            ? {
                id: row.affiliate_id,
                firstName: row.affiliate_first_name,
                lastName: row.affiliate_last_name,
                email: row.affiliate_email
            }
            : null;
    }
    return campaign;
}

const CAMPAIGN_WITH_AFFILIATE_QUERY = `
    SELECT c.*, a.id AS affiliate_id, a.first_name AS affiliate_first_name,
           a.last_name AS affiliate_last_name, a.email AS affiliate_email
    FROM campaigns c
    LEFT JOIN affiliates a ON a.coupon_code = c.coupon_code
`;

const EMPTY_STATS = { paidCount: 0, pendingCount: 0, revenue: 0, discountTotal: 0, commissionTotal: 0 };

/**
 * One aggregate query (GROUP BY campaign_id) for redemption stats, keyed by campaign id.
 * revenue/discountTotal/commissionTotal are summed over 'paid' rows only; base_amount is
 * already net of discount (computed post-discount pre-tax in paymentController), so
 * revenue does not subtract discount_amount again - matches the admin dashboard convention.
 */
async function fetchCampaignStatsMap(campaignIds) {
    const map = {};
    if (!Array.isArray(campaignIds) || campaignIds.length === 0) return map;
    const { rows } = await pool.query(
        `SELECT
            campaign_id,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COALESCE(SUM(base_amount) FILTER (WHERE status = 'paid'), 0) AS revenue,
            COALESCE(SUM(discount_amount) FILTER (WHERE status = 'paid'), 0) AS discount_total,
            COALESCE(SUM(affiliate_fee_amount) FILTER (WHERE status = 'paid'), 0) AS commission_total
         FROM coupon_redemptions
         WHERE campaign_id = ANY($1::text[])
         GROUP BY campaign_id`,
        [campaignIds]
    );
    for (const row of rows) {
        map[row.campaign_id] = {
            paidCount: row.paid_count,
            pendingCount: row.pending_count,
            revenue: Number(row.revenue),
            discountTotal: Number(row.discount_total),
            commissionTotal: Number(row.commission_total)
        };
    }
    return map;
}

async function attachStats(campaigns) {
    const statsMap = await fetchCampaignStatsMap(campaigns.map((c) => c.id));
    return campaigns.map((c) => ({ ...c, stats: statsMap[c.id] || { ...EMPTY_STATS } }));
}

async function listCampaigns({ couponCode, active } = {}) {
    const conditions = [];
    const params = [];
    if (couponCode) {
        params.push(couponStore.toCouponCode(couponCode));
        conditions.push(`c.coupon_code = $${params.length}`);
    }
    if (active !== undefined && active !== null && active !== '') {
        params.push(active === true || active === 'true');
        conditions.push(`c.active = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`${CAMPAIGN_WITH_AFFILIATE_QUERY} ${where} ORDER BY c.created_at DESC`, params);
    return attachStats(rows.map(rowToCampaign));
}

async function findCampaignById(id) {
    if (!id) return null;
    const { rows } = await pool.query(`${CAMPAIGN_WITH_AFFILIATE_QUERY} WHERE c.id = $1`, [id]);
    if (!rows[0]) return null;
    const [campaign] = await attachStats([rowToCampaign(rows[0])]);
    return campaign;
}

/** Looks up a campaign by slug regardless of active status - caller must check the `active` field itself. */
async function findCampaignBySlug(slug) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return null;
    const { rows } = await pool.query(`${CAMPAIGN_WITH_AFFILIATE_QUERY} WHERE c.slug = $1`, [normalized]);
    return rows[0] ? rowToCampaign(rows[0]) : null;
}

async function createCampaign(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid campaign payload');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('name is required');

    const couponCode = couponStore.toCouponCode(payload.couponCode);
    if (!couponCode) throw new Error('couponCode is required');

    const destination = validateDestinationUrl(payload.destinationUrl);
    const notes = payload.notes ? String(payload.notes) : null;
    const active = payload.active === undefined ? true : Boolean(payload.active);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: couponRows } = await client.query('SELECT 1 FROM coupons WHERE code = $1', [couponCode]);
        if (couponRows.length === 0) {
            const err = new Error(`Coupon "${couponCode}" does not exist`);
            err.statusCode = 400;
            throw err;
        }

        let slug = payload.slug ? slugify(payload.slug) : '';
        if (payload.slug) {
            validateSlugFormat(slug);
            const { rows: existing } = await client.query('SELECT 1 FROM campaigns WHERE slug = $1', [slug]);
            if (existing.length > 0) {
                const err = new Error(`Slug "${slug}" is already in use`);
                err.statusCode = 409;
                throw err;
            }
        } else {
            slug = await generateUniqueSlug(client, name);
        }

        const id = generateId();
        await client.query(
            `INSERT INTO campaigns (id, name, slug, coupon_code, destination_url, notes, active)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, name, slug, couponCode, destination.toString(), notes, active]
        );

        await client.query('COMMIT');
        return findCampaignById(id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function updateCampaign(id, payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid campaign payload');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: existingRows } = await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
        const existing = existingRows[0];
        if (!existing) {
            await client.query('ROLLBACK');
            client.release();
            return null;
        }

        const name = payload.name !== undefined ? String(payload.name || '').trim() : existing.name;
        if (!name) throw new Error('name is required');

        const couponCode = payload.couponCode !== undefined
            ? couponStore.toCouponCode(payload.couponCode)
            : existing.coupon_code;
        if (!couponCode) throw new Error('couponCode is required');
        if (couponCode !== existing.coupon_code) {
            const { rows: couponRows } = await client.query('SELECT 1 FROM coupons WHERE code = $1', [couponCode]);
            if (couponRows.length === 0) {
                const err = new Error(`Coupon "${couponCode}" does not exist`);
                err.statusCode = 400;
                throw err;
            }
        }

        const destinationUrl = payload.destinationUrl !== undefined
            ? validateDestinationUrl(payload.destinationUrl).toString()
            : existing.destination_url;

        let slug = existing.slug;
        if (payload.slug !== undefined && payload.slug !== null && String(payload.slug).trim() !== '') {
            const nextSlug = slugify(payload.slug);
            validateSlugFormat(nextSlug);
            if (nextSlug !== existing.slug) {
                const { rows: conflictRows } = await client.query('SELECT 1 FROM campaigns WHERE slug = $1 AND id != $2', [nextSlug, id]);
                if (conflictRows.length > 0) {
                    const err = new Error(`Slug "${nextSlug}" is already in use`);
                    err.statusCode = 409;
                    throw err;
                }
            }
            slug = nextSlug;
        }

        const notes = payload.notes !== undefined ? (payload.notes ? String(payload.notes) : null) : existing.notes;
        const active = payload.active !== undefined ? Boolean(payload.active) : existing.active;

        await client.query(
            `UPDATE campaigns SET name = $2, slug = $3, coupon_code = $4, destination_url = $5, notes = $6, active = $7, updated_at = now()
             WHERE id = $1`,
            [id, name, slug, couponCode, destinationUrl, notes, active]
        );

        await client.query('COMMIT');
        return findCampaignById(id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function deleteCampaign(id) {
    const { rowCount } = await pool.query('DELETE FROM campaigns WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    getAllowedDomains,
    isAllowedHostname,
    validateDestinationUrl,
    buildCampaignLink,
    slugify,
    listCampaigns,
    findCampaignById,
    findCampaignBySlug,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    fetchCampaignStatsMap
};
