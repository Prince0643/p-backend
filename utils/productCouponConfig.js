// utils/productCouponConfig.js
// Per-product coupon config (see product_coupon_config / product_coupon_blocks in db/schema.sql).
// Default is ALLOWED: a product with no row accepts every coupon. A row holds the one switch for
// ALL affiliate coupons plus a BLOCK list of general coupon codes, so a coupon created later is
// allowed everywhere until an admin switches it off.
const pool = require('../db/pool');
const couponStore = require('./couponStore');
const ghlService = require('../services/ghlService');

const KINDS = ['local', 'ghl'];
const GHL_LOCATION_KEYS = ['global', 'main'];

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

/**
 * Validates { kind, location, ref } at the system boundary into the stored identity
 * { kind, locationKey ('' for local), ref }. A local ref must be an existing product.
 */
async function normalizeProductKey({ kind, location, ref }) {
    const k = String(kind || '').trim().toLowerCase();
    if (!KINDS.includes(k)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    const r = String(ref == null ? '' : ref).trim();
    if (!r) throw badRequest('ref is required');
    if (r.length > 200) throw badRequest('ref is too long');

    if (k === 'local') {
        const { rows } = await pool.query('SELECT name FROM products WHERE id = $1', [r]);
        if (!rows[0]) throw badRequest('Unknown local product');
        return { kind: k, locationKey: '', ref: r, productName: rows[0].name };
    }
    const loc = String(location || '').trim().toLowerCase();
    if (!GHL_LOCATION_KEYS.includes(loc)) throw badRequest(`location must be one of ${GHL_LOCATION_KEYS.join(', ')} when kind is ghl`);
    return { kind: k, locationKey: loc, ref: r, productName: null };
}

/** The saved config for a product ({ name, affiliateCouponsEnabled, disabledCodes:Set }), or the defaults. */
async function getConfig(db, { kind, locationKey, ref }) {
    const { rows } = await db.query(
        `SELECT c.id, c.name, c.affiliate_coupons_enabled,
                COALESCE(array_agg(b.coupon_code) FILTER (WHERE b.coupon_code IS NOT NULL), '{}') AS codes
         FROM product_coupon_config c
         LEFT JOIN product_coupon_blocks b ON b.config_id = c.id
         WHERE c.kind = $1 AND c.location_key = $2 AND c.ref = $3
         GROUP BY c.id`,
        [kind, locationKey, ref]
    );
    if (!rows[0]) return { name: null, affiliateCouponsEnabled: true, disabledCodes: new Set() };
    return { name: rows[0].name, affiliateCouponsEnabled: rows[0].affiliate_coupons_enabled, disabledCodes: new Set(rows[0].codes) };
}

/**
 * Replaces a product's config in one transaction. Unknown coupon codes are rejected (400).
 * Returns { before, after } ({ affiliateCouponsEnabled, disabledCodes }) so the caller can work
 * out which coupons' GHL restrictions are affected. A config equal to the defaults is removed.
 */
async function saveConfig(key, { name, affiliateCouponsEnabled, disabledCouponCodes }) {
    if (typeof affiliateCouponsEnabled !== 'boolean') throw badRequest('affiliateCouponsEnabled must be a boolean');
    if (!Array.isArray(disabledCouponCodes)) throw badRequest('disabledCouponCodes must be an array');
    const codes = [...new Set(disabledCouponCodes.map((c) => couponStore.toCouponCode(c)).filter(Boolean))];

    if (codes.length) {
        const { rows } = await pool.query('SELECT code FROM coupons WHERE code = ANY($1::text[])', [codes]);
        const known = new Set(rows.map((r) => r.code));
        const unknown = codes.filter((c) => !known.has(c));
        if (unknown.length) throw badRequest(`Unknown coupon code(s): ${unknown.join(', ')}`);
    }

    const productName = name !== undefined && name !== null && String(name).trim() ? String(name).trim().slice(0, 200) : null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await getConfig(client, key);
        if (affiliateCouponsEnabled && codes.length === 0) {
            await client.query('DELETE FROM product_coupon_config WHERE kind = $1 AND location_key = $2 AND ref = $3', [key.kind, key.locationKey, key.ref]);
        } else {
            const { rows } = await client.query(
                `INSERT INTO product_coupon_config (kind, location_key, ref, name, affiliate_coupons_enabled, updated_at)
                 VALUES ($1, $2, $3, $4, $5, now())
                 ON CONFLICT (kind, location_key, ref) DO UPDATE SET
                    name = COALESCE(EXCLUDED.name, product_coupon_config.name),
                    affiliate_coupons_enabled = EXCLUDED.affiliate_coupons_enabled,
                    updated_at = now()
                 RETURNING id`,
                [key.kind, key.locationKey, key.ref, productName || key.productName, affiliateCouponsEnabled]
            );
            const configId = rows[0].id;
            await client.query('DELETE FROM product_coupon_blocks WHERE config_id = $1', [configId]);
            if (codes.length) {
                await client.query(
                    'INSERT INTO product_coupon_blocks (config_id, coupon_code) SELECT $1, unnest($2::text[])',
                    [configId, codes]
                );
            }
        }
        await client.query('COMMIT');
        return { before, after: { affiliateCouponsEnabled, disabledCodes: new Set(codes) } };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Map<localProductId, { affiliateCouponsEnabled, disabledCouponCount }> for products that have a config row. */
async function localConfigSummaries() {
    const { rows } = await pool.query(
        `SELECT c.ref, c.affiliate_coupons_enabled, COUNT(b.coupon_code)::int AS blocked
         FROM product_coupon_config c
         LEFT JOIN product_coupon_blocks b ON b.config_id = c.id
         WHERE c.kind = 'local'
         GROUP BY c.id`
    );
    return new Map(rows.map((r) => [r.ref, { affiliateCouponsEnabled: r.affiliate_coupons_enabled, disabledCouponCount: r.blocked }]));
}

/** The coupon-side reason a general coupon can't apply to this product anyway, or null. */
function ineligibleReason(coupon, key, ghlLocation) {
    if (!coupon.active) return 'inactive';
    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) return 'expired';
    if (key.kind === 'local') {
        if (coupon.productIds.length > 0 && !coupon.productIds.includes(key.ref)) return 'product_not_eligible';
        return null;
    }
    // The restriction GHL had before we ever wrote one (snapshot), else what the import recorded.
    const snapshot = coupon.ghlProductSync?.[key.locationKey]?.original;
    const original = Array.isArray(snapshot) ? snapshot : (coupon.ghlCouponMeta?.productIds || []);
    if (original.length > 0 && !original.includes(key.ref)) return 'ghl_product_not_eligible';
    return null;
}

/** GET shape: the product, its affiliate switch and the general coupons relevant to it. */
async function buildConfigView(key) {
    const config = await getConfig(pool, key);
    const general = await couponStore.listCoupons({ type: 'general' });

    let ghlLocation = null;
    let relevant;
    if (key.kind === 'local') {
        relevant = general.filter((c) => c.origin !== 'ghl' && c.localEnabled);
    } else {
        ghlLocation = ghlService.getTrackedLocations().find((l) => l.key === key.locationKey) || null;
        relevant = general.filter((c) => c.origin === 'ghl' && ghlLocation
            && (c.ghlCouponMeta?.byLocation || []).some((l) => l.locationId === ghlLocation.locationId));
    }

    return {
        product: { kind: key.kind, locationKey: key.kind === 'ghl' ? key.locationKey : null, ref: key.ref, name: config.name || key.productName || null },
        affiliateCouponsEnabled: config.affiliateCouponsEnabled,
        coupons: relevant.map((c) => {
            const reason = ineligibleReason(c, key, ghlLocation);
            return {
                code: c.code,
                discountPercent: c.discountPercent,
                active: c.active,
                origin: c.origin,
                enabled: !config.disabledCodes.has(c.code),
                eligible: !reason,
                ineligibleReason: reason
            };
        })
    };
}

/** Block data for GHL sync: Map<locationKey, { affiliateOff:Set<ref>, blocked:Map<code, Set<ref>> }>. */
async function loadGhlBlockRules() {
    const { rows } = await pool.query(
        `SELECT c.location_key, c.ref, c.affiliate_coupons_enabled,
                COALESCE(array_agg(b.coupon_code) FILTER (WHERE b.coupon_code IS NOT NULL), '{}') AS codes
         FROM product_coupon_config c
         LEFT JOIN product_coupon_blocks b ON b.config_id = c.id
         WHERE c.kind = 'ghl'
         GROUP BY c.id`
    );
    const rules = new Map();
    for (const r of rows) {
        if (!rules.has(r.location_key)) rules.set(r.location_key, { affiliateOff: new Set(), blocked: new Map() });
        const loc = rules.get(r.location_key);
        if (!r.affiliate_coupons_enabled) loc.affiliateOff.add(r.ref);
        for (const code of r.codes) {
            if (!loc.blocked.has(code)) loc.blocked.set(code, new Set());
            loc.blocked.get(code).add(r.ref);
        }
    }
    return rules;
}

module.exports = {
    normalizeProductKey,
    getConfig,
    saveConfig,
    localConfigSummaries,
    buildConfigView,
    loadGhlBlockRules
};
