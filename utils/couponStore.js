// utils/couponStore.js
const pool = require('../db/pool');

// Soft cap applied to all coupon codes (new and existing). No existing code is
// anywhere near this length - it just guards against pathologically long input.
const MAX_COUPON_CODE_LENGTH = 50;

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
    if (code.length > MAX_COUPON_CODE_LENGTH) {
        throw new Error(`Coupon code must be at most ${MAX_COUPON_CODE_LENGTH} characters`);
    }

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

// Deliberately not ON DELETE CASCADE on the referencing tables below - a coupon with
// real redemption history or an affiliate link represents actual payout/financial
// records, and silently cascading the delete would destroy them. Blocked deletes are
// turned into a specific, actionable message instead of a raw FK-violation error.
const COUPON_DELETE_BLOCKED_REASONS = {
    affiliates: 'it is linked to an affiliate - reassign or terminate that affiliate first, or just set this coupon to Inactive instead of deleting it',
    coupon_redemptions: 'it has redemption/payout history - set it to Inactive instead of deleting, so that history stays intact',
    digital_solutions_transactions: 'it is referenced by past transactions - set it to Inactive instead of deleting'
};

async function deleteCoupon(code) {
    const normalizedCode = toCouponCode(code);
    try {
        const { rowCount } = await pool.query('DELETE FROM coupons WHERE code = $1', [normalizedCode]);
        return rowCount > 0;
    } catch (err) {
        if (err.code === '23503') {
            const reason = COUPON_DELETE_BLOCKED_REASONS[err.table] || 'it is still referenced elsewhere';
            throw new Error(`Cannot delete coupon "${normalizedCode}" because ${reason}.`);
        }
        throw err;
    }
}

// A 'pending' redemption (reserved at checkout creation, before payment) still counts
// toward max_redemptions while it's this fresh, so a maxRedemptions:1 coupon can't be
// reserved by a second concurrent checkout. Past this age, an abandoned checkout that
// never got a payment.paid/payment.failed webhook stops blocking the coupon.
const PENDING_RESERVATION_TTL_MINUTES = 30;

/**
 * Begins a coupon reservation for checkout. Locks the coupon row (FOR UPDATE) and
 * validates + counts existing holds against max_redemptions inside an open
 * transaction, so two concurrent checkouts for the same maxRedemptions:1 coupon
 * cannot both pass. On success, returns { client, coupon } - the caller must finish
 * the transaction with finalizeCouponReservation (commits + inserts the pending row)
 * or abortCouponReservation (rolls back), which release the client either way.
 * On failure, returns { error, reason } and the transaction/client are already closed.
 */
async function beginCouponReservation({ code, productId }) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return { error: 'No promo code provided' };

    const client = await pool.connect();
    const fail = async (error, reason) => {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return { error, reason };
    };

    try {
        await client.query('BEGIN');

        const { rows: couponRows } = await client.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [normalizedCode]);
        const couponRow = couponRows[0];
        if (!couponRow) return await fail('Invalid promo code', 'not_found');

        if (!couponRow.active) return await fail('This promo code is no longer active', 'inactive');

        if (couponRow.expires_at && new Date(couponRow.expires_at).getTime() < Date.now()) {
            return await fail('This promo code has expired', 'expired');
        }

        const { rows: productRows } = await client.query(
            'SELECT product_id FROM coupon_products WHERE coupon_code = $1',
            [normalizedCode]
        );
        const productIds = productRows.map((r) => r.product_id);
        if (productIds.length > 0 && productId && !productIds.includes(productId)) {
            return await fail('This promo code is not valid for the selected product', 'product_not_eligible');
        }

        if (couponRow.max_redemptions != null) {
            const { rows: countRows } = await client.query(
                `SELECT COUNT(*)::int AS count FROM coupon_redemptions
                 WHERE code = $1
                   AND (status = 'paid' OR (status = 'pending' AND created_at > now() - $2::interval))`,
                [normalizedCode, `${PENDING_RESERVATION_TTL_MINUTES} minutes`]
            );
            if (countRows[0].count >= couponRow.max_redemptions) {
                return await fail('This promo code has reached its redemption limit', 'max_redemptions_reached');
            }
        }

        return { client, coupon: rowToCoupon(couponRow, productIds) };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        throw err;
    }
}

/** Inserts the pending redemption row and commits the reservation transaction. */
async function finalizeCouponReservation(client, entry) {
    try {
        const id = `RDM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const { rows } = await client.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency, status, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
             ON CONFLICT (payment_reference) DO NOTHING
             RETURNING *`,
            [
                id, toCouponCode(entry.code), String(entry.paymentReference || ''), entry.productId || null,
                entry.email || null, entry.fullName || null, Number(entry.baseAmount) || 0,
                Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
                entry.affiliateEmail || null, entry.currency || 'PHP', entry.campaignId || null
            ]
        );
        if (!rows[0]) {
            throw new Error(`Duplicate payment reference for coupon reservation: ${entry.paymentReference}`);
        }
        await client.query('COMMIT');
        return rowToRedemption(rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Rolls back an in-progress reservation transaction (e.g. checkout failed before the pending row was inserted). */
async function abortCouponReservation(client) {
    try {
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
}

/** Idempotently confirms a reservation as paid. Returns null if no matching pending row exists (already paid, or none was made). */
async function markReservationPaid({ paymentReference }) {
    const ref = String(paymentReference || '');
    if (!ref) return null;
    const { rows } = await pool.query(
        `UPDATE coupon_redemptions SET status = 'paid', paid_at = now() WHERE payment_reference = $1 AND status = 'pending' RETURNING *`,
        [ref]
    );
    return rows[0] ? rowToRedemption(rows[0]) : null;
}

async function findRedemptionByPaymentReference(paymentReference) {
    const ref = String(paymentReference || '');
    if (!ref) return null;
    const { rows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [ref]);
    return rows[0] ? rowToRedemption(rows[0]) : null;
}

/** Releases a pending hold (payment failed/was cancelled) so the coupon use is freed up again. */
async function releaseReservation(paymentReference) {
    const ref = String(paymentReference || '');
    if (!ref) return 0;
    const { rowCount } = await pool.query(
        `UPDATE coupon_redemptions SET status = 'released', released_at = now() WHERE payment_reference = $1 AND status = 'pending'`,
        [ref]
    );
    return rowCount;
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
        paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
        releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
        campaignId: row.campaign_id || null
    };
}

/**
 * Records a redemption directly as 'paid', bypassing the pending-reservation flow.
 * Only meant as a defensive fallback for payment.paid webhooks whose checkout has no
 * matching reservation (e.g. rows from before reservations existed) - normal checkouts
 * should already have a pending row that markReservationPaid can confirm instead.
 */
async function insertRedemptionPaid(entry, campaignId) {
    const id = `RDM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const { rows } = await pool.query(
        `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency, status, paid_at, campaign_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'paid',now(),$12)
         ON CONFLICT (payment_reference) DO NOTHING
         RETURNING *`,
        [
            id, toCouponCode(entry.code), String(entry.paymentReference || ''), entry.productId || null,
            entry.email || null, entry.fullName || null, Number(entry.baseAmount) || 0,
            Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
            entry.affiliateEmail || null, entry.currency || 'PHP', campaignId || null
        ]
    );
    return rows[0] ? rowToRedemption(rows[0]) : null;
}

/**
 * Records a redemption directly as 'paid' (see doc comment above). entry.campaignId comes
 * from PayMongo webhook metadata, which was captured at checkout time and can go stale -
 * e.g. an admin deletes the campaign between checkout and the payment.paid webhook firing.
 * If the FK insert fails because campaign_id no longer references a row (23503), retry once
 * with campaign_id nulled out rather than losing the whole redemption record.
 */
async function recordRedemption(entry) {
    try {
        return await insertRedemptionPaid(entry, entry.campaignId || null);
    } catch (err) {
        if (err.code === '23503' && err.constraint && String(err.constraint).includes('campaign')) {
            console.log('recordRedemption: campaign_id no longer references an existing campaign, retrying without it:', entry.campaignId);
            return await insertRedemptionPaid(entry, null);
        }
        throw err;
    }
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
    beginCouponReservation,
    finalizeCouponReservation,
    abortCouponReservation,
    markReservationPaid,
    findRedemptionByPaymentReference,
    releaseReservation,
    recordRedemption,
    listRedemptions,
    markRedemptionsPaid
};
