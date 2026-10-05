// utils/couponStore.js
const pool = require('../db/pool');
const couponSettings = require('./couponSettings');

// Soft cap applied to all coupon codes (new and existing). No existing code is
// anywhere near this length - it just guards against pathologically long input.
const MAX_COUPON_CODE_LENGTH = 50;

function toCouponCode(input) {
    return String(input || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/g, '');
}

/** trim+lowercase - the customer-identity key used for all "once per customer" coupon rules. */
function normalizeEmail(input) {
    return String(input || '').trim().toLowerCase();
}

const COUPON_TYPES = ['affiliate', 'general'];
const COUPON_ORIGINS = ['local', 'ghl'];

/** Returns undefined (caller should treat as "not specified") for empty/nullish input, else validates the enum. */
function normalizeCouponType(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const type = String(value).trim().toLowerCase();
    if (!COUPON_TYPES.includes(type)) {
        throw new Error(`type must be one of ${COUPON_TYPES.join(', ')}`);
    }
    return type;
}

/** undefined = not specified (preserve on update, defaults handled by caller); null = explicit "all locations". */
function normalizeGhlLocationIds(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Array.isArray(value)) throw new Error('ghlLocationIds must be an array of strings, or null');
    return value.map((v) => String(v).trim()).filter(Boolean);
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

/** Positive integer, or null for unlimited (null/undefined/''). Throws on anything else. */
function normalizePerCustomerLimit(value, fieldName) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) {
        throw new Error(`${fieldName} must be a positive integer, if set`);
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

    // undefined = not specified (default 1 on create, preserved on update); null/'' = unlimited.
    let maxRedemptionsPerCustomer;
    if (payload.maxRedemptionsPerCustomer !== undefined) {
        maxRedemptionsPerCustomer = normalizePerCustomerLimit(payload.maxRedemptionsPerCustomer, 'maxRedemptionsPerCustomer');
    }

    const notes = payload.notes ? String(payload.notes) : null;

    const type = normalizeCouponType(payload.type);
    const ghlLocationIds = normalizeGhlLocationIds(payload.ghlLocationIds);
    const localEnabled = payload.localEnabled === undefined ? undefined : Boolean(payload.localEnabled);
    const ghlCouponMeta = payload.ghlCouponMeta !== undefined ? payload.ghlCouponMeta : undefined;
    // Only honoured when a coupon row is first created; never changed by a later upsert.
    let origin;
    if (payload.origin !== undefined && payload.origin !== null && payload.origin !== '') {
        origin = String(payload.origin).trim().toLowerCase();
        if (!COUPON_ORIGINS.includes(origin)) throw new Error(`origin must be one of ${COUPON_ORIGINS.join(', ')}`);
    }

    return {
        code, discountPercent, affiliateFeePercent, affiliateEmail, active, expiresAt, productIds, maxRedemptions, maxRedemptionsPerCustomer, notes,
        type, ghlLocationIds, localEnabled, ghlCouponMeta, origin
    };
}

function rowToCoupon(row, productIds = []) {
    const coupon = {
        code: row.code,
        type: row.type || 'general',
        discountPercent: Number(row.discount_percent),
        affiliateFeePercent: Number(row.affiliate_fee_percent),
        affiliateEmail: row.affiliate_email || '',
        active: row.active,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        productIds,
        maxRedemptions: row.max_redemptions,
        maxRedemptionsPerCustomer: row.max_redemptions_per_customer ?? null,
        notes: row.notes || '',
        ghlLocationIds: row.ghl_location_ids || null,
        localEnabled: row.local_enabled !== false,
        ghlCouponMeta: row.ghl_coupon_meta || null,
        origin: row.origin || 'local',
        ghlSync: row.ghl_sync || null,
        ghlProductSync: row.ghl_product_sync || null
    };
    if (row.affiliate_id !== undefined) {
        coupon.affiliate = row.affiliate_id
            ? {
                id: row.affiliate_id,
                name: `${row.affiliate_first_name || ''} ${row.affiliate_last_name || ''}`.trim(),
                email: row.affiliate_linked_email
            }
            : null;
    }
    return coupon;
}

const COUPON_WITH_PRODUCTS_QUERY = `
    SELECT c.*, COALESCE(array_agg(cp.product_id) FILTER (WHERE cp.product_id IS NOT NULL), '{}') AS product_ids,
           a.id AS affiliate_id, a.first_name AS affiliate_first_name, a.last_name AS affiliate_last_name, a.email AS affiliate_linked_email
    FROM coupons c
    LEFT JOIN coupon_products cp ON cp.coupon_code = c.code
    LEFT JOIN affiliates a ON a.coupon_code = c.code
`;
const COUPON_GROUP_BY = 'GROUP BY c.code, a.id, a.first_name, a.last_name, a.email';

async function listCoupons({ type } = {}) {
    const conditions = [];
    const params = [];
    if (type) {
        params.push(normalizeCouponType(type));
        conditions.push(`c.type = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`${COUPON_WITH_PRODUCTS_QUERY} ${where} ${COUPON_GROUP_BY} ORDER BY c.code ASC`, params);
    return rows.map((r) => rowToCoupon(r, r.product_ids));
}

async function findCoupon(code) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return null;
    const { rows } = await pool.query(`${COUPON_WITH_PRODUCTS_QUERY} WHERE c.code = $1 ${COUPON_GROUP_BY}`, [normalizedCode]);
    return rows[0] ? rowToCoupon(rows[0], rows[0].product_ids) : null;
}

/**
 * Creates or fully replaces a coupon. `type` is sticky once a coupon exists - if the
 * caller doesn't pass one, the existing type is kept (never silently reset to
 * 'general'); if the caller passes one that conflicts with the existing type, the
 * upsert is rejected (a coupon's type is fixed at creation - see the admin controller
 * for the additional "admin cannot create an affiliate coupon" rule).
 */
async function upsertCoupon(payload) {
    const c = normalizeCouponInput(payload);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: existingRows } = await client.query('SELECT type, max_redemptions_per_customer FROM coupons WHERE code = $1 FOR UPDATE', [c.code]);
        const existingType = existingRows[0]?.type;
        let type;
        if (c.type !== undefined) {
            if (existingType && c.type !== existingType) {
                throw new Error(`Cannot change coupon "${c.code}" from type "${existingType}" to "${c.type}"`);
            }
            type = c.type;
        } else {
            type = existingType || 'general';
        }
        const localEnabled = c.localEnabled === undefined ? true : c.localEnabled;
        // Per-customer limit applies to general coupons only (affiliate coupons use the global
        // setting). Not specified: default 1 on create, existing value kept on update.
        let perCustomerLimit = null;
        if (type !== 'affiliate') {
            if (c.maxRedemptionsPerCustomer !== undefined) perCustomerLimit = c.maxRedemptionsPerCustomer;
            else perCustomerLimit = existingRows[0] ? existingRows[0].max_redemptions_per_customer : 1;
        }

        await client.query(
            `INSERT INTO coupons (code, discount_percent, affiliate_fee_percent, affiliate_email, active, expires_at, max_redemptions, notes, type, ghl_location_ids, local_enabled, ghl_coupon_meta, origin, max_redemptions_per_customer, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
             ON CONFLICT (code) DO UPDATE SET
                discount_percent = EXCLUDED.discount_percent,
                affiliate_fee_percent = EXCLUDED.affiliate_fee_percent,
                affiliate_email = EXCLUDED.affiliate_email,
                active = EXCLUDED.active,
                expires_at = EXCLUDED.expires_at,
                max_redemptions = EXCLUDED.max_redemptions,
                max_redemptions_per_customer = EXCLUDED.max_redemptions_per_customer,
                notes = EXCLUDED.notes,
                type = EXCLUDED.type,
                ghl_location_ids = EXCLUDED.ghl_location_ids,
                local_enabled = EXCLUDED.local_enabled,
                ghl_coupon_meta = COALESCE(EXCLUDED.ghl_coupon_meta, coupons.ghl_coupon_meta),
                updated_at = now()`,
            [
                c.code, c.discountPercent, c.affiliateFeePercent, c.affiliateEmail, c.active, c.expiresAt, c.maxRedemptions, c.notes,
                type, c.ghlLocationIds ?? null, localEnabled, c.ghlCouponMeta ? JSON.stringify(c.ghlCouponMeta) : null,
                c.origin || 'local', perCustomerLimit
            ]
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
 * Per-product coupon config for a LOCAL product (product_coupon_config, default allowed):
 * an affiliate coupon is blocked when the product's affiliate switch is off, a general coupon
 * when its code is on the product's block list. Applies on top of coupon_products.
 */
async function isCouponBlockedForLocalProduct(db, couponRow, productId) {
    const { rows } = await db.query(
        `SELECT c.affiliate_coupons_enabled,
                EXISTS (SELECT 1 FROM product_coupon_blocks b WHERE b.config_id = c.id AND b.coupon_code = $2) AS blocked
         FROM product_coupon_config c
         WHERE c.kind = 'local' AND c.location_key = '' AND c.ref = $1`,
        [productId, couponRow.code]
    );
    if (!rows[0]) return false;
    return couponRow.type === 'affiliate' ? rows[0].affiliate_coupons_enabled === false : rows[0].blocked;
}

/**
 * The coupon eligibility rules, shared by beginCouponReservation (mutating: runs inside
 * the reservation transaction, on a locked coupon row) and validateCouponReadOnly
 * (read-only quote path). `db` is a pg client or the pool. With `mutate: true` it also
 * supersedes the customer's own still-fresh pending holds and REQUIRES an email; with
 * `mutate: false` it writes nothing and per-customer rules apply only when an email is
 * given. Returns { coupon } or { error, reason }.
 */
async function checkCouponRules(db, { couponRow, normalizedCode, productId, normalizedEmail, mutate, isTest = false }) {
    if (!couponRow) return { error: 'Invalid promo code', reason: 'not_found' };

    if (!couponRow.active) return { error: 'This promo code is no longer active', reason: 'inactive' };

    if (couponRow.expires_at && new Date(couponRow.expires_at).getTime() < Date.now()) {
        return { error: 'This promo code has expired', reason: 'expired' };
    }

    // General (non-affiliate) coupons imported from GHL, or otherwise scoped away from
    // the Local funnel, are treated as an invalid code here.
    // GHL-origin coupons stay non-local even after being assigned to an affiliate.
    if (couponRow.local_enabled === false && (couponRow.type !== 'affiliate' || couponRow.origin === 'ghl')) {
        return { error: 'This coupon is not valid for this checkout.', reason: 'not_local_enabled' };
    }

    // Applying ANY coupon requires an email, so the per-customer rules below have
    // something to key on. The checkout itself already requires email as a top-level
    // field - this only matters if a caller reaches this path without one.
    if (mutate && !normalizedEmail) {
        return { error: 'An email address is required to apply a coupon', reason: 'email_required' };
    }

    const { rows: productRows } = await db.query(
        'SELECT product_id FROM coupon_products WHERE coupon_code = $1',
        [normalizedCode]
    );
    const productIds = productRows.map((r) => r.product_id);
    if (productIds.length > 0 && productId && !productIds.includes(productId)) {
        return { error: 'This promo code is not valid for the selected product', reason: 'product_not_eligible' };
    }
    if (productId && await isCouponBlockedForLocalProduct(db, couponRow, productId)) {
        return { error: 'This coupon is not valid for this product.', reason: 'product_coupon_disabled' };
    }

    if (normalizedEmail) {
        if (couponRow.type === 'affiliate') {
            // Affiliate codes have no total redemption cap, but a given customer may only
            // ever get ONE affiliate discount, across ALL affiliate codes (Local or
            // Global-imported). The coupon-row lock only serializes concurrent
            // checkouts for THIS code, so also take an advisory lock keyed on the
            // customer's email to serialize concurrent checkouts across different
            // affiliate codes for the same customer.
            if (mutate) {
                await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [normalizedEmail]);

                // This same customer's own still-fresh, unpaid attempt(s) - at any affiliate
                // code - are abandoned/superseded by this new checkout, not a second use: a
                // customer who opens checkout, abandons the PayMongo page, and retries within
                // the TTL must not be blocked by their own dangling 'pending' row. Once
                // superseded, only a genuinely PAID prior use blocks them below.
                await db.query(
                    `UPDATE coupon_redemptions cr
                     SET status = 'released', released_at = now()
                     FROM coupons c2
                     WHERE cr.code = c2.code AND c2.type = 'affiliate'
                       AND lower(cr.email) = $1
                       AND cr.status = 'pending'
                       AND cr.is_test = $3
                       AND cr.created_at > now() - $2::interval`,
                    [normalizedEmail, `${PENDING_RESERVATION_TTL_MINUTES} minutes`, Boolean(isTest)]
                );
            }

            const affiliateLimit = await couponSettings.getAffiliateDiscountsPerCustomer(db);
            if (affiliateLimit != null) {
                const { rows: priorRows } = await db.query(
                    `SELECT COUNT(*)::int AS count FROM coupon_redemptions cr
                     JOIN coupons c2 ON c2.code = cr.code
                     WHERE c2.type = 'affiliate'
                       AND lower(cr.email) = $1
                       AND cr.status = 'paid'
                       AND cr.is_test = false`,
                    [normalizedEmail]
                );
                if (priorRows[0].count >= affiliateLimit) {
                    return affiliateLimit === 1
                        ? { error: 'You have already used an affiliate discount.', reason: 'affiliate_already_used' }
                        : { error: 'You have reached the limit for affiliate discounts.', reason: 'affiliate_already_used' };
                }
            }
        } else {
            // Same idea as above, scoped to just this one code (the general-coupon rule
            // is per-code, not cross-code): the coupon-row FOR UPDATE lock already
            // serializes this against concurrent checkouts for the same code.
            if (mutate) {
                await db.query(
                    `UPDATE coupon_redemptions
                     SET status = 'released', released_at = now()
                     WHERE code = $1
                       AND lower(email) = $2
                       AND status = 'pending'
                       AND is_test = $4
                       AND created_at > now() - $3::interval`,
                    [normalizedCode, normalizedEmail, `${PENDING_RESERVATION_TTL_MINUTES} minutes`, Boolean(isTest)]
                );
            }

            const perCustomerLimit = couponRow.max_redemptions_per_customer;
            if (perCustomerLimit != null) {
                const { rows: priorRows } = await db.query(
                    `SELECT COUNT(*)::int AS count FROM coupon_redemptions
                     WHERE code = $1
                       AND lower(email) = $2
                       AND status = 'paid'
                       AND is_test = false`,
                    [normalizedCode, normalizedEmail]
                );
                if (priorRows[0].count >= perCustomerLimit) {
                    return perCustomerLimit === 1
                        ? { error: 'You have already used this coupon.', reason: 'coupon_already_used' }
                        : { error: 'You have reached the limit for this coupon.', reason: 'coupon_already_used' };
                }
            }
        }
    }

    if (couponRow.max_redemptions != null) {
        // The customer's own pending holds are excluded: on the mutating path they were
        // just released above (a no-op here), and on the read-only path they would be
        // superseded by the real checkout, so they must not block the quote either.
        const { rows: countRows } = await db.query(
            `SELECT COUNT(*)::int AS count FROM coupon_redemptions
             WHERE code = $1 AND is_test = false
               AND (status = 'paid' OR (status = 'pending' AND created_at > now() - $2::interval
                                        AND ($3::text IS NULL OR lower(coalesce(email, '')) <> $3)))`,
            [normalizedCode, `${PENDING_RESERVATION_TTL_MINUTES} minutes`, normalizedEmail || null]
        );
        if (countRows[0].count >= couponRow.max_redemptions) {
            return { error: 'This promo code has reached its redemption limit', reason: 'max_redemptions_reached' };
        }
    }

    return { coupon: rowToCoupon(couponRow, productIds) };
}

/**
 * Begins a coupon reservation for checkout. Locks the coupon row (FOR UPDATE) and
 * validates + counts existing holds against max_redemptions inside an open
 * transaction, so two concurrent checkouts for the same maxRedemptions:1 coupon
 * cannot both pass. On success, returns { client, coupon } - the caller must finish
 * the transaction with finalizeCouponReservation (commits + inserts the pending row)
 * or abortCouponReservation (rolls back), which release the client either way.
 * On failure, returns { error, reason } and the transaction/client are already closed.
 */
async function beginCouponReservation({ code, productId, email, isTest = false }) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return { error: 'No promo code provided' };

    const normalizedEmail = normalizeEmail(email);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: couponRows } = await client.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [normalizedCode]);
        const result = await checkCouponRules(client, {
            couponRow: couponRows[0], normalizedCode, productId, normalizedEmail, mutate: true, isTest
        });
        if (result.error) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            return { error: result.error, reason: result.reason };
        }
        return { client, coupon: result.coupon };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        throw err;
    }
}

/**
 * Read-only mirror of beginCouponReservation's rules (same code path, no locks, no
 * writes, no reservation). `email` is optional: per-customer rules (already-used) are
 * only evaluated when one is given. Returns { coupon } or { error, reason }.
 */
async function validateCouponReadOnly({ code, productId, email }) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return { error: 'No promo code provided', reason: 'no_code' };
    const { rows } = await pool.query('SELECT * FROM coupons WHERE code = $1', [normalizedCode]);
    return checkCouponRules(pool, {
        couponRow: rows[0], normalizedCode, productId, normalizedEmail: normalizeEmail(email), mutate: false
    });
}

/** Inserts the pending redemption row and commits the reservation transaction. */
async function finalizeCouponReservation(client, entry) {
    try {
        const id = `RDM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const { rows } = await client.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency, status, campaign_id, commission_base, is_test)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14)
             ON CONFLICT (payment_reference) DO NOTHING
             RETURNING *`,
            [
                id, toCouponCode(entry.code), String(entry.paymentReference || ''), entry.productId || null,
                entry.email || null, entry.fullName || null, Number(entry.baseAmount) || 0,
                Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
                entry.affiliateEmail || null, entry.currency || 'PHP', entry.campaignId || null,
                entry.commissionBase != null ? Number(entry.commissionBase) : null,
                Boolean(entry.isTest)
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

/**
 * Idempotently confirms a reservation as paid. Also promotes a 'released' row (freed up
 * because the customer opened a newer checkout attempt that superseded it - see
 * beginCouponReservation - or because an earlier payment.failed webhook released it) if
 * this specific payment_reference's payment completes anyway: the customer genuinely
 * paid for THAT checkout, so it must still be recorded as paid rather than silently
 * dropped. Returns null if no matching row exists (already paid, or none was made).
 */
async function markReservationPaid({ paymentReference, isTest }) {
    const ref = String(paymentReference || '');
    if (!ref) return null;
    // When isTest is given (webhook events), only a reservation made in that same PayMongo mode is confirmed.
    const params = [ref];
    let modeClause = '';
    if (isTest === true || isTest === false) { params.push(isTest); modeClause = ' AND is_test = $2'; }
    const { rows } = await pool.query(
        `UPDATE coupon_redemptions SET status = 'paid', paid_at = now() WHERE payment_reference = $1 AND status IN ('pending', 'released')${modeClause} RETURNING *`,
        params
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
async function releaseReservation(paymentReference, { isTest } = {}) {
    const ref = String(paymentReference || '');
    if (!ref) return 0;
    const params = [ref];
    let modeClause = '';
    if (isTest === true || isTest === false) { params.push(isTest); modeClause = ' AND is_test = $2'; }
    const { rowCount } = await pool.query(
        `UPDATE coupon_redemptions SET status = 'released', released_at = now() WHERE payment_reference = $1 AND status = 'pending'${modeClause}`,
        params
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
        campaignId: row.campaign_id || null,
        source: row.source || 'paymongo',
        channel: row.source === 'ghl' ? 'global' : 'local',
        ghlLocationId: row.ghl_location_id || null,
        ghlProductIds: row.ghl_product_ids || [],
        affiliatePaidAt: row.affiliate_paid_at ? new Date(row.affiliate_paid_at).toISOString() : null,
        refundedAt: row.refunded_at ? new Date(row.refunded_at).toISOString() : null,
        needsReview: Boolean(row.needs_review),
        commissionBase: row.commission_base != null ? Number(row.commission_base) : null,
        ghlOrderId: row.ghl_order_id || null,
        isTest: Boolean(row.is_test)
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
        `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency, status, paid_at, campaign_id, commission_base, is_test)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'paid',now(),$12,$13,$14)
         ON CONFLICT (payment_reference) DO NOTHING
         RETURNING *`,
        [
            id, toCouponCode(entry.code), String(entry.paymentReference || ''), entry.productId || null,
            entry.email || null, entry.fullName || null, Number(entry.baseAmount) || 0,
            Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
            entry.affiliateEmail || null, entry.currency || 'PHP', campaignId || null,
            entry.commissionBase != null ? Number(entry.commissionBase) : null,
            Boolean(entry.isTest)
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

async function listRedemptions({ code, status, payout } = {}) {
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
    if (payout === 'unpaid') {
        conditions.push(`affiliate_paid_at IS NULL`);
    } else if (payout === 'paid') {
        conditions.push(`affiliate_paid_at IS NOT NULL`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM coupon_redemptions ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToRedemption);
}

/**
 * Confirms affiliate payout for the given redemption ids. This is distinct from
 * `status` (which tracks the CUSTOMER's payment state - pending/paid/released) - a
 * redemption can be status='paid' (customer paid) for a long time before the affiliate
 * is actually paid out. Only rows that are status='paid' and not already paid out are
 * touched, so re-running with a stale id list is a no-op for those ids.
 * Returns { updated: string[], skipped: string[] } so the caller can tell which ids
 * were actually paid out vs. ignored (already paid out, or not a paid redemption yet).
 */
async function markRedemptionsPaid(ids) {
    const idList = (Array.isArray(ids) ? ids : [ids]).map(String);
    const { rows } = await pool.query(
        `UPDATE coupon_redemptions SET affiliate_paid_at = now()
         WHERE id = ANY($1::text[]) AND status = 'paid' AND affiliate_paid_at IS NULL AND is_test = false
         RETURNING id`,
        [idList]
    );
    const updated = rows.map((r) => r.id);
    const updatedSet = new Set(updated);
    const skipped = idList.filter((id) => !updatedSet.has(id));
    return { updated, skipped };
}

/**
 * Inserts a GLOBAL (GHL-sourced) redemption directly as 'paid' (entry.isTest marks a GHL test-mode order - never real money) - the GHL order import
 * already fetched full order detail before calling this, unlike the PayMongo
 * reservation flow. Idempotent via ON CONFLICT (payment_reference) DO NOTHING; returns
 * null (not inserted, already exists) or the inserted row.
 */
async function insertGhlRedemption(entry) {
    const id = `ghl_${entry.orderId}`;
    const paymentReference = `ghl:${entry.orderId}`;
    const { rows } = await pool.query(
        `INSERT INTO coupon_redemptions
            (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount,
             affiliate_fee_amount, affiliate_email, currency, status, created_at, paid_at, campaign_id,
             source, ghl_location_id, ghl_product_ids, commission_base, ghl_order_id, is_test)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,'paid',$11,$11,NULL,'ghl',$12,$13,$14,$15,$16)
         ON CONFLICT (payment_reference) DO NOTHING
         RETURNING *`,
        [
            id, toCouponCode(entry.code), paymentReference,
            entry.email || null, entry.fullName || null,
            Number(entry.baseAmount) || 0, Number(entry.discountAmount) || 0, Number(entry.affiliateFeeAmount) || 0,
            entry.affiliateEmail || null, entry.currency || 'USD', entry.createdAt || new Date().toISOString(),
            entry.ghlLocationId || null, entry.ghlProductIds || [],
            entry.commissionBase != null ? Number(entry.commissionBase) : null, String(entry.orderId),
            Boolean(entry.isTest)
        ]
    );
    return rows[0] ? rowToRedemption(rows[0]) : null;
}

/**
 * Applies a GHL order refund to an already-imported redemption. If the affiliate was
 * never paid out for it, it's simply released like any other unpaid reversal. If the
 * affiliate was already paid out, we can't silently claw that back - flag it for manual
 * review instead. Returns { action: 'released' | 'flagged' | 'not_found' }.
 */
async function applyGhlRefund(orderId) {
    const paymentReference = `ghl:${orderId}`;
    const { rows: existingRows } = await pool.query('SELECT * FROM coupon_redemptions WHERE payment_reference = $1', [paymentReference]);
    const existing = existingRows[0];
    if (!existing) return { action: 'not_found' };

    if (!existing.affiliate_paid_at) {
        await pool.query(
            `UPDATE coupon_redemptions SET status = 'released', released_at = now(), refunded_at = now() WHERE payment_reference = $1`,
            [paymentReference]
        );
        return { action: 'released' };
    }

    await pool.query(
        `UPDATE coupon_redemptions SET needs_review = true, refunded_at = now() WHERE payment_reference = $1`,
        [paymentReference]
    );
    return { action: 'flagged' };
}

/** A partial refund never changes status (the customer still gets some/most of what they paid for) - always flag for manual review. */
async function flagPartialRefund(orderId) {
    const paymentReference = `ghl:${orderId}`;
    const { rowCount } = await pool.query(
        `UPDATE coupon_redemptions SET needs_review = true, refunded_at = now() WHERE payment_reference = $1`,
        [paymentReference]
    );
    return { action: rowCount > 0 ? 'flagged' : 'not_found' };
}

/**
 * Auto-creates a coupon discovered on a native GHL order: general, GHL-origin, not usable
 * at local checkout. Idempotent (ON CONFLICT DO NOTHING - a concurrent/rerun never clobbers
 * an existing coupon). Returns true if a row was created.
 */
async function createGhlDiscoveredCoupon({ code, discountPercent = 0, locationId, limitPerCustomer = false }) {
    const normalizedCode = toCouponCode(code);
    const percent = Math.min(1, Math.max(0, Number(discountPercent) || 0));
    const { rowCount } = await pool.query(
        `INSERT INTO coupons (code, discount_percent, affiliate_fee_percent, active, notes, type, ghl_location_ids, local_enabled, origin, max_redemptions_per_customer)
         VALUES ($1,$2,0,true,'Discovered from GHL order','general',$3,false,'ghl',$4)
         ON CONFLICT (code) DO NOTHING`,
        [normalizedCode, percent, locationId ? [locationId] : null, limitPerCustomer ? 1 : null]
    );
    return rowCount > 0;
}

/** Records that a GHL-origin coupon was also seen at another GHL location. */
async function addGhlLocationToCoupon(code, locationId) {
    if (!locationId) return;
    await pool.query(
        `UPDATE coupons SET ghl_location_ids = array_append(COALESCE(ghl_location_ids, '{}'), $2::text)
         WHERE code = $1 AND origin = 'ghl' AND NOT ($2::text = ANY(COALESCE(ghl_location_ids, '{}')))`,
        [toCouponCode(code), locationId]
    );
}

/** Merges one location's push state into coupons.ghl_sync ({ [locationKey]: state }). */
async function setGhlSyncState(code, locationKey, state) {
    await pool.query(
        `UPDATE coupons SET ghl_sync = COALESCE(ghl_sync, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
         WHERE code = $1`,
        [toCouponCode(code), locationKey, JSON.stringify({ ...state, at: new Date().toISOString() })]
    );
}

/** Merges one location's product-restriction sync state into coupons.ghl_product_sync ({ [locationKey]: state }). */
async function setGhlProductSyncState(code, locationKey, state) {
    await pool.query(
        `UPDATE coupons SET ghl_product_sync = COALESCE(ghl_product_sync, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
         WHERE code = $1`,
        [toCouponCode(code), locationKey, JSON.stringify({ ...state, at: new Date().toISOString() })]
    );
}

/**
 * Local affiliate coupons with a push attempt that has not succeeded yet (pending or
 * error). Attempts newer than a minute are left alone so a retry never races the request
 * that is still pushing the same coupon.
 */
async function listCouponsWithPendingGhlPush() {
    const { rows } = await pool.query(
        `SELECT code FROM coupons
         WHERE origin = 'local' AND type = 'affiliate' AND active = true AND ghl_sync IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_each(ghl_sync) e
                 WHERE e.value->>'status' <> 'synced' AND (e.value->>'at')::timestamptz < now() - interval '1 minute')
         ORDER BY code`
    );
    return Promise.all(rows.map((r) => findCoupon(r.code)));
}

/** Sets a coupon's type/affiliate link directly (bypasses upsertCoupon's sticky-type rule). */
async function setCouponAffiliation(code, { type, affiliateEmail, affiliateFeePercent }) {
    const { rowCount } = await pool.query(
        `UPDATE coupons SET type = $2, affiliate_email = $3,
                affiliate_fee_percent = COALESCE($4::numeric, affiliate_fee_percent), updated_at = now()
         WHERE code = $1`,
        [toCouponCode(code), type, affiliateEmail || null, affiliateFeePercent == null ? null : affiliateFeePercent]
    );
    return rowCount > 0;
}

/** Paid GHL redemptions of a coupon that no affiliate has been credited for yet. */
async function listCreditableRedemptions(code) {
    const { rows } = await pool.query(
        `SELECT * FROM coupon_redemptions
         WHERE code = $1 AND source = 'ghl' AND status = 'paid' AND affiliate_email IS NULL AND is_test = false
         ORDER BY created_at DESC`,
        [toCouponCode(code)]
    );
    return rows.map(rowToRedemption);
}

/**
 * Credits still-unassigned paid GHL redemptions of `code` to an affiliate:
 * fee = commission_base x feePercent (falls back to base - discount when commission_base
 * is null). Already-credited rows are never touched. Returns the updated redemptions.
 */
async function creditRedemptions(code, { affiliateEmail, feePercent, redemptionIds = null }) {
    const { rows } = await pool.query(
        `UPDATE coupon_redemptions
         SET affiliate_email = $2,
             affiliate_fee_amount = ROUND(COALESCE(commission_base, GREATEST(base_amount - discount_amount, 0)) * $3::numeric, 2)
         WHERE code = $1 AND source = 'ghl' AND status = 'paid' AND affiliate_email IS NULL AND is_test = false
           AND ($4::text[] IS NULL OR id = ANY($4::text[]))
         RETURNING *`,
        [toCouponCode(code), affiliateEmail, feePercent, redemptionIds]
    );
    return rows.map(rowToRedemption);
}

/**
 * Net revenue before tax, consistent across channels: the stored commission_base, else a
 * legacy fallback - base_amount for PayMongo rows (already post-discount) and
 * base_amount - discount_amount for GHL rows (base_amount is the pre-discount subtotal).
 */
function netRevenue(r) {
    if (r.commissionBase != null) return r.commissionBase;
    return r.source === 'ghl' ? Math.max(r.baseAmount - r.discountAmount, 0) : r.baseAmount;
}

/** Sums paid redemptions per currency: { [currency]: { orders, revenue, discount, commission } }. */
function totalsByCurrencyForCoupon(redemptions) {
    const totals = {};
    for (const r of redemptions) {
        if (r.status !== 'paid' || r.isTest) continue;
        const t = totals[r.currency] || (totals[r.currency] = { orders: 0, revenue: 0, discount: 0, commission: 0 });
        t.orders += 1;
        t.revenue += netRevenue(r);
        t.discount += r.discountAmount;
        t.commission += r.affiliateFeeAmount;
    }
    for (const t of Object.values(totals)) {
        for (const k of ['revenue', 'discount', 'commission']) t[k] = Number(t[k].toFixed(2));
    }
    return totals;
}

/**
 * Per-currency TEST totals (paid is_test rows only): { [currency]: { sales, commission } }.
 * Shown separately from the live totals above; never payable.
 */
function testTotalsByCurrency(redemptions) {
    const totals = {};
    for (const r of redemptions) {
        if (r.status !== 'paid' || !r.isTest) continue;
        const cur = r.currency || 'PHP';
        const t = totals[cur] || (totals[cur] = { sales: 0, commission: 0 });
        t.sales += netRevenue(r);
        t.commission += r.affiliateFeeAmount;
    }
    for (const t of Object.values(totals)) {
        t.sales = Number(t.sales.toFixed(2));
        t.commission = Number(t.commission.toFixed(2));
    }
    return totals;
}

/**
 * Redemptions credited to an affiliate: rows on their own coupon OR any row whose
 * affiliate_email is theirs (e.g. a GHL coupon later assigned to them).
 */
async function listRedemptionsForAffiliate({ email, couponCode }) {
    const { rows } = await pool.query(
        `SELECT * FROM coupon_redemptions
         WHERE lower(affiliate_email) = $1 OR ($2::text IS NOT NULL AND code = $2)
         ORDER BY created_at DESC`,
        [normalizeEmail(email), couponCode ? toCouponCode(couponCode) : null]
    );
    return rows.map(rowToRedemption);
}

/** Every paid redemption (INCLUDING is_test rows - the totals helpers skip those) that is credited to some affiliate (by email or by an affiliate's own coupon). */
async function listPaidAffiliateRedemptions() {
    const { rows } = await pool.query(
        `SELECT * FROM coupon_redemptions
         WHERE status = 'paid'
           AND (affiliate_email IS NOT NULL OR code IN (SELECT coupon_code FROM affiliates WHERE coupon_code IS NOT NULL))`
    );
    return rows.map(rowToRedemption);
}

/** Per-currency affiliate totals from paid redemptions: { [currency]: { sales, commission, earned, paidOut, unpaid } }. */
function affiliateTotalsByCurrency(redemptions) {
    const totals = {};
    for (const r of redemptions) {
        if (r.status !== 'paid' || r.isTest) continue;
        const t = totals[r.currency || 'PHP'] || (totals[r.currency || 'PHP'] = { sales: 0, commission: 0, earned: 0, paidOut: 0, unpaid: 0 });
        t.sales += netRevenue(r);
        t.commission += r.affiliateFeeAmount;
        if (r.affiliatePaidAt) t.paidOut += r.affiliateFeeAmount;
    }
    for (const t of Object.values(totals)) {
        t.sales = Number(t.sales.toFixed(2));
        t.commission = Number(t.commission.toFixed(2));
        t.earned = t.commission;
        t.paidOut = Number(t.paidOut.toFixed(2));
        t.unpaid = Number((t.commission - t.paidOut).toFixed(2));
    }
    return totals;
}

module.exports = {
    toCouponCode,
    normalizeEmail,
    COUPON_TYPES,
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    beginCouponReservation,
    validateCouponReadOnly,
    finalizeCouponReservation,
    abortCouponReservation,
    markReservationPaid,
    findRedemptionByPaymentReference,
    releaseReservation,
    recordRedemption,
    listRedemptions,
    markRedemptionsPaid,
    insertGhlRedemption,
    applyGhlRefund,
    flagPartialRefund,
    createGhlDiscoveredCoupon,
    addGhlLocationToCoupon,
    setGhlSyncState,
    setGhlProductSyncState,
    listCouponsWithPendingGhlPush,
    setCouponAffiliation,
    listCreditableRedemptions,
    creditRedemptions,
    totalsByCurrencyForCoupon,
    listRedemptionsForAffiliate,
    listPaidAffiliateRedemptions,
    affiliateTotalsByCurrency,
    testTotalsByCurrency
};
