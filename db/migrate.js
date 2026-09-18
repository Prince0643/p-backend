// db/migrate.js
// Applies db/schema.sql (idempotent) then imports any existing data/*.json content
// into Postgres (idempotent - ON CONFLICT DO NOTHING, safe to re-run).
// Usage: node db/migrate.js
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const pool = require('./pool');

function readJsonSafe(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

async function applySchema(client) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Schema applied.');
}

async function importProducts(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'products.json'), { products: [] });
    let count = 0;
    for (const p of data.products || []) {
        await client.query(
            `INSERT INTO products (id, name, amount_php, currency, billing_type, billing_interval, default_payment_method, default_source, default_tax_rate, display_suffix, success_url, cancel_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO NOTHING`,
            [
                p.id, p.name, p.amountPhp, p.currency || 'PHP',
                p.billing?.type || 'one_time', p.billing?.interval || null,
                p.defaults?.paymentMethod || null, p.defaults?.source || null,
                p.defaults?.taxRate ?? null, p.defaults?.displaySuffix || null,
                p.defaults?.successUrl || null, p.defaults?.cancelUrl || null
            ]
        );
        count++;
    }
    console.log(`Products imported: ${count}`);
}

async function importCoupons(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'coupons.json'), { coupons: [] });
    let count = 0;
    for (const c of data.coupons || []) {
        await client.query(
            `INSERT INTO coupons (code, discount_percent, affiliate_fee_percent, affiliate_email, active, expires_at, max_redemptions, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (code) DO NOTHING`,
            [
                c.code, c.discountPercent, c.affiliateFeePercent || 0, c.affiliateEmail || null,
                c.active !== false, c.expiresAt || null, c.maxRedemptions || null, c.notes || null
            ]
        );
        for (const productId of c.productIds || []) {
            await client.query(
                `INSERT INTO coupon_products (coupon_code, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                [c.code, productId]
            );
        }
        count++;
    }
    console.log(`Coupons imported: ${count}`);
}

async function importCouponRedemptions(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'coupon_redemptions.json'), { redemptions: [] });
    let count = 0;
    for (const r of data.redemptions || []) {
        await client.query(
            `INSERT INTO coupon_redemptions (id, code, payment_reference, product_id, email, full_name, base_amount, discount_amount, affiliate_fee_amount, affiliate_email, currency, status, created_at, paid_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (id) DO NOTHING`,
            [
                r.id, r.code, r.paymentReference, r.productId || null, r.email || null, r.fullName || null,
                r.baseAmount || 0, r.discountAmount || 0, r.affiliateFeeAmount || 0, r.affiliateEmail || null,
                r.currency || 'PHP', r.status || 'pending', r.createdAt || new Date().toISOString(), r.paidAt || null
            ]
        );
        count++;
    }
    console.log(`Coupon redemptions imported: ${count}`);
}

async function importAffiliates(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'affiliates.json'), { affiliates: [] });
    let count = 0;
    for (const a of data.affiliates || []) {
        await client.query(
            `INSERT INTO affiliates (id, first_name, last_name, email, contact_number, socials, payment_region, preferred_bank, payout_details, terms_accepted, terms_version, coupon_code, status, status_updated_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (id) DO NOTHING`,
            [
                a.id, a.firstName, a.lastName, a.email, a.contactNumber,
                JSON.stringify(a.socials || {}), a.paymentRegion, a.preferredBank,
                JSON.stringify(a.payoutDetails || {}), a.termsAccepted !== false, a.termsVersion || null,
                a.couponCode || null, a.status || 'active', a.statusUpdatedAt || null, a.createdAt || new Date().toISOString()
            ]
        );
        count++;
    }
    console.log(`Affiliates imported: ${count}`);
}

async function importDigitalSolutions(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'digital_solutions.json'), { transactions: [] });
    let count = 0;
    for (const t of data.transactions || []) {
        await client.query(
            `INSERT INTO digital_solutions_transactions (id, type, transaction_id, customer_email, customer_name, company_id, user_id, product_id, product_name, plan, user_count, amount, currency, promo_code, source, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (id) DO NOTHING`,
            [
                t.id, t.type, t.transactionId, t.customerEmail || null, t.customerName || null,
                t.companyId || null, t.userId || null, t.productId || null, t.productName || null,
                t.plan || null, t.userCount || null, t.amount || null, t.currency || 'PHP',
                t.promoCode || null, t.source || null, t.status || 'initiated',
                t.createdAt || new Date().toISOString(), t.updatedAt || new Date().toISOString()
            ]
        );
        count++;
    }
    console.log(`Digital solutions transactions imported: ${count}`);
}

async function importGhlInvoiceSchedules(client) {
    const data = readJsonSafe(path.join(__dirname, '..', 'data', 'ghl_invoice_schedules.json'), { schedules: {} });
    let count = 0;
    for (const [key, scheduleId] of Object.entries(data.schedules || {})) {
        const [locationId, contactId, productId] = key.split(':');
        if (!locationId || !contactId || !productId) continue;
        await client.query(
            `INSERT INTO ghl_invoice_schedules (location_id, contact_id, product_id, schedule_id)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (location_id, contact_id, product_id) DO NOTHING`,
            [locationId, contactId, productId, scheduleId]
        );
        count++;
    }
    console.log(`GHL invoice schedules imported: ${count}`);
}

async function main() {
    const client = await pool.connect();
    try {
        await applySchema(client);
        // Order matters: products/coupons before rows that reference them via FK.
        await importProducts(client);
        await importCoupons(client);
        await importCouponRedemptions(client);
        await importAffiliates(client);
        await importDigitalSolutions(client);
        await importGhlInvoiceSchedules(client);
        console.log('Migration complete.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
