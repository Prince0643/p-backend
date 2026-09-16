// utils/affiliateStore.js
const fs = require('fs');
const path = require('path');
const { validateEmail } = require('./helpers');

const AFFILIATES_PATH = process.env.AFFILIATE_STORE_PATH
    ? path.resolve(process.env.AFFILIATE_STORE_PATH)
    : path.join(__dirname, '..', 'data', 'affiliates.json');

const PH_EWALLET_METHODS = ['GCASH', 'MAYA'];
const PH_BANK_METHODS = ['BDO', 'BPI', 'METROBANK', 'LANDBANK', 'PNB', 'UNIONBANK', 'SECURITY_BANK', 'RCBC', 'OTHER'];
const GLOBAL_METHODS = ['WISE', 'PAYPAL'];

function safeJsonParse(raw) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

function readJsonFile(filePath, defaultValue) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = safeJsonParse(raw);
        if (!parsed.ok) throw new Error(`Failed to parse JSON at ${filePath}: ${parsed.error.message}`);
        return parsed.value;
    } catch (err) {
        if (err.code === 'ENOENT') return defaultValue;
        throw err;
    }
}

function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function readStore() {
    const store = readJsonFile(AFFILIATES_PATH, { version: 1, affiliates: [] });
    const affiliates = Array.isArray(store?.affiliates) ? store.affiliates : [];
    return { version: Number(store?.version || 1), affiliates };
}

function writeStore(store) {
    writeJsonFile(AFFILIATES_PATH, store);
}

function requireString(value, fieldName) {
    const str = String(value ?? '').trim();
    if (!str) throw new Error(`${fieldName} is required`);
    return str;
}

function isTermsAccepted(value) {
    return value === true || value === 'true' || value === 'on';
}

/**
 * Validates and normalizes an affiliate registration payload. Field names deliberately
 * mirror the Nexistry affiliate registration form's `buildPayload()` output, so this
 * endpoint can accept that form's submissions directly without remapping.
 */
function normalizeAffiliate(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid registration payload');
    }

    const firstName = requireString(payload.firstName, 'firstName');
    const lastName = requireString(payload.lastName, 'lastName');
    const email = requireString(payload.email, 'email').toLowerCase();
    if (!validateEmail(email)) throw new Error('A valid email is required');

    const contactNumber = requireString(payload.contactNumber, 'contactNumber');

    const socials = {
        facebook: payload.facebook ? String(payload.facebook).trim() : '',
        instagram: payload.instagram ? String(payload.instagram).trim() : '',
        tiktok: payload.tiktok ? String(payload.tiktok).trim() : '',
        linkedin: payload.linkedin ? String(payload.linkedin).trim() : '',
        youtube: payload.youtube ? String(payload.youtube).trim() : ''
    };
    Object.keys(socials).forEach((k) => { if (!socials[k]) delete socials[k]; });

    const paymentRegion = String(payload.paymentRegion || '').trim().toUpperCase();
    if (!['PH', 'GLOBAL'].includes(paymentRegion)) {
        throw new Error('paymentRegion must be "PH" or "GLOBAL"');
    }

    const preferredBank = String(payload.preferredBank || '').trim().toUpperCase();
    let payoutDetails;

    if (paymentRegion === 'PH') {
        if (PH_EWALLET_METHODS.includes(preferredBank)) {
            payoutDetails = {
                accountHolderName: requireString(payload.ewalletName, 'ewalletName'),
                mobileNumber: requireString(payload.ewalletNumber, 'ewalletNumber')
            };
        } else if (PH_BANK_METHODS.includes(preferredBank)) {
            const bankName = preferredBank === 'OTHER'
                ? requireString(payload.otherBankName, 'otherBankName')
                : preferredBank;
            payoutDetails = {
                bankName,
                accountName: requireString(payload.bankAccountName, 'bankAccountName'),
                accountNumber: requireString(payload.bankAccountNumber, 'bankAccountNumber'),
                bankBranch: requireString(payload.bankBranch, 'bankBranch')
            };
        } else {
            throw new Error(`preferredBank must be one of ${[...PH_EWALLET_METHODS, ...PH_BANK_METHODS].join(', ')} for PH region`);
        }
    } else {
        if (!GLOBAL_METHODS.includes(preferredBank)) {
            throw new Error(`preferredBank must be one of ${GLOBAL_METHODS.join(', ')} for GLOBAL region`);
        }
        payoutDetails = {
            accountName: requireString(payload.globalAccountName, 'globalAccountName'),
            accountEmail: requireString(payload.globalAccountEmail, 'globalAccountEmail').toLowerCase()
        };
        if (!validateEmail(payoutDetails.accountEmail)) throw new Error('globalAccountEmail must be a valid email');
    }

    if (!isTermsAccepted(payload.termsAccepted)) {
        throw new Error('Terms and conditions must be accepted');
    }
    const termsVersion = payload.termsVersion ? String(payload.termsVersion).trim() : '';

    return {
        firstName,
        lastName,
        email,
        contactNumber,
        socials,
        paymentRegion,
        preferredBank,
        payoutDetails,
        termsAccepted: true,
        termsVersion
    };
}

function listAffiliates() {
    const { affiliates } = readStore();
    return affiliates.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function findAffiliateByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const { affiliates } = readStore();
    return affiliates.find((a) => a.email === normalized) || null;
}

function findAffiliateById(id) {
    const { affiliates } = readStore();
    return affiliates.find((a) => a.id === id) || null;
}

function createAffiliate(normalized, couponCode) {
    const store = readStore();
    const id = `AFF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const record = {
        id,
        ...normalized,
        couponCode,
        status: 'active',
        createdAt: new Date().toISOString()
    };

    store.affiliates.push(record);
    writeStore({ version: store.version || 1, affiliates: store.affiliates });
    return record;
}

module.exports = {
    AFFILIATES_PATH,
    PH_EWALLET_METHODS,
    PH_BANK_METHODS,
    GLOBAL_METHODS,
    normalizeAffiliate,
    listAffiliates,
    findAffiliateByEmail,
    findAffiliateById,
    createAffiliate
};
