// utils/campaignStore.js
// Named, admin-created custom links that attribute traffic/sales to one affiliate via
// their coupon code. No redirect service: the "link" is just the destination URL with
// ref/campaign query params appended, computed on every read so it always reflects the
// current destination_url (see buildCampaignLink).
const pool = require('../db/pool');
const campaignSiteStore = require('./campaignSiteStore');

const SLUG_MIN_LENGTH = 2;
const SLUG_MAX_LENGTH = 60;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * CAMPAIGN_ALLOWED_DOMAINS is legacy: the allowlist is now "host matches an active
 * campaign site", but this env var still works as an additional allow when set, for
 * backward compat with deployments that configured it before campaign sites existed.
 * Unlike before, there is no hardcoded default list - campaign sites are the primary
 * mechanism now.
 */
function getAllowedDomains() {
    const raw = process.env.CAMPAIGN_ALLOWED_DOMAINS;
    if (!raw || !raw.trim()) return [];
    return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** True if hostname equals an allowlisted domain, or is a proper subdomain of one (dot-boundary match). */
function isAllowedHostname(hostname, allowedDomains) {
    const host = String(hostname || '').toLowerCase();
    return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Validates a destination URL's protocol and host. Host is allowed if it equals (or is
 * a subdomain of) an ACTIVE campaign site's host, or the legacy CAMPAIGN_ALLOWED_DOMAINS
 * env list when set. When `requiredHostname` is given (the campaign's chosen site), the
 * host must match it exactly - a campaign can only point at its own site.
 * Throws a descriptive Error on failure; returns the parsed URL on success.
 */
async function validateDestinationUrl(rawUrl, { requiredHostname } = {}) {
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

    if (requiredHostname) {
        if (parsed.hostname.toLowerCase() !== String(requiredHostname).toLowerCase()) {
            throw new Error(`destinationUrl host "${parsed.hostname}" must match the selected campaign site's host ("${requiredHostname}")`);
        }
        return parsed;
    }

    if (!isProd && isLocalhost) {
        return parsed;
    }

    const allowedDomains = getAllowedDomains();
    if (isAllowedHostname(parsed.hostname, allowedDomains)) {
        return parsed;
    }

    const activeSiteOrigins = await campaignSiteStore.listActiveSiteOrigins();
    const activeSiteHostnames = activeSiteOrigins.map((o) => {
        try { return new URL(o).hostname.toLowerCase(); } catch { return null; }
    }).filter(Boolean);
    if (isAllowedHostname(parsed.hostname, activeSiteHostnames)) {
        return parsed;
    }

    throw new Error(`destinationUrl host "${parsed.hostname}" is not on the allowed domain list (no matching active campaign site)`);
}

/** Builds the shareable campaign link: destination URL with ref/campaign params set, preserving other params/hash. */
function buildCampaignLink(destinationUrl, couponCode, slug) {
    const url = new URL(destinationUrl);
    url.searchParams.set('ref', couponCode);
    url.searchParams.set('campaign', slug);
    return url.toString();
}

// Placeholder run through buildCampaignLink (rather than hand-building the URL) so
// querystring escaping/param-overwrite behavior stays identical to a real affiliate
// link - then swapped back to the literal, human-readable `{CODE}` token admins expect
// (URLSearchParams would otherwise percent-encode the braces).
const LINK_TEMPLATE_PLACEHOLDER = '__CAMPAIGN_CODE_PLACEHOLDER__';
function buildLinkTemplate(destinationUrl, slug) {
    const link = buildCampaignLink(destinationUrl, LINK_TEMPLATE_PLACEHOLDER, slug);
    return link.replace(LINK_TEMPLATE_PLACEHOLDER, '{CODE}');
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
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        destinationUrl: row.destination_url,
        notes: row.notes || '',
        active: row.active,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        // One campaign now applies to every affiliate (no single coupon_code of its own),
        // so there's no one "link" - linkTemplate is filled in per-affiliate by swapping
        // {CODE} for their personal coupon code (see listActiveCampaignsForAffiliate).
        linkTemplate: buildLinkTemplate(row.destination_url, row.slug),
        siteId: row.site_id || null,
        siteName: row.site_name || null,
        siteChannel: row.site_channel || null
    };
}

const CAMPAIGN_QUERY = `
    SELECT c.*, s.name AS site_name, s.channel AS site_channel
    FROM campaigns c
    LEFT JOIN campaign_sites s ON s.id = c.site_id
`;

const EMPTY_STATS = { paidCount: 0, pendingCount: 0, revenue: 0, discountTotal: 0, commissionTotal: 0 };

function sumStats(statsByCurrency) {
    return Object.values(statsByCurrency).reduce((acc, s) => ({
        paidCount: acc.paidCount + s.paidCount,
        pendingCount: acc.pendingCount + s.pendingCount,
        revenue: acc.revenue + s.revenue,
        discountTotal: acc.discountTotal + s.discountTotal,
        commissionTotal: acc.commissionTotal + s.commissionTotal
    }), { ...EMPTY_STATS });
}

/**
 * One aggregate query (GROUP BY campaign_id) for redemption stats, keyed by campaign id.
 * revenue/discountTotal/commissionTotal are summed over 'paid' rows only; base_amount is
 * already net of discount (computed post-discount pre-tax in paymentController), so
 * revenue does not subtract discount_amount again - matches the admin dashboard convention.
 *
 * Kept for backward compatibility: a campaign now can in principle span both LOCAL (PHP)
 * and GLOBAL (USD) redemptions (e.g. a legacy campaign with no site_id), so these scalar
 * totals can be a meaningless sum across currencies. Callers that care about currency
 * correctness should use `statsByCurrency` instead (see fetchCampaignStatsMap below).
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

/**
 * Same shape as fetchCampaignStatsMap's per-campaign entry, but grouped by (campaign_id,
 * currency) - the currency-safe version. Returns a map of campaignId -> { [currency]: stats }.
 */
async function fetchCampaignStatsByCurrencyMap(campaignIds) {
    const map = {};
    if (!Array.isArray(campaignIds) || campaignIds.length === 0) return map;
    const { rows } = await pool.query(
        `SELECT
            campaign_id,
            currency,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COALESCE(SUM(base_amount) FILTER (WHERE status = 'paid'), 0) AS revenue,
            COALESCE(SUM(discount_amount) FILTER (WHERE status = 'paid'), 0) AS discount_total,
            COALESCE(SUM(affiliate_fee_amount) FILTER (WHERE status = 'paid'), 0) AS commission_total
         FROM coupon_redemptions
         WHERE campaign_id = ANY($1::text[])
         GROUP BY campaign_id, currency`,
        [campaignIds]
    );
    for (const row of rows) {
        if (!map[row.campaign_id]) map[row.campaign_id] = {};
        map[row.campaign_id][row.currency] = {
            paidCount: row.paid_count,
            pendingCount: row.pending_count,
            revenue: Number(row.revenue),
            discountTotal: Number(row.discount_total),
            commissionTotal: Number(row.commission_total)
        };
    }
    return map;
}

/**
 * Per-affiliate stats breakdown for a batch of campaigns, keyed by campaign id -> array
 * of { affiliateId, affiliateName, affiliateEmail, couponCode, stats, statsByCurrency }.
 * Every affiliate with a coupon code is listed for every campaign (even with all-zero
 * stats), since one campaign now applies to all of them automatically. Two queries total
 * regardless of campaign count (no N+1).
 */
async function fetchAffiliateStatsMap(campaignIds) {
    const map = {};
    if (!Array.isArray(campaignIds) || campaignIds.length === 0) return map;

    const { rows: affiliates } = await pool.query(
        `SELECT id, first_name, last_name, email, coupon_code FROM affiliates WHERE coupon_code IS NOT NULL`
    );
    for (const campaignId of campaignIds) map[campaignId] = [];
    if (affiliates.length === 0) return map;

    const couponCodes = affiliates.map((a) => a.coupon_code);
    const { rows: statRows } = await pool.query(
        `SELECT campaign_id, code, currency,
                COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COALESCE(SUM(base_amount) FILTER (WHERE status = 'paid'), 0) AS revenue,
                COALESCE(SUM(discount_amount) FILTER (WHERE status = 'paid'), 0) AS discount_total,
                COALESCE(SUM(affiliate_fee_amount) FILTER (WHERE status = 'paid'), 0) AS commission_total
         FROM coupon_redemptions
         WHERE campaign_id = ANY($1::text[]) AND code = ANY($2::text[])
         GROUP BY campaign_id, code, currency`,
        [campaignIds, couponCodes]
    );

    const byCampaignCode = {};
    for (const row of statRows) {
        byCampaignCode[row.campaign_id] = byCampaignCode[row.campaign_id] || {};
        byCampaignCode[row.campaign_id][row.code] = byCampaignCode[row.campaign_id][row.code] || {};
        byCampaignCode[row.campaign_id][row.code][row.currency] = {
            paidCount: row.paid_count,
            pendingCount: row.pending_count,
            revenue: Number(row.revenue),
            discountTotal: Number(row.discount_total),
            commissionTotal: Number(row.commission_total)
        };
    }

    for (const campaignId of campaignIds) {
        map[campaignId] = affiliates.map((a) => {
            const statsByCurrency = (byCampaignCode[campaignId] && byCampaignCode[campaignId][a.coupon_code]) || {};
            return {
                affiliateId: a.id,
                affiliateName: `${a.first_name} ${a.last_name}`.trim(),
                affiliateEmail: a.email,
                couponCode: a.coupon_code,
                stats: sumStats(statsByCurrency),
                statsByCurrency
            };
        });
    }
    return map;
}

async function attachStats(campaigns) {
    const campaignIds = campaigns.map((c) => c.id);
    const [statsMap, statsByCurrencyMap, affiliateStatsMap] = await Promise.all([
        fetchCampaignStatsMap(campaignIds),
        fetchCampaignStatsByCurrencyMap(campaignIds),
        fetchAffiliateStatsMap(campaignIds)
    ]);
    return campaigns.map((c) => {
        const statsByCurrency = statsByCurrencyMap[c.id] || {};
        const currencies = Object.keys(statsByCurrency);
        return {
            ...c,
            stats: statsMap[c.id] || { ...EMPTY_STATS },
            statsByCurrency,
            currency: currencies.length === 1 ? currencies[0] : null,
            affiliateStats: affiliateStatsMap[c.id] || []
        };
    });
}

async function listCampaigns({ active } = {}) {
    const conditions = [];
    const params = [];
    if (active !== undefined && active !== null && active !== '') {
        params.push(active === true || active === 'true');
        conditions.push(`c.active = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`${CAMPAIGN_QUERY} ${where} ORDER BY c.created_at DESC`, params);
    return attachStats(rows.map(rowToCampaign));
}

async function findCampaignById(id) {
    if (!id) return null;
    const { rows } = await pool.query(`${CAMPAIGN_QUERY} WHERE c.id = $1`, [id]);
    if (!rows[0]) return null;
    const [campaign] = await attachStats([rowToCampaign(rows[0])]);
    return campaign;
}

/** Looks up a campaign by slug regardless of active status - caller must check the `active` field itself. */
async function findCampaignBySlug(slug) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return null;
    const { rows } = await pool.query(`${CAMPAIGN_QUERY} WHERE c.slug = $1`, [normalized]);
    return rows[0] ? rowToCampaign(rows[0]) : null;
}

/**
 * Every active campaign on an active site, each carrying THIS affiliate's own personal
 * link (destination + their coupon code) and stats filtered to their coupon code only -
 * campaigns apply to every affiliate automatically, including one who registered after
 * the campaign was created.
 */
async function listActiveCampaignsForAffiliate(affiliate) {
    if (!affiliate?.couponCode) return [];

    const { rows } = await pool.query(
        `${CAMPAIGN_QUERY} WHERE c.active = true AND s.active = true ORDER BY c.created_at DESC`
    );
    const campaigns = rows.map(rowToCampaign);
    if (campaigns.length === 0) return [];

    const campaignIds = campaigns.map((c) => c.id);
    const { rows: statRows } = await pool.query(
        `SELECT campaign_id, currency,
                COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COALESCE(SUM(base_amount) FILTER (WHERE status = 'paid'), 0) AS revenue,
                COALESCE(SUM(discount_amount) FILTER (WHERE status = 'paid'), 0) AS discount_total,
                COALESCE(SUM(affiliate_fee_amount) FILTER (WHERE status = 'paid'), 0) AS commission_total
         FROM coupon_redemptions
         WHERE campaign_id = ANY($1::text[]) AND code = $2
         GROUP BY campaign_id, currency`,
        [campaignIds, affiliate.couponCode]
    );
    const byCampaign = {};
    for (const row of statRows) {
        byCampaign[row.campaign_id] = byCampaign[row.campaign_id] || {};
        byCampaign[row.campaign_id][row.currency] = {
            paidCount: row.paid_count,
            pendingCount: row.pending_count,
            revenue: Number(row.revenue),
            discountTotal: Number(row.discount_total),
            commissionTotal: Number(row.commission_total)
        };
    }

    return campaigns.map((c) => {
        const statsByCurrency = byCampaign[c.id] || {};
        const currencies = Object.keys(statsByCurrency);
        return {
            id: c.id,
            name: c.name,
            slug: c.slug,
            siteName: c.siteName,
            siteChannel: c.siteChannel,
            destinationUrl: c.destinationUrl,
            link: buildCampaignLink(c.destinationUrl, affiliate.couponCode, c.slug),
            stats: sumStats(statsByCurrency),
            statsByCurrency,
            currency: currencies.length === 1 ? currencies[0] : null
        };
    });
}

async function createCampaign(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid campaign payload');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('name is required');

    const siteId = String(payload.siteId || '').trim();
    if (!siteId) throw new Error('siteId is required');
    const site = await campaignSiteStore.findSiteById(siteId);
    if (!site) {
        const err = new Error(`Campaign site "${siteId}" does not exist`);
        err.statusCode = 400;
        throw err;
    }
    const siteHostname = new URL(site.url).hostname;

    const destination = await validateDestinationUrl(payload.destinationUrl, { requiredHostname: siteHostname });
    const notes = payload.notes ? String(payload.notes) : null;
    const active = payload.active === undefined ? true : Boolean(payload.active);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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
            `INSERT INTO campaigns (id, name, slug, destination_url, notes, active, site_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, name, slug, destination.toString(), notes, active, siteId]
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

        let siteId = existing.site_id;
        let requiredHostname;
        if (payload.siteId !== undefined) {
            siteId = String(payload.siteId || '').trim() || null;
        }
        if (siteId) {
            const site = await campaignSiteStore.findSiteById(siteId);
            if (!site) {
                const err = new Error(`Campaign site "${siteId}" does not exist`);
                err.statusCode = 400;
                throw err;
            }
            requiredHostname = new URL(site.url).hostname;
        }

        const destinationUrl = payload.destinationUrl !== undefined
            ? (await validateDestinationUrl(payload.destinationUrl, { requiredHostname })).toString()
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

        // Note: couponCode is deliberately not accepted/updated here - campaigns are no
        // longer tied to a single coupon (see class-level comment at the top of this file).
        await client.query(
            `UPDATE campaigns SET name = $2, slug = $3, destination_url = $4, notes = $5, active = $6, site_id = $7, updated_at = now()
             WHERE id = $1`,
            [id, name, slug, destinationUrl, notes, active, siteId]
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
    buildLinkTemplate,
    slugify,
    listCampaigns,
    findCampaignById,
    findCampaignBySlug,
    listActiveCampaignsForAffiliate,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    fetchCampaignStatsMap
};
