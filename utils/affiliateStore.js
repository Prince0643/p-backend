// utils/affiliateStore.js
const pool = require('../db/pool');
const { validateEmail } = require('./helpers');

const PH_EWALLET_METHODS = ['GCASH', 'MAYA'];
const PH_BANK_METHODS = ['BDO', 'BPI', 'METROBANK', 'LANDBANK', 'PNB', 'UNIONBANK', 'SECURITY_BANK', 'RCBC', 'OTHER'];
const GLOBAL_METHODS = ['WISE', 'PAYPAL'];
const AFFILIATE_STATUSES = ['active', 'suspended', 'terminated'];

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
        firstName, lastName, email, contactNumber, socials,
        paymentRegion, preferredBank, payoutDetails,
        termsAccepted: true, termsVersion
    };
}

function rowToAffiliate(row) {
    return {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        contactNumber: row.contact_number,
        socials: row.socials || {},
        paymentRegion: row.payment_region,
        preferredBank: row.preferred_bank,
        payoutDetails: row.payout_details || {},
        termsAccepted: row.terms_accepted,
        termsVersion: row.terms_version || '',
        couponCode: row.coupon_code || null,
        status: row.status,
        statusUpdatedAt: row.status_updated_at ? new Date(row.status_updated_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString()
    };
}

async function listAffiliates() {
    const { rows } = await pool.query('SELECT * FROM affiliates ORDER BY created_at DESC');
    return rows.map(rowToAffiliate);
}

async function findAffiliateByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const { rows } = await pool.query('SELECT * FROM affiliates WHERE email = $1', [normalized]);
    return rows[0] ? rowToAffiliate(rows[0]) : null;
}

async function findAffiliateById(id) {
    const { rows } = await pool.query('SELECT * FROM affiliates WHERE id = $1', [id]);
    return rows[0] ? rowToAffiliate(rows[0]) : null;
}

async function createAffiliate(normalized, couponCode) {
    const id = `AFF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const { rows } = await pool.query(
        `INSERT INTO affiliates (id, first_name, last_name, email, contact_number, socials, payment_region, preferred_bank, payout_details, terms_accepted, terms_version, coupon_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
         RETURNING *`,
        [
            id, normalized.firstName, normalized.lastName, normalized.email, normalized.contactNumber,
            JSON.stringify(normalized.socials || {}), normalized.paymentRegion, normalized.preferredBank,
            JSON.stringify(normalized.payoutDetails || {}), normalized.termsAccepted, normalized.termsVersion || null,
            couponCode
        ]
    );
    return rowToAffiliate(rows[0]);
}

async function setAffiliateStatus(id, status) {
    if (!AFFILIATE_STATUSES.includes(status)) {
        throw new Error(`status must be one of ${AFFILIATE_STATUSES.join(', ')}`);
    }
    const { rows } = await pool.query(
        `UPDATE affiliates SET status = $2, status_updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status]
    );
    return rows[0] ? rowToAffiliate(rows[0]) : null;
}

module.exports = {
    PH_EWALLET_METHODS,
    PH_BANK_METHODS,
    GLOBAL_METHODS,
    AFFILIATE_STATUSES,
    normalizeAffiliate,
    setAffiliateStatus,
    listAffiliates,
    findAffiliateByEmail,
    findAffiliateById,
    createAffiliate
};
