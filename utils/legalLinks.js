// utils/legalLinks.js
// Checkout legal links: a global default (app_settings) that any product can override per link.
const pool = require('../db/pool');

const MAX_URL_LENGTH = 2048;
const SETTING_KEYS = { termsUrl: 'terms_url', privacyUrl: 'privacy_url' };

/** Trimmed absolute http(s) URL, or null when empty/unset. Throws on anything else. */
function normalizeLegalUrl(value, label) {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_URL_LENGTH) throw new Error(`${label} must be at most ${MAX_URL_LENGTH} characters`);
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (err) {
        throw new Error(`${label} must be an absolute http:// or https:// URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must be an absolute http:// or https:// URL`);
    }
    return trimmed;
}

async function getGlobalLegalLinks() {
    const { rows } = await pool.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.values(SETTING_KEYS)]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
        termsUrl: byKey[SETTING_KEYS.termsUrl] || null,
        privacyUrl: byKey[SETTING_KEYS.privacyUrl] || null
    };
}

/**
 * Validates and saves the given links ({ termsUrl?, privacyUrl? }); a link that is
 * absent is left untouched, null/empty clears it. Throws (validation) before writing anything.
 */
async function setGlobalLegalLinks(input) {
    const body = input && typeof input === 'object' ? input : {};
    const updates = [];
    if (body.termsUrl !== undefined) updates.push([SETTING_KEYS.termsUrl, normalizeLegalUrl(body.termsUrl, 'termsUrl')]);
    if (body.privacyUrl !== undefined) updates.push([SETTING_KEYS.privacyUrl, normalizeLegalUrl(body.privacyUrl, 'privacyUrl')]);
    for (const [key, value] of updates) {
        await pool.query(
            `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [key, value]
        );
    }
    return getGlobalLegalLinks();
}

/** Links shown at checkout, per link independently: the product's own, else the global one, else null. */
async function resolveLegalLinks(product) {
    const own = (product && product.defaults) || {};
    const global = await getGlobalLegalLinks();
    return {
        termsUrl: own.termsUrl || global.termsUrl,
        privacyUrl: own.privacyUrl || global.privacyUrl
    };
}

module.exports = { MAX_URL_LENGTH, normalizeLegalUrl, getGlobalLegalLinks, setGlobalLegalLinks, resolveLegalLinks };
