// utils/ghlStudentUserStore.js
//
// Ledger of GHL student-account creation attempts (table ghl_student_users). Holds status,
// GHL user id and error only - never the generated password.
const pool = require('../db/pool');

function rowToRecord(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        paymentReference: row.payment_reference,
        email: row.email,
        fullName: row.full_name || '',
        productId: row.product_id || null,
        ghlUserId: row.ghl_user_id || null,
        status: row.status,
        error: row.error || null,
        attempts: Number(row.attempts),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

/**
 * Inserts the row for a payment (status 'pending', attempts 1). Returns
 * { claimed: true, record } for the first caller, or { claimed: false, record } with the
 * pre-existing row for a repeated webhook.
 */
async function claim({ paymentReference, email, fullName, productId }) {
    const inserted = await pool.query(
        `INSERT INTO ghl_student_users (payment_reference, email, full_name, product_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (payment_reference) DO NOTHING
         RETURNING *`,
        [paymentReference, email, fullName || null, productId || null]
    );
    if (inserted.rows[0]) return { claimed: true, record: rowToRecord(inserted.rows[0]) };
    return { claimed: false, record: await findByPaymentReference(paymentReference) };
}

async function findByPaymentReference(paymentReference) {
    const { rows } = await pool.query('SELECT * FROM ghl_student_users WHERE payment_reference = $1', [paymentReference]);
    return rowToRecord(rows[0]);
}

async function markResult(paymentReference, { status, ghlUserId = null, error = null }) {
    const { rows } = await pool.query(
        `UPDATE ghl_student_users
         SET status = $2, ghl_user_id = COALESCE($3, ghl_user_id), error = $4, updated_at = NOW()
         WHERE payment_reference = $1
         RETURNING *`,
        [paymentReference, status, ghlUserId, error]
    );
    return rowToRecord(rows[0]);
}

/**
 * Atomically claims up to `limit` retryable rows (failed, or stuck 'pending' for 10+ minutes,
 * with attempts < maxAttempts and untouched for `minAgeMinutes`), flips them to 'pending' and
 * bumps attempts. SKIP LOCKED keeps overlapping scheduler runs from double-processing a row.
 */
async function claimRetryable({ maxAttempts = 5, limit = 10, minAgeMinutes = 5 } = {}) {
    const { rows } = await pool.query(
        `UPDATE ghl_student_users SET status = 'pending', attempts = attempts + 1, updated_at = NOW()
         WHERE id IN (
             SELECT id FROM ghl_student_users
             WHERE attempts < $1
               AND (
                   (status = 'failed' AND updated_at <= NOW() - ($3 || ' minutes')::interval)
                   OR (status = 'pending' AND updated_at <= NOW() - INTERVAL '10 minutes')
               )
             ORDER BY updated_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [maxAttempts, limit, String(minAgeMinutes)]
    );
    return rows.map(rowToRecord);
}

/** Forces a specific row into a new attempt regardless of attempts / age (manual script). */
async function beginManualAttempt(paymentReference) {
    const { rows } = await pool.query(
        `UPDATE ghl_student_users SET status = 'pending', attempts = attempts + 1, updated_at = NOW()
         WHERE payment_reference = $1 RETURNING *`,
        [paymentReference]
    );
    return rowToRecord(rows[0]);
}

async function list({ status, email, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (email) { params.push(String(email).toLowerCase()); where.push(`lower(email) = $${params.length}`); }
    params.push(Math.min(Number(limit) || 200, 1000));
    const { rows } = await pool.query(
        `SELECT * FROM ghl_student_users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params
    );
    return rows.map(rowToRecord);
}

module.exports = { claim, findByPaymentReference, markResult, claimRetryable, beginManualAttempt, list };
