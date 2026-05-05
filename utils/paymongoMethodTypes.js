// utils/paymongoMethodTypes.js

const DEFAULT_ALL_METHOD_TYPES = [
    'qrph',
    'gcash',
    'grab_pay',
    'paymaya',
    'shopee_pay',
    'dob',
    'dob_ubp',
    'card'
];

const METHOD_MAP = {
    // Frontend-friendly aliases
    gcash: 'gcash',
    grabpay: 'grab_pay',
    maya: 'paymaya',
    shopeepay: 'shopee_pay',
    bpi: 'dob',
    unionbank: 'dob_ubp',

    // Direct PayMongo identifiers
    grab_pay: 'grab_pay',
    paymaya: 'paymaya',
    shopee_pay: 'shopee_pay',
    dob: 'dob',
    dob_ubp: 'dob_ubp',
    qrph: 'qrph',
    card: 'card',

    // Common typos / variants
    grab_payments: 'grab_pay'
};

/**
 * Returns the PayMongo Checkout Session `payment_method_types` list.
 *
 * Semantics (matches paymentController behavior):
 * - If paymentMethod is missing, "qrph", or "all": return all supported methods.
 * - Otherwise: return only the mapped PayMongo method type.
 * - Optionally filter by merchant capabilities when enabled.
 */
async function getCheckoutMethodTypes({
    paymentMethod,
    paymongoService,
    enableCapabilityFilter = false,
    fallback = ['qrph'],
    allSupported = DEFAULT_ALL_METHOD_TYPES
} = {}) {
    const selected = String(paymentMethod || 'qrph').trim().toLowerCase();
    const normalized = METHOD_MAP[selected] || 'qrph';

    let methodTypes = (selected === 'qrph' || selected === 'all')
        ? [...allSupported]
        : [normalized];

    if (enableCapabilityFilter) {
        if (!paymongoService || typeof paymongoService.getMerchantPaymentMethodCapabilities !== 'function') {
            throw new Error('paymongoService with getMerchantPaymentMethodCapabilities is required when enableCapabilityFilter=true');
        }

        try {
            const capabilities = await paymongoService.getMerchantPaymentMethodCapabilities();
            const allowed = new Set(
                (capabilities || [])
                    .map((pm) => {
                        if (typeof pm === 'string') return pm;
                        return pm?.attributes?.type;
                    })
                    .filter(Boolean)
            );

            const filtered = methodTypes.filter(m => allowed.has(m));
            if (filtered.length > 0) {
                methodTypes = filtered;
            } else {
                methodTypes = [...fallback];
            }

            // Optional experiment: include Brankas-specific capability identifiers in Checkout Session
            // `payment_method_types` (may be rejected by PayMongo Checkout; service has a retry fallback).
            const enableBrankasCheckoutTypes = String(process.env.PAYMONGO_CHECKOUT_ENABLE_BRANKAS_TYPES || '').toLowerCase() === 'true';
            if (enableBrankasCheckoutTypes && (selected === 'qrph' || selected === 'all')) {
                const brankasTypes = Array.from(allowed).filter((t) => String(t).startsWith('brankas_'));
                if (brankasTypes.length > 0) {
                    methodTypes = Array.from(new Set([...methodTypes, ...brankasTypes]));
                }
            }
        } catch (capErr) {
            // Non-fatal: proceed without filtering.
            console.log('Non-fatal: unable to fetch PayMongo capabilities, proceeding without filtering:', capErr.message);
        }
    }

    return methodTypes;
}

module.exports = {
    DEFAULT_ALL_METHOD_TYPES,
    getCheckoutMethodTypes
};
