const pool = require('../db/pool');

function toSlugId(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
}

function normalizeProductInput(product) {
    if (!product || typeof product !== 'object') {
        throw new Error('Invalid product payload');
    }

    const id = toSlugId(product.id || product.name);
    const name = String(product.name || '').trim();
    const amountPhp = Number(product.amountPhp);
    const currency = String(product.currency || 'PHP').toUpperCase();
    const defaults = product.defaults && typeof product.defaults === 'object' ? product.defaults : {};
    const successUrl = defaults.successUrl != null ? String(defaults.successUrl).trim() : '';
    const cancelUrl = defaults.cancelUrl != null ? String(defaults.cancelUrl).trim() : '';

    const billing = product.billing && typeof product.billing === 'object' ? product.billing : {};
    const billingTypeRaw = billing.type != null ? String(billing.type).trim().toLowerCase() : '';
    const billingType = billingTypeRaw || 'one_time';
    if (!['one_time', 'recurring'].includes(billingType)) {
        throw new Error('billing.type must be "one_time" or "recurring"');
    }

    const intervalRaw = billing.interval != null ? String(billing.interval).trim().toLowerCase() : '';
    const interval = intervalRaw || 'monthly';
    if (billingType === 'recurring' && interval !== 'monthly') {
        throw new Error('billing.interval must be "monthly" for recurring products');
    }

    if (!id) throw new Error('Product id is required');
    if (!name) throw new Error('Product name is required');
    if (!Number.isFinite(amountPhp) || amountPhp <= 0) throw new Error('amountPhp must be a positive number');
    if (currency !== 'PHP') throw new Error('Only PHP currency is supported');

    if (successUrl && !/^https?:\/\//i.test(successUrl)) {
        throw new Error('defaults.successUrl must start with http:// or https://');
    }
    if (cancelUrl && !/^https?:\/\//i.test(cancelUrl)) {
        throw new Error('defaults.cancelUrl must start with http:// or https://');
    }

    const taxRate = defaults.taxRate != null ? Number(defaults.taxRate) : null;
    if (taxRate != null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1)) {
        throw new Error('defaults.taxRate must be a number between 0 and 1');
    }

    return {
        id,
        name,
        amountPhp,
        currency,
        billingType,
        billingInterval: billingType === 'recurring' ? interval : null,
        paymentMethod: defaults.paymentMethod ? String(defaults.paymentMethod) : 'all',
        source: defaults.source ? String(defaults.source) : id,
        taxRate,
        displaySuffix: defaults.displaySuffix ? String(defaults.displaySuffix) : '',
        successUrl: successUrl || null,
        cancelUrl: cancelUrl || null
    };
}

function rowToProduct(row) {
    return {
        id: row.id,
        name: row.name,
        amountPhp: Number(row.amount_php),
        currency: row.currency,
        billing: {
            type: row.billing_type,
            interval: row.billing_type === 'recurring' ? row.billing_interval : undefined
        },
        defaults: {
            paymentMethod: row.default_payment_method || 'all',
            source: row.default_source || row.id,
            taxRate: row.default_tax_rate != null ? Number(row.default_tax_rate) : undefined,
            displaySuffix: row.display_suffix || '',
            successUrl: row.success_url || undefined,
            cancelUrl: row.cancel_url || undefined
        }
    };
}

async function listProducts() {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY name ASC');
    return rows.map(rowToProduct);
}

async function findProduct({ productId, productName }) {
    if (productId) {
        const id = toSlugId(productId);
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
        return rows[0] ? rowToProduct(rows[0]) : null;
    }
    if (productName) {
        const { rows } = await pool.query('SELECT * FROM products WHERE name = $1', [String(productName).trim()]);
        return rows[0] ? rowToProduct(rows[0]) : null;
    }
    return null;
}

async function upsertProduct(payload) {
    const p = normalizeProductInput(payload);

    await pool.query(
        `INSERT INTO products (id, name, amount_php, currency, billing_type, billing_interval, default_payment_method, default_source, default_tax_rate, display_suffix, success_url, cancel_url, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            amount_php = EXCLUDED.amount_php,
            currency = EXCLUDED.currency,
            billing_type = EXCLUDED.billing_type,
            billing_interval = EXCLUDED.billing_interval,
            default_payment_method = EXCLUDED.default_payment_method,
            default_source = EXCLUDED.default_source,
            default_tax_rate = EXCLUDED.default_tax_rate,
            display_suffix = EXCLUDED.display_suffix,
            success_url = EXCLUDED.success_url,
            cancel_url = EXCLUDED.cancel_url,
            updated_at = now()`,
        [
            p.id, p.name, p.amountPhp, p.currency, p.billingType, p.billingInterval,
            p.paymentMethod, p.source, p.taxRate, p.displaySuffix, p.successUrl, p.cancelUrl
        ]
    );

    return findProduct({ productId: p.id });
}

async function deleteProduct(productId) {
    const id = toSlugId(productId);
    const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
    return rowCount > 0;
}

function buildHtmlSnippet(product, { backendUrl = 'https://api.nexistrydigitalsolutions.com' } = {}) {
    const taxRate = product.defaults.taxRate != null ? product.defaults.taxRate : 0.10;
    const paymentMethod = product.defaults.paymentMethod || 'all';
    const source = product.defaults.source || product.id;
    const suffix = product.defaults.displaySuffix || '';
    const successUrl = product.defaults.successUrl || '';
    const cancelUrl = product.defaults.cancelUrl || '';

    return `<!-- Nexistry PayMongo Product Snippet: ${product.name} -->
<script>
  // Backend
  const BACKEND_URL = '${backendUrl}';

  // Product config (generated)
  const PRODUCT_ID = '${product.id}';
  const PRODUCT_NAME = '${product.name.replace(/'/g, "\\'")}';
  const BASE_AMOUNT = ${Number(product.amountPhp)};
  const TAX_RATE = ${Number(taxRate)};
  const PAYMENT_METHOD = '${paymentMethod}';
  const SOURCE = '${source.replace(/'/g, "\\'")}';
  const DISPLAY_SUFFIX = '${suffix.replace(/'/g, "\\'")}';
  const SUCCESS_URL = '${successUrl.replace(/'/g, "\\'")}';
  const CANCEL_URL = '${cancelUrl.replace(/'/g, "\\'")}';

  // Example totals (optional display)
  const TAX_AMOUNT = BASE_AMOUNT * TAX_RATE;
  const SUBTOTAL_WITH_TAX = BASE_AMOUNT + TAX_AMOUNT;

  // Call this when your form submits
  async function createPaymentIntent({ fullName, email, mobile, notes, amountOverride, discountAmount, promoCode, referredBy, description }) {
    const amountToCharge = (typeof amountOverride === 'number' && amountOverride > 0) ? amountOverride : SUBTOTAL_WITH_TAX;

    const res = await fetch(\`\${BACKEND_URL}/api/payments/create-payment-intent\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName,
        email,
        mobile,
        notes: notes || '',
        productId: PRODUCT_ID,
        product: PRODUCT_NAME,
        paymentMethod: PAYMENT_METHOD,
        source: SOURCE,
        ...(SUCCESS_URL ? { successUrl: SUCCESS_URL } : {}),
        ...(CANCEL_URL ? { cancelUrl: CANCEL_URL } : {}),
        amount: amountToCharge,
        baseAmount: BASE_AMOUNT,
        taxAmount: TAX_AMOUNT,
        discountAmount: discountAmount || 0,
        promoCode: promoCode || '',
        referredBy: referredBy || '',
        description: description || \`\${PRODUCT_NAME} - Base: ₱\${BASE_AMOUNT} + Tax (\${(TAX_RATE * 100).toFixed(0)}%): ₱\${TAX_AMOUNT.toFixed(2)} = ₱\${amountToCharge.toFixed(2)}\${DISPLAY_SUFFIX}\`
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to create payment');
    if (!data?.checkoutUrl) throw new Error('No checkoutUrl returned');
    return data;
  }
</script>`;
}

module.exports = {
    toSlugId,
    listProducts,
    findProduct,
    upsertProduct,
    deleteProduct,
    buildHtmlSnippet
};
