// utils/couponStore.js
const pool = require('../db/pool');

function toCouponCode(input) {
    return String(input || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/g, '');
}

function normalizePercent(value, fieldName, { required = false, defaultValue = 0 } = {}) {
    if (value == null || value === '') {
        if (required) throw new Error(`${fieldName} is required`);
        return defaultValue;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
        throw new Error(`${fieldName} must be a number between 0 and 1`);
    }
    return num;
}

function normalizeCouponInput(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid coupon payload');
    }

    const code = toCouponCode(payload.code);
    if (!code) throw new Error('Coupon code is required');

    const discountPercent = normalizePercent(payload.discountPercent, 'discountPercent', { required: true });
    const affiliateFeePercent = normalizePercent(payload.affiliateFeePercent, 'affiliateFeePercent', { defaultValue: 0 });
    const affiliateEmail = payload.affiliateEmail ? String(payload.affiliateEmail).trim() : null;
    const active = payload.active === undefined ? true : Boolean(payload.active);

    let expiresAt = null;
    if (payload.expiresAt) {
        const d = new Date(payload.expiresAt);
        if (Number.isNaN(d.getTime())) throw new Error('expiresAt must be a valid date/time');
        expiresAt = d.toISOString();
    }

    const productIds = Array.isArray(payload.productIds)
        ? payload.productIds.map((id) => String(id).trim()).filter(Boolean)
        : [];

    const maxRedemptions = (payload.maxRedemptions === undefined || payload.maxRedemptions === null || payload.maxRedemptions === '')
        ? null
        : Number(payload.maxRedemptions);
    if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
        throw new Error('maxRedemptions must be a positive integer, if set');
    }

    const notes = payload.notes ? String(payload.notes) : null;

    return { code, discountPercent, affiliateFeePercent, affiliateEmail, active, expiresAt, productIds, maxRedemptions, notes };
}

function rowToCoupon(row, productIds = []) {
    return {
        code: row.code,
        discountPercent: Number(row.discount_percent),
        affiliateFeePercent: Number(row.affiliate_fee_percent),
        affiliateEmail: row.affiliate_email || '',
        active: row.active,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        productIds,
        maxRedemptions: row.max_redemptions,
        notes: row.notes || ''
    };
}

const COUPON_WITH_PRODUCTS_QUERY = `
    SELECT c.*, COALESCE(array_agg(cp.product_id) FILTER (WHERE cp.product_id IS NOT NULL), '{}') AS product_ids
    FROM coupons c
    LEFT JOIN coupon_products cp ON cp.coupon_code = c.code
`;

async function listCoupons() {
    const { rows } = await pool.query(`${COUPON_WITH_PRODUCTS_QUERY} GROUP BY c.code ORDER BY c.code ASC`);
    return rows.map((r) => rowToCoupon(r, r.product_ids));
}

async function findCoupon(code) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return null;
    const { rows } = await pool.query(`${COUPON_WITH_PRODUCTS_QUERY} WHERE c.code = $1 GROUP BY c.code`, [normalizedCode]);
    return rows[0] ? rowToCoupon(rows[0], rows[0].product_ids) : null;
}

async function upsertCoupon(payload) {
    const c = normalizeCouponInput(payload);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO coupons (code, discount_percent, affiliate_fee_percent, affiliate_email, active, expires_at, max_redemptions, notes, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
             ON CONFLICT (code) DO UPDATE SET
                discount_percent = EXCLUDED.discount_percent,
                affiliate_fee_percent = EXCLUDED.affiliate_fee_percent,
                affiliate_email = EXCLUDED.affiliate_email,
                active = EXCLUDED.active,
                expires_at = EXCLUDED.expires_at,
                max_redemptions = EXCLUDED.max_redemptions,
                notes = EXCLUDED.notes,
                updated_at = now()`,
            [c.code, c.discountPercent, c.affiliateFeePercent, c.affiliateEmail, c.active, c.expiresAt, c.maxRedemptions, c.notes]
        );
        await client.query('DELETE FROM coupon_products WHERE coupon_code = $1', [c.code]);
        for (const productId of c.productIds) {
            await client.query('INSERT INTO coupon_products (coupon_code, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.code, productId]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    return findCoupon(c.code);
}

async function deleteCoupon(code) {
    const normalizedCode = toCouponCode(code);
    const { rowCount } = await pool.query('DELETE FROM coupons WHERE code = $1', [normalizedCode]);
    return rowCount > 0;
}

async function countRedemptions(code) {
    const normalizedCode = toCouponCode(code);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM coupon_redemptions WHERE code = $1', [normalizedCode]);
    return rows[0].count;
}

/**
 * Validates a coupon code against server-side truth for a specific product/charge.
 * Returns { coupon } on success, or { error, reason } on failure. Never throws for
 * expected validation failures so callers can turn this straight into a 400 response.
 */
async function validateCouponForCharge({ code, productId }) {
    if (!code) return { error: 'No promo code provided' };

    const coupon = await findCoupon(code);
    if (!coupon) return { error: 'Invalid promo code', reason: 'not_found' };

    if (!coupon.active) return { error: 'This promo code is no longer active', reason: 'inactive' };

    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
        return { error: 'This promo code has expired', reason: 'expired' };
    }

    if (coupon.productIds.length > 0 && productId && !coupon.productIds.includes(productId)) {
        return { error: 'This promo code is not valid for the selected product', reason: 'product_not_eligible' };
    }

    if (coupon.maxRedemptions != null) {
        const used = await countRedemptions(coupon.code);
        if (used >= coupon.maxRedemptions) {
            return { error: 'This promo code has reached its redemption limit', reason: 'max_redemptions_reached' };
        }
    }

    return { coupon };
}

function rowToRedemption(row) {
    return {
        id: row.id,
        code: row.code,
        paymentReference: row.payment_reference,
        productId: row.product_id || '',
        email: row.email || '',
        fullName: row.full_name || '',
        baseAmount: Number(row.base_amount),
        discountAmount: Number(row.discount_amount),
        affiliateFeeAmount: Number(row.affiliate_fee_amount),
        affiliateEmail: row.affiliate_email || '',
        currency: row.currency,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null
    };
}

async function recordRedemption(entry) {
    const id = `RDM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const { rows } = await pool.query(
        `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
            id, toCouponCode(entry.code), String(entry.paymentReference || ''), entry.productId || null,
            entry.email || null, entry.fullName || null, Number(entry.baseAmount) || 0,
            Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
            entry.affiliateEmail || null, entry.currency || 'PHP'
        ]
    );
    return rowToRedemption(rows[0]);
}

async function listRedemptions({ code, status } = {}) {
    const conditions = [];
    const params = [];
    if (code) {
        params.push(toCouponCode(code));
        conditions.push(`code = $${params.length}`);
    }
    if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM coupon_redemptions ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToRedemption);
}

async function markRedemptionsPaid(ids) {
    const idList = Array.isArray(ids) ? ids : [ids];
    const { rowCount } = await pool.query(
        `UPDATE coupon_redemptions SET status = 'paid', paid_at = now() WHERE id = ANY($1::text[]) AND status != 'paid'`,
        [idList.map(String)]
    );
    return rowCount;
}

module.exports = {
    toCouponCode,
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    validateCouponForCharge,
    recordRedemption,
    listRedemptions,
    markRedemptionsPaid
};
