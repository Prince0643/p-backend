// utils/digitalSolutionsStore.js
//
// Relational ledger of every "digital solution" transaction this backend processes -
// Nexistry Academy product purchases and Clockistry/Nexiflow subscription upgrades.
const pool = require('../db/pool');

function rowToTransaction(row) {
    return {
        id: row.id,
        type: row.type,
        transactionId: row.transaction_id,
        customerEmail: row.customer_email || '',
        customerName: row.customer_name || '',
        companyId: row.company_id || undefined,
        userId: row.user_id || undefined,
        productId: row.product_id || undefined,
        productName: row.product_name || undefined,
        plan: row.plan || undefined,
        userCount: row.user_count != null ? Number(row.user_count) : undefined,
        amount: row.amount != null ? Number(row.amount) : undefined,
        currency: row.currency,
        promoCode: row.promo_code || undefined,
        source: row.source || undefined,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
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
            (id, type, transaction_id, customer_email, customer_name, company_id, user_id, product_id, product_name, plan, user_count, amount, currency, promo_code, source, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
            entry.status || 'initiated'
        ]
    );
    return rowToTransaction(rows[0]);
}

/**
 * Updates a transaction's status by transactionId (set at creation). Called when
 * the PayMongo webhook reports paid/failed. No-op (returns null) if the
 * transaction isn't found - e.g. it predates this tracker.
 */
async function updateTransactionStatus(transactionId, status) {
    const id = String(transactionId || '');
    if (!id) return null;

    const { rows } = await pool.query(
        `UPDATE digital_solutions_transactions SET status = $2, updated_at = now() WHERE transaction_id = $1 RETURNING *`,
        [id, status]
    );
    return rows[0] ? rowToTransaction(rows[0]) : null;
}

async function listTransactions({ type, status, companyId, email } = {}) {
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (companyId) { params.push(companyId); conditions.push(`company_id = $${params.length}`); }
    if (email) { params.push(String(email).toLowerCase()); conditions.push(`customer_email = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM digital_solutions_transactions ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToTransaction);
}

async function findByTransactionId(transactionId) {
    const { rows } = await pool.query('SELECT * FROM digital_solutions_transactions WHERE transaction_id = $1', [String(transactionId || '')]);
    return rows[0] ? rowToTransaction(rows[0]) : null;
}

module.exports = {
    recordTransaction,
    updateTransactionStatus,
    listTransactions,
    findByTransactionId
};
