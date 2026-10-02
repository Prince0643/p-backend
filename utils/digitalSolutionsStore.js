// utils/digitalSolutionsStore.js
//
// Relational ledger of every "digital solution" transaction this backend processes -
// Nexistry Academy product purchases, Clockistry/Nexiflow subscription upgrades, and native
// GHL checkout orders (type 'ghl_order', live and test mode, mirrored by ghlOrderImport).
const pool = require('../db/pool');

function rowToTransaction(row, { withRaw = false } = {}) {
    const ghlProductIds = row.ghl_product_ids || [];
    const transaction = {
        id: row.id,
        type: row.type,
        transactionId: row.transaction_id,
        customerEmail: row.customer_email || '',
        customerName: row.customer_name || '',
        companyId: row.company_id || undefined,
        userId: row.user_id || undefined,
        productId: row.product_id || (ghlProductIds.length ? ghlProductIds.join(', ') : undefined),
        productName: row.product_name || undefined,
        plan: row.plan || undefined,
        userCount: row.user_count != null ? Number(row.user_count) : undefined,
        amount: row.amount != null ? Number(row.amount) : undefined,
        currency: row.currency,
        promoCode: row.promo_code || undefined,
        source: row.source || undefined,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        isTest: Boolean(row.is_test),
        paymongoPaymentIntentId: row.paymongo_payment_intent_id || undefined,
        ghlLocationId: row.ghl_location_id || undefined,
        ghlProductIds: row.type === 'ghl_order' ? ghlProductIds : undefined,
        ghlPaymentStatus: row.ghl_payment_status || undefined,
        ghlOrderId: row.type === 'ghl_order' ? String(row.transaction_id).replace(/^ghl:/, '') : undefined,
        // Legal consent captured at embed checkout (links are the exact ones resolved at that time).
        termsAcceptedAt: row.terms_accepted_at ? new Date(row.terms_accepted_at).toISOString() : undefined,
        termsUrl: row.terms_url || undefined,
        privacyUrl: row.privacy_url || undefined
    };
    if (withRaw) transaction.raw = row.raw || undefined;
    return transaction;
}

/**
 * Records a new transaction at checkout-creation time (status: 'initiated').
 * `type` is 'academy_product' or 'clockistry_subscription'. `transactionId` is the
 * value used to find and update this record later (paymentReference for Academy,
 * internal_transaction_id for Clockistry).
 */
async function recordTransaction(entry) {
    const id = `DST${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const { rows } = await pool.query(
        `INSERT INTO digital_solutions_transactions
            (id, type, transaction_id, customer_email, customer_name, company_id, user_id, product_id, product_name, plan, user_count, amount, currency, promo_code, source, status, is_test, paymongo_payment_intent_id, terms_accepted_at, terms_url, privacy_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
            id, entry.type, String(entry.transactionId || ''),
            entry.customerEmail ? String(entry.customerEmail).toLowerCase() : null,
            entry.customerName ? String(entry.customerName) : null,
            entry.companyId ? String(entry.companyId) : null,
            entry.userId ? String(entry.userId) : null,
            entry.productId ? String(entry.productId) : null,
            entry.productName ? String(entry.productName) : null,
            entry.plan ? String(entry.plan) : null,
            entry.userCount != null ? Number(entry.userCount) : null,
            entry.amount != null ? Number(entry.amount) : null,
            entry.currency ? String(entry.currency).toUpperCase() : 'PHP',
            entry.promoCode ? String(entry.promoCode) : null,
            entry.source ? String(entry.source) : null,
            entry.status || 'initiated',
            Boolean(entry.isTest),
            entry.paymongoPaymentIntentId ? String(entry.paymongoPaymentIntentId) : null,
            entry.termsAcceptedAt || null,
            entry.termsUrl || null,
            entry.privacyUrl || null
        ]
    );
    return rowToTransaction(rows[0]);
}

/**
 * Updates a transaction's status by transactionId (set at creation). Called when
 * the PayMongo webhook reports paid/failed. No-op (returns null) if the
 * transaction isn't found - e.g. it predates this tracker.
 */
async function updateTransactionStatus(transactionId, status, { isTest } = {}) {
    const id = String(transactionId || '');
    if (!id) return null;

    // When isTest is given (webhook events), only a row created in that same PayMongo mode is touched.
    const params = [id, status];
    let modeClause = '';
    if (isTest === true || isTest === false) { params.push(isTest); modeClause = ' AND is_test = $3'; }
    const { rows } = await pool.query(
        `UPDATE digital_solutions_transactions SET status = $2, updated_at = now() WHERE transaction_id = $1${modeClause} RETURNING *`,
        params
    );
    return rows[0] ? rowToTransaction(rows[0]) : null;
}

async function listTransactions({ type, status, companyId, email, isTest } = {}) {
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (companyId) { params.push(companyId); conditions.push(`company_id = $${params.length}`); }
    if (email) { params.push(String(email).toLowerCase()); conditions.push(`customer_email = $${params.length}`); }

    if (isTest === true || isTest === false) { params.push(isTest); conditions.push(`is_test = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM digital_solutions_transactions ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToTransaction);
}

async function findByTransactionId(transactionId) {
    const { rows } = await pool.query('SELECT * FROM digital_solutions_transactions WHERE transaction_id = $1', [String(transactionId || '')]);
    return rows[0] ? rowToTransaction(rows[0], { withRaw: true }) : null;
}

/** The transaction created for a PayMongo payment intent (carries the stored is_test mode), or null. */
async function findByPaymongoPaymentIntentId(paymentIntentId) {
    const id = String(paymentIntentId || '');
    if (!id) return null;
    const { rows } = await pool.query(
        'SELECT * FROM digital_solutions_transactions WHERE paymongo_payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1',
        [id]
    );
    return rows[0] ? rowToTransaction(rows[0]) : null;
}

/** Status + test flag of an already-recorded GHL order, or null. Lets the import skip re-fetching unchanged orders. */
async function getGhlOrderState(transactionId) {
    const { rows } = await pool.query(
        'SELECT status, is_test FROM digital_solutions_transactions WHERE type = $1 AND transaction_id = $2',
        ['ghl_order', String(transactionId)]
    );
    return rows[0] ? { status: rows[0].status, isTest: Boolean(rows[0].is_test) } : null;
}

/**
 * Inserts or updates the row for one GHL order, keyed by transaction_id ('ghl:<orderId>').
 * created_at is the GHL order's own createdAt and is never changed by an update. Returns
 * { action: 'created' | 'updated' }.
 */
async function upsertGhlOrder(entry) {
    const id = `DST${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const { rows } = await pool.query(
        `INSERT INTO digital_solutions_transactions
            (id, type, transaction_id, customer_email, customer_name, product_name, amount, currency, promo_code, source, status,
             created_at, is_test, ghl_location_id, ghl_product_ids, ghl_payment_status, raw)
         VALUES ($1,'ghl_order',$2,$3,$4,$5,$6,$7,$8,'ghl',$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (transaction_id) DO UPDATE SET
            customer_email = EXCLUDED.customer_email, customer_name = EXCLUDED.customer_name,
            product_name = EXCLUDED.product_name, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
            promo_code = EXCLUDED.promo_code, status = EXCLUDED.status, is_test = EXCLUDED.is_test,
            ghl_location_id = EXCLUDED.ghl_location_id, ghl_product_ids = EXCLUDED.ghl_product_ids,
            ghl_payment_status = EXCLUDED.ghl_payment_status, raw = EXCLUDED.raw, updated_at = now()
         WHERE digital_solutions_transactions.type = 'ghl_order'
         RETURNING (xmax = 0) AS inserted`,
        [
            id, `ghl:${entry.orderId}`,
            entry.customerEmail ? String(entry.customerEmail).toLowerCase() : null,
            entry.customerName || null,
            entry.productName || null,
            entry.amount != null ? Number(entry.amount) : null,
            entry.currency ? String(entry.currency).toUpperCase() : 'USD',
            entry.promoCode ? String(entry.promoCode).toUpperCase() : null,
            entry.status,
            entry.createdAt || new Date().toISOString(),
            Boolean(entry.isTest),
            entry.ghlLocationId || null,
            entry.ghlProductIds || [],
            entry.ghlPaymentStatus || null,
            entry.raw ? JSON.stringify(entry.raw) : null
        ]
    );
    return { action: rows[0]?.inserted ? 'created' : 'updated' };
}

module.exports = {
    recordTransaction,
    updateTransactionStatus,
    listTransactions,
    findByTransactionId,
    findByPaymongoPaymentIntentId,
    getGhlOrderState,
    upsertGhlOrder
};
