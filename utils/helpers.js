// utils/helpers.js
const crypto = require('crypto');

// Generate unique ID
function generateId(prefix = '') {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}${timestamp}${random}`.toUpperCase();
}

// Validate email
function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Validate mobile number (International format - E.164)
function validateMobile(mobile) {
    if (!mobile || typeof mobile !== 'string') return false;
    
    // Remove all non-digit characters except + for international
    const cleaned = mobile.replace(/[^\d+]/g, '');
    
    // International phone validation (E.164 format)
    // Supports: +639XXXXXXXXX (PH), +1XXXXXXXXXX (US), +44XXXXXXXXXX (UK), +91XXXXXXXXXX (IN), etc.
    // Minimum 8 digits (excluding +), maximum 15 digits
    const internationalRegex = /^\+[1-9]\d{7,14}$/;
    
    // Philippine format without +: 09XXXXXXXXX (legacy support)
    const phRegex = /^(09|639)\d{9}$/;
    
    return internationalRegex.test(cleaned) || phRegex.test(cleaned);
}

// Format amount to PHP
function formatAmount(amount, currency = 'PHP') {
    return new Intl.NumberFormat('en-PH', {
        style: 'currency',
        currency: currency
    }).format(amount);
}

// Generate payment reference
function generatePaymentReference(product, name) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const productCode = product.substring(0, 3).toUpperCase();
    const nameCode = name.substring(0, 2).toUpperCase();
    return `${productCode}${nameCode}${timestamp}`;
}

function calculateTaxedAmount(amount, taxRate = 0.10) {
    const rate = Number(taxRate);
    const safeRate = Number.isFinite(rate) ? rate : 0;
    
    // Keep decimal precision until final centavo conversion
    const baseAmount = Number(Number(amount).toFixed(2));
    const taxAmount = Number((baseAmount * safeRate).toFixed(2));
    const totalAmount = Number((baseAmount + taxAmount).toFixed(2));
    
    // Convert to centavos at final step using floor
    const baseCentavos = Math.floor(baseAmount * 100);
    const taxCentavos = Math.floor(taxAmount * 100);
    const totalCentavos = baseCentavos + taxCentavos;

    return {
        baseAmount,
        taxAmount,
        totalAmount,
        baseCentavos,
        taxCentavos,
        totalCentavos,
        taxRate: safeRate
    };
}

// Calculate fees (if needed)
function calculateFees(amount) {
    const paymongoFee = amount * 0.035; // 3.5% + PHP 15
    const fixedFee = 15;
    return {
        total: amount,
        fees: paymongoFee + fixedFee,
        net: amount - (paymongoFee + fixedFee)
    };
}

// Sanitize input
function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input
        .replace(/[<>]/g, '') // Remove potential HTML tags
        .trim();
}

// Mask sensitive data
function maskSensitive(data, fields = ['email', 'mobile']) {
    const masked = { ...data };

    fields.forEach(field => {
        if (masked[field]) {
            if (field === 'email') {
                const [local, domain] = masked[field].split('@');
                masked[field] = `${local.substring(0, 2)}***@${domain}`;
            } else if (field === 'mobile') {
                masked[field] = masked[field].replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
            }
        }
    });

    return masked;
}

// Log security events
function logSecurityEvent(event, details) {
    const log = {
        timestamp: new Date().toISOString(),
        event,
        details,
        ip: details.ip || 'unknown'
    };

    console.log('🔒 Security Event:', JSON.stringify(log));
    // In production, send to logging service
}

module.exports = {
    generateId,
    validateEmail,
    validateMobile,
    formatAmount,
    generatePaymentReference,
    calculateTaxedAmount,
    calculateFees,
    sanitizeInput,
    maskSensitive,
    logSecurityEvent
};