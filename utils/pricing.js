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

const round2 = (n) => Number(Number(n).toFixed(2));

/**
 * Computes (catalog price + setup fee) -> coupon percent discount -> tax. `discountPercent` is a
 * fraction (0.15 = 15%). The optional setup fee (product.setupFeePhp) is part of the FIRST
 * payment only: it is discounted and taxed like the price, but fullPriceAmount - the
 * undiscounted, taxed MONTHLY price that recurring renewals bill at - never includes it.
 * `lines` splits finalAmount (tax-inclusive) per line item; amounts sum exactly to finalAmount
 * (any rounding remainder lands on the product line).
 */
function computePricing({ product, source, discountPercent = 0 }) {
    const catalogAmount = product.amountPhp;
    const setupFee = Number(product.setupFeePhp) > 0 ? round2(product.setupFeePhp) : 0;
    const taxRate = resolveTaxRate({ product, source });

    const firstPaymentSubtotal = round2(catalogAmount + setupFee);
    const discountAmount = discountPercent
        ? round2(firstPaymentSubtotal * discountPercent)
        : 0;
    const discountedBase = round2(firstPaymentSubtotal - discountAmount);

    const taxed = calculateTaxedAmount(discountedBase, taxRate);
    const fullPriceTaxed = calculateTaxedAmount(catalogAmount, taxRate);
    const finalAmount = Number(taxed.totalAmount.toFixed(2));

    const lines = [{ key: 'product', label: product.name, amount: finalAmount }];
    let setupFeeAmount = 0;
    if (setupFee > 0) {
        const setupDiscount = discountPercent ? round2(setupFee * discountPercent) : 0;
        setupFeeAmount = round2(calculateTaxedAmount(round2(setupFee - setupDiscount), taxRate).totalAmount);
        lines[0].amount = round2(finalAmount - setupFeeAmount);
        lines.push({ key: 'setup_fee', label: 'Setup fee', amount: setupFeeAmount });
    }

    return {
        catalogAmount,
        setupFee,
        setupFeeAmount,
        lines,
        taxRate,
        discountAmount,
        baseAmount: Number(taxed.baseAmount.toFixed(2)),
        taxAmount: Number(taxed.taxAmount.toFixed(2)),
        finalAmount,
        fullPriceAmount: Number(fullPriceTaxed.totalAmount.toFixed(2))
    };
}

module.exports = { resolveTaxRate, computePricing };
