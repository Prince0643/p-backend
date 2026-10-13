const pool = require('../db/pool');
const { generateId } = require('./helpers');

function slug(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
}

function cleanList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))];
}

function normalizeCustomFields(value) {
    if (value == null || value === '') return [];
    if (!Array.isArray(value)) throw new Error('customFields must be an array');
    return value.map((field) => {
        if (!field || typeof field !== 'object') throw new Error('Each custom field must be an object');
        const id = field.id != null ? String(field.id).trim() : '';
        const key = field.key != null ? String(field.key).trim() : '';
        const fieldValue = field.fieldValue != null ? String(field.fieldValue) : '';
        if (!id && !key) throw new Error('Each custom field needs an id or key');
        return { ...(id ? { id } : {}), ...(key ? { key } : {}), fieldValue };
    });
}

function normalizeSubAccount(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid GHL sub-account payload');
    const name = String(input.name || '').trim();
    const locationId = String(input.locationId || input.location_id || '').trim();
    const privateKey = String(input.privateKey || input.private_key || '').trim();
    const id = slug(input.id || name || locationId);
    if (!id) throw new Error('Sub-account id is required');
    if (!name) throw new Error('Sub-account name is required');
    if (!locationId) throw new Error('GHL location id is required');
    if (!privateKey) throw new Error('GHL private key is required');
    return {
        id,
        name,
        locationId,
        privateKey,
        businessName: input.businessName != null ? String(input.businessName).trim() || null : null,
        active: input.active !== undefined ? Boolean(input.active) : true
    };
}

function rowToSubAccount(row, { includeSecret = false } = {}) {
    return {
        id: row.id,
        name: row.name,
        locationId: row.location_id,
        businessName: row.business_name || '',
        active: row.active,
        hasPrivateKey: Boolean(row.private_key),
        ...(includeSecret ? { privateKey: row.private_key } : {}),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    };
}

function rowToRule(row) {
    return {
        productId: row.product_id,
        subAccountId: row.sub_account_id,
        enabled: row.enabled,
        firstPaymentTags: row.first_payment_tags || [],
        renewalTags: row.renewal_tags || [],
        everyPaymentTags: row.every_payment_tags || [],
        removeTags: row.remove_tags || [],
        customFields: row.custom_fields || [],
        subAccount: row.sub_account_name ? {
            id: row.sub_account_id,
            name: row.sub_account_name,
            locationId: row.location_id,
            businessName: row.business_name || '',
            active: row.sub_account_active
        } : undefined,
        productName: row.product_name || undefined
    };
}

async function listSubAccounts({ includeSecret = false } = {}) {
    const { rows } = await pool.query('SELECT * FROM ghl_sub_accounts ORDER BY name ASC');
    return rows.map((r) => rowToSubAccount(r, { includeSecret }));
}

async function getSubAccount(id, { includeSecret = false } = {}) {
    const { rows } = await pool.query('SELECT * FROM ghl_sub_accounts WHERE id = $1', [String(id)]);
    return rows[0] ? rowToSubAccount(rows[0], { includeSecret }) : null;
}

async function upsertSubAccount(input) {
    const a = normalizeSubAccount(input);
    const { rows } = await pool.query(
        `INSERT INTO ghl_sub_accounts (id, name, location_id, private_key, business_name, active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            location_id = EXCLUDED.location_id,
            private_key = EXCLUDED.private_key,
            business_name = EXCLUDED.business_name,
            active = EXCLUDED.active,
            updated_at = now()
         RETURNING *`,
        [a.id, a.name, a.locationId, a.privateKey, a.businessName, a.active]
    );
    return rowToSubAccount(rows[0]);
}

async function deleteSubAccount(id) {
    const { rowCount } = await pool.query('DELETE FROM ghl_sub_accounts WHERE id = $1', [String(id)]);
    return rowCount > 0;
}

async function listRules({ productId } = {}) {
    const params = [];
    const where = productId ? 'WHERE r.product_id = $1' : '';
    if (productId) params.push(String(productId));
    const { rows } = await pool.query(
        `SELECT r.*, p.name AS product_name, a.name AS sub_account_name, a.location_id, a.business_name,
                a.active AS sub_account_active
         FROM product_fulfillment_rules r
         JOIN products p ON p.id = r.product_id
         JOIN ghl_sub_accounts a ON a.id = r.sub_account_id
         ${where}
         ORDER BY p.name ASC, a.name ASC`,
        params
    );
    return rows.map(rowToRule);
}

async function listEnabledRulesForProduct(productId) {
    const { rows } = await pool.query(
        `SELECT r.*, p.name AS product_name, a.name AS sub_account_name, a.location_id, a.private_key,
                a.business_name, a.active AS sub_account_active
         FROM product_fulfillment_rules r
         JOIN products p ON p.id = r.product_id
         JOIN ghl_sub_accounts a ON a.id = r.sub_account_id
         WHERE r.product_id = $1 AND r.enabled = true AND a.active = true
         ORDER BY a.name ASC`,
        [String(productId)]
    );
    return rows.map((row) => ({
        ...rowToRule(row),
        subAccount: {
            id: row.sub_account_id,
            name: row.sub_account_name,
            locationId: row.location_id,
            privateKey: row.private_key,
            businessName: row.business_name || '',
            active: row.sub_account_active
        }
    }));
}

async function upsertRule(input) {
    const productId = String(input.productId || input.product_id || '').trim();
    const subAccountId = String(input.subAccountId || input.sub_account_id || '').trim();
    if (!productId) throw new Error('productId is required');
    if (!subAccountId) throw new Error('subAccountId is required');
    const customFields = normalizeCustomFields(input.customFields ?? input.custom_fields);
    const { rows } = await pool.query(
        `INSERT INTO product_fulfillment_rules
            (product_id, sub_account_id, enabled, first_payment_tags, renewal_tags, every_payment_tags, remove_tags, custom_fields, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, now())
         ON CONFLICT (product_id, sub_account_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            first_payment_tags = EXCLUDED.first_payment_tags,
            renewal_tags = EXCLUDED.renewal_tags,
            every_payment_tags = EXCLUDED.every_payment_tags,
            remove_tags = EXCLUDED.remove_tags,
            custom_fields = EXCLUDED.custom_fields,
            updated_at = now()
         RETURNING *`,
        [
            productId,
            subAccountId,
            input.enabled !== undefined ? Boolean(input.enabled) : true,
            cleanList(input.firstPaymentTags ?? input.first_payment_tags),
            cleanList(input.renewalTags ?? input.renewal_tags),
            cleanList(input.everyPaymentTags ?? input.every_payment_tags),
            cleanList(input.removeTags ?? input.remove_tags),
            JSON.stringify(customFields)
        ]
    );
    const withJoins = await listRules({ productId });
    return withJoins.find((r) => r.subAccountId === rows[0].sub_account_id) || rowToRule(rows[0]);
}

async function deleteRule({ productId, subAccountId }) {
    const { rowCount } = await pool.query(
        'DELETE FROM product_fulfillment_rules WHERE product_id = $1 AND sub_account_id = $2',
        [String(productId), String(subAccountId)]
    );
    return rowCount > 0;
}

async function hasPriorSuccessfulEvent({ productId, subAccountId, email, paymentReference }) {
    const { rows } = await pool.query(
        `SELECT 1 FROM product_fulfillment_events
         WHERE product_id = $1 AND sub_account_id = $2 AND lower(customer_email) = lower($3)
           AND status = 'succeeded' AND payment_reference <> $4
         LIMIT 1`,
        [String(productId), String(subAccountId), String(email || ''), String(paymentReference || '')]
    );
    return rows.length > 0;
}

async function recordEvent({ productId, subAccountId, paymentReference, email, cycleType, contactId, status = 'succeeded', error }) {
    const id = generateId('FUL');
    const { rows } = await pool.query(
        `INSERT INTO product_fulfillment_events
            (id, product_id, sub_account_id, payment_reference, customer_email, cycle_type, contact_id, status, error)
         VALUES ($1,$2,$3,$4,lower($5),$6,$7,$8,$9)
         ON CONFLICT (payment_reference, product_id, sub_account_id) DO UPDATE SET
            contact_id = COALESCE(EXCLUDED.contact_id, product_fulfillment_events.contact_id),
            status = EXCLUDED.status,
            error = EXCLUDED.error
         RETURNING *`,
        [id, productId, subAccountId, paymentReference, email, cycleType, contactId || null, status, error || null]
    );
    return rows[0];
}

module.exports = {
    cleanList,
    normalizeCustomFields,
    listSubAccounts,
    getSubAccount,
    upsertSubAccount,
    deleteSubAccount,
    listRules,
    listEnabledRulesForProduct,
    upsertRule,
    deleteRule,
    hasPriorSuccessfulEvent,
    recordEvent
};
