const fs = require('fs');
const path = require('path');

const CATALOG_PATH = process.env.PRODUCT_CATALOG_PATH
    ? path.resolve(process.env.PRODUCT_CATALOG_PATH)
    : path.join(__dirname, '..', 'data', 'products.json');

function safeJsonParse(raw) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

function toSlugId(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
}

function normalizeProduct(product) {
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

    const taxRate = defaults.taxRate != null ? Number(defaults.taxRate) : undefined;
    if (taxRate != null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1)) {
        throw new Error('defaults.taxRate must be a number between 0 and 1');
    }

    return {
        id,
        name,
        amountPhp,
        currency,
        defaults: {
            paymentMethod: defaults.paymentMethod ? String(defaults.paymentMethod) : 'all',
            source: defaults.source ? String(defaults.source) : id,
            taxRate: taxRate != null ? taxRate : undefined,
            displaySuffix: defaults.displaySuffix ? String(defaults.displaySuffix) : '',
            successUrl: successUrl || undefined,
            cancelUrl: cancelUrl || undefined
        }
    };
}

function readCatalog() {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) {
        throw new Error(`Failed to parse product catalog JSON at ${CATALOG_PATH}: ${parsed.error.message}`);
    }

    const catalog = parsed.value;
    const products = Array.isArray(catalog?.products) ? catalog.products : [];

    return {
        version: Number(catalog?.version || 1),
        products
    };
}

function writeCatalog(catalog) {
    const dir = path.dirname(CATALOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${CATALOG_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, CATALOG_PATH);
}

function listProducts() {
    const catalog = readCatalog();
    const normalized = catalog.products.map(normalizeProduct);
    normalized.sort((a, b) => a.name.localeCompare(b.name));
    return normalized;
}

function findProduct({ productId, productName }) {
    const products = listProducts();
    if (productId) {
        const id = toSlugId(productId);
        return products.find(p => p.id === id) || null;
    }
    if (productName) {
        const name = String(productName).trim();
        return products.find(p => p.name === name) || null;
    }
    return null;
}

function upsertProduct(payload) {
    const incoming = normalizeProduct(payload);
    const catalog = readCatalog();

    const existingIndex = Array.isArray(catalog.products)
        ? catalog.products.findIndex(p => toSlugId(p.id) === incoming.id)
        : -1;

    const nextProducts = Array.isArray(catalog.products) ? [...catalog.products] : [];
    if (existingIndex >= 0) {
        nextProducts[existingIndex] = incoming;
    } else {
        nextProducts.push(incoming);
    }

    writeCatalog({ version: catalog.version || 1, products: nextProducts });
    return incoming;
}

function deleteProduct(productId) {
    const id = toSlugId(productId);
    const catalog = readCatalog();
    const nextProducts = (Array.isArray(catalog.products) ? catalog.products : []).filter(p => toSlugId(p.id) !== id);
    if (nextProducts.length === (catalog.products || []).length) return false;
    writeCatalog({ version: catalog.version || 1, products: nextProducts });
    return true;
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
    CATALOG_PATH,
    toSlugId,
    listProducts,
    findProduct,
    upsertProduct,
    deleteProduct,
    buildHtmlSnippet
};
