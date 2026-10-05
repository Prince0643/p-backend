// utils/couponSettings.js
// Global coupon settings kept in app_settings. Today: how many affiliate discounts one customer
// may use in total, across ALL affiliate codes (general coupons have a per-coupon limit instead).
const pool = require('../db/pool');

const AFFILIATE_LIMIT_KEY = 'affiliate_discounts_per_customer';
const DEFAULT_AFFILIATE_DISCOUNTS_PER_CUSTOMER = 1;

/** Positive integer, or null for unlimited (null/undefined/''). Throws on anything else. */
function normalizeAffiliateDiscountsPerCustomer(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof num !== 'number' || !Number.isInteger(num) || num < 1) {
        throw new Error('affiliateDiscountsPerCustomer must be a positive integer, or empty for unlimited');
    }
    return num;
}

/**
 * The global affiliate-discounts-per-customer limit: a positive integer, or null = unlimited.
 * No row = the default (1); a row with a NULL value = unlimited. `db` is a pg client or the pool.
 */
async function getAffiliateDiscountsPerCustomer(db = pool) {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [AFFILIATE_LIMIT_KEY]);
    if (!rows[0]) return DEFAULT_AFFILIATE_DISCOUNTS_PER_CUSTOMER;
    return rows[0].value == null ? null : Number(rows[0].value);
}

async function setAffiliateDiscountsPerCustomer(value) {
    const limit = normalizeAffiliateDiscountsPerCustomer(value);
    await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [AFFILIATE_LIMIT_KEY, limit == null ? null : String(limit)]
    );
    return limit;
}

module.exports = {
    AFFILIATE_LIMIT_KEY,
    DEFAULT_AFFILIATE_DISCOUNTS_PER_CUSTOMER,
    normalizeAffiliateDiscountsPerCustomer,
    getAffiliateDiscountsPerCustomer,
    setAffiliateDiscountsPerCustomer
};
