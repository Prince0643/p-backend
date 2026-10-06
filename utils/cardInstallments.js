// utils/cardInstallments.js
// Pure helpers deciding whether a PayMongo Checkout Session should offer card installments
// (0% 3/6/12-month "Pay Later" plans). Env-gated and opt-in; the caller must retry without
// the returned options if PayMongo rejects them, so checkout never fails over installments.

const DEFAULT_MIN_AMOUNT_PHP = 3000;

function isInstallmentsEnabled(env = process.env) {
    return String(env.PAYMONGO_CARD_INSTALLMENTS_ENABLED || '').trim().toLowerCase() === 'true';
}

function getInstallmentsMinAmountPhp(env = process.env) {
    const n = Number(env.PAYMONGO_INSTALLMENTS_MIN_AMOUNT);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_AMOUNT_PHP;
}

// `amountPhp` is in pesos (not centavos). Returns the `payment_method_options` object to merge
// into the checkout session attributes, or null when installments should not be offered.
function getCardInstallmentOptions({ paymentMethodTypes, amountPhp, currency, env = process.env } = {}) {
    if (!isInstallmentsEnabled(env)) return null;
    if (!Array.isArray(paymentMethodTypes) || !paymentMethodTypes.includes('card')) return null;
    if (String(currency || '').toUpperCase() !== 'PHP') return null;
    if (!(Number(amountPhp) >= getInstallmentsMinAmountPhp(env))) return null;
    return { card: { installments: { enabled: true } } };
}

module.exports = {
    DEFAULT_MIN_AMOUNT_PHP,
    isInstallmentsEnabled,
    getInstallmentsMinAmountPhp,
    getCardInstallmentOptions
};
