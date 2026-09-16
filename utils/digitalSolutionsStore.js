// utils/digitalSolutionsStore.js
//
// Local ledger of every "digital solution" transaction this backend processes -
// Nexistry Academy product purchases and Clockistry/Nexiflow subscription upgrades.
// Replaces the manual Google Sheets tracking described for the Nexiflow app and
// digital solution tracker: this backend forwards webhooks and forgets today, so
// nothing here previously persisted what was actually sold, to whom, or its status.
const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.DIGITAL_SOLUTIONS_STORE_PATH
    ? path.resolve(process.env.DIGITAL_SOLUTIONS_STORE_PATH)
    : path.join(__dirname, '..', 'data', 'digital_solutions.json');

function safeJsonParse(raw) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

function readStore() {
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        const parsed = safeJsonParse(raw);
        if (!parsed.ok) throw new Error(`Failed to parse JSON at ${STORE_PATH}: ${parsed.error.message}`);
        const transactions = Array.isArray(parsed.value?.transactions) ? parsed.value.transactions : [];
        return { version: Number(parsed.value?.version || 1), transactions };
    } catch (err) {
        if (err.code === 'ENOENT') return { version: 1, transactions: [] };
        throw err;
    }
}

function writeStore(store) {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, STORE_PATH);
}

/**
 * Records a new transaction at checkout-creation time (status: 'initiated').
 * `type` is 'academy_product' or 'clockistry_subscription'. `transactionId` is the
 * value used to find and update this record later (paymentReference for Academy,
 * internal_transaction_id for Clockistry).
 */
function recordTransaction(entry) {
    const store = readStore();

    const record = {
        id: `DST${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        type: entry.type,
        transactionId: String(entry.transactionId || ''),
        customerEmail: entry.customerEmail ? String(entry.customerEmail).toLowerCase() : '',
        customerName: entry.customerName ? String(entry.customerName) : '',
        companyId: entry.companyId ? String(entry.companyId) : undefined,
        userId: entry.userId ? String(entry.userId) : undefined,
        productId: entry.productId ? String(entry.productId) : undefined,
        productName: entry.productName ? String(entry.productName) : undefined,
        plan: entry.plan ? String(entry.plan) : undefined,
        userCount: entry.userCount != null ? Number(entry.userCount) : undefined,
        amount: entry.amount != null ? Number(entry.amount) : undefined,
        currency: entry.currency ? String(entry.currency).toUpperCase() : 'PHP',
        promoCode: entry.promoCode ? String(entry.promoCode) : undefined,
        source: entry.source ? String(entry.source) : undefined,
        status: entry.status || 'initiated',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    Object.keys(record).forEach((k) => record[k] === undefined && delete record[k]);

    store.transactions.push(record);
    writeStore({ version: store.version || 1, transactions: store.transactions });
    return record;
}

/**
 * Updates a transaction's status by transactionId (set at creation). Called when
 * the PayMongo webhook reports paid/failed. No-op (returns null) if the
 * transaction isn't found - e.g. it predates this tracker.
 */
function updateTransactionStatus(transactionId, status, extra = {}) {
    const id = String(transactionId || '');
    if (!id) return null;

    const store = readStore();
    const index = store.transactions.findIndex((t) => t.transactionId === id);
    if (index === -1) return null;

    const updated = {
        ...store.transactions[index],
        ...extra,
        status,
        updatedAt: new Date().toISOString()
    };
    store.transactions[index] = updated;
    writeStore({ version: store.version || 1, transactions: store.transactions });
    return updated;
}

function listTransactions({ type, status, companyId, email } = {}) {
    const { transactions } = readStore();
    const normalizedEmail = email ? String(email).toLowerCase() : null;

    return transactions
        .filter((t) => (type ? t.type === type : true))
        .filter((t) => (status ? t.status === status : true))
        .filter((t) => (companyId ? t.companyId === companyId : true))
        .filter((t) => (normalizedEmail ? t.customerEmail === normalizedEmail : true))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findByTransactionId(transactionId) {
    const { transactions } = readStore();
    return transactions.find((t) => t.transactionId === String(transactionId || '')) || null;
}

module.exports = {
    STORE_PATH,
    recordTransaction,
    updateTransactionStatus,
    listTransactions,
    findByTransactionId
};
