// utils/pricing.js
// Single source of truth for checkout pricing. Used by BOTH createPaymentIntent and the
// public embed quote endpoint so the quoted total can never differ from the charged one.
const { calculateTaxedAmount } = require('./helpers');

const WEBSITE_PRODUCTS = [
    'promo_website_fee_one_time',
    'promo_website_monthly',
    'promo_website_with_domain'
];

/**
 * Precedence: (1) the legacy nexistry_core_ph source override stays on top; (2) otherwise a
 * product's own tax rate (default_tax_rate, including 0) wins; (3) otherwise the legacy
 * fallback (website products -> core rate, everything else -> TAX_RATE).
 */
function resolveTaxRate({ product, source }) {
    const defaultTaxRate = Number(process.env.TAX_RATE ?? 0.10);
    const coreTaxRate = Number(process.env.NX_CORE_TAX_RATE ?? 0.12);

    if (source === 'nexistry_core_ph') return coreTaxRate;

    const productRate = product?.defaults?.taxRate;
    if (typeof productRate === 'number' && Number.isFinite(productRate)) return productRate;

    return WEBSITE_PRODUCTS.includes(String(product?.id || '')) ? coreTaxRate : defaultTaxRate;
}

/**
 * Computes catalog price -> coupon percent discount -> tax. `discountPercent` is a
 * fraction (0.15 = 15%). fullPriceAmount is the undiscounted, taxed price that
 * recurring renewals bill at.
 */
function computePricing({ product, source, discountPercent = 0 }) {
    const catalogAmount = product.amountPhp;
    const taxRate = resolveTaxRate({ product, source });

    const discountAmount = discountPercent
        ? Number((catalogAmount * discountPercent).toFixed(2))
        : 0;
    const discountedBase = Number((catalogAmount - discountAmount).toFixed(2));

    const taxed = calculateTaxedAmount(discountedBase, taxRate);
    const fullPriceTaxed = calculateTaxedAmount(catalogAmount, taxRate);

    return {
        catalogAmount,
        taxRate,
        discountAmount,
        baseAmount: Number(taxed.baseAmount.toFixed(2)),
        taxAmount: Number(taxed.taxAmount.toFixed(2)),
        finalAmount: Number(taxed.totalAmount.toFixed(2)),
        fullPriceAmount: Number(fullPriceTaxed.totalAmount.toFixed(2))
    };
}

module.exports = { resolveTaxRate, computePricing };
