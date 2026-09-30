// services/ghlStudentUsers.js
//
// Creates a GHL user (staff login) in the "Nexistry Academy (Students)" sub-account for every
// customer who pays for GHL Practice Access / GHL Premium.
//
// Flow (called from the PayMongo paid webhook, before the LeadConnector "paid" webhook):
//   provisionForPayment -> claim ledger row (idempotent per payment reference) -> look the email
//   up in the location -> create the user with a fresh random password -> record the result.
// The password is returned to the caller only, to be embedded in the LeadConnector webhook. It is
// never persisted and never logged. Failures never throw: they become status 'failed' and are
// retried by retryFailed() on the production scheduler.
const crypto = require('crypto');
const ghlService = require('./ghlService');
const webhookService = require('./webhookService');
const store = require('../utils/ghlStudentUserStore');
const { USER_TYPE, USER_ROLE, PERMISSIONS, SCOPES, SCOPES_ASSIGNED_TO_ONLY } = require('./ghlStudentUserTemplate');

const DEFAULT_COMPANY_ID = 'hv6XwC1sqbvEgneGm5AY';
const DEFAULT_PRODUCTS = 'ghl_practice_access,ghl_premium_plan';
const LOGIN_URL = 'https://app.gohighlevel.com/';
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 8000;
const OVERALL_TIMEOUT_MS = 15000;

function getConfig() {
    return {
        locationId: process.env.GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS || '',
        privateKey: process.env.GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS || '',
        companyId: process.env.GHL_STUDENTS_COMPANY_ID || DEFAULT_COMPANY_ID,
        products: String(process.env.GHL_STUDENT_USER_PRODUCTS || DEFAULT_PRODUCTS)
            .split(',').map((p) => p.trim()).filter(Boolean)
    };
}

function isStudentProduct(productId) {
    return Boolean(productId) && getConfig().products.includes(String(productId));
}

/** GHL requires non-empty first and last name. Last word = last name; a single word gets "Student". */
function splitName(fullName, email) {
    const words = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return { firstName: words.slice(0, -1).join(' '), lastName: words[words.length - 1] };
    if (words.length === 1) return { firstName: words[0], lastName: 'Student' };
    const local = String(email || '').split('@')[0] || 'Student';
    return { firstName: local, lastName: 'Student' };
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SPECIAL = '!@#$%&*?';

/** 16-char random password, always >= 12 chars with upper, lower, digit and special. */
function generatePassword(length = 16) {
    const pick = (chars) => chars[crypto.randomInt(chars.length)];
    const all = UPPER + LOWER + DIGITS + SPECIAL;
    const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
    while (chars.length < Math.max(length, 12)) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

function buildUserPayload({ email, fullName, password }) {
    const { locationId, companyId } = getConfig();
    const { firstName, lastName } = splitName(fullName, email);
    return {
        companyId,
        firstName,
        lastName,
        email: String(email).trim().toLowerCase(),
        password,
        type: USER_TYPE,
        role: USER_ROLE,
        locationIds: [locationId],
        permissions: { ...PERMISSIONS },
        scopes: [...SCOPES],
        scopesAssignedToOnly: [...SCOPES_ASSIGNED_TO_ONLY]
    };
}

function safeError(err, password) {
    let message = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Unknown error';
    if (Array.isArray(message)) message = message.join('; ');
    if (typeof message !== 'string') message = JSON.stringify(message);
    if (err?.response?.status) message = `${err.response.status}: ${message}`;
    if (password) message = message.split(password).join('***');
    return message.slice(0, 500);
}

function makeClient() {
    const { privateKey, locationId } = getConfig();
    const client = ghlService.createClient({ privateKey, locationId, version: '2021-07-28' });
    return client;
}

function matchEmail(users, email) {
    const target = String(email).trim().toLowerCase();
    return (Array.isArray(users) ? users : []).find((u) => String(u?.email || '').trim().toLowerCase() === target) || null;
}

/**
 * Looks the email up in the Students location. GET /users/?locationId= is what the location
 * Private Integration token is verified to read (GET /users/search is a company-level endpoint
 * that needs an agency token), so the location list is primary and search is a best-effort second
 * look for locations with more users than a single list page returns.
 */
async function findExistingUser(client, email) {
    const { locationId, companyId } = getConfig();
    const listRes = await client.get('/users/', { params: { locationId }, timeout: REQUEST_TIMEOUT_MS });
    const found = matchEmail(listRes.data?.users, email);
    if (found) return found;
    try {
        const searchRes = await client.get('/users/search', {
            params: { companyId, query: email, limit: 25 },
            timeout: REQUEST_TIMEOUT_MS
        });
        const hit = matchEmail(searchRes.data?.users, email);
        if (hit && (!Array.isArray(hit.locationIds) || hit.locationIds.includes(locationId))) return hit;
    } catch (err) {
        // best effort only
    }
    return null;
}

/**
 * GHL side only (no DB): { status: 'created', ghlUserId, password } | { status: 'existing', ghlUserId }
 * | { status: 'failed', error }. Never throws.
 */
async function createOrFind({ email, fullName }) {
    const { locationId, privateKey } = getConfig();
    if (!locationId || !privateKey) {
        return { status: 'failed', error: 'GHL Students location is not configured' };
    }
    if (!email || !String(email).includes('@')) return { status: 'failed', error: 'Customer email is missing or invalid' };
    let password;
    try {
        const client = makeClient();
        const existing = await findExistingUser(client, email);
        if (existing) return { status: 'existing', ghlUserId: existing.id || existing._id || null };
        password = generatePassword();
        const res = await client.post('/users/', buildUserPayload({ email, fullName, password }), { timeout: REQUEST_TIMEOUT_MS });
        const ghlUserId = res.data?.id || res.data?._id || res.data?.user?.id || null;
        return { status: 'created', ghlUserId, password };
    } catch (err) {
        return { status: 'failed', error: safeError(err, password) };
    }
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'failed', error: `Timed out after ${ms}ms` }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The object embedded in the LeadConnector webhook payload as `ghlStudentAccount`. */
function toWebhookAccount(email, result) {
    const account = { email: String(email).trim().toLowerCase(), loginUrl: LOGIN_URL, status: result.status };
    if (result.status === 'created' && result.password) account.password = result.password;
    return account;
}

/**
 * Called from the paid webhook. Returns null for non-student products, otherwise the
 * `ghlStudentAccount` webhook object. Never throws.
 */
async function provisionForPayment({ paymentReference, email, fullName, productId }) {
    if (!isStudentProduct(productId)) return null;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    try {
        if (!paymentReference) {
            return toWebhookAccount(normalizedEmail, { status: 'failed' });
        }
        const { claimed, record } = await store.claim({ paymentReference, email: normalizedEmail, fullName, productId });
        if (!claimed) {
            // Repeated webhook: never create twice. The original delivery already carried the password.
            const status = record?.status === 'created' || record?.status === 'existing' ? record.status : 'failed';
            console.log(`GHL student account already handled for ${paymentReference} (${record?.status})`);
            return toWebhookAccount(normalizedEmail, { status });
        }
        const result = await withTimeout(createOrFind({ email: normalizedEmail, fullName }), OVERALL_TIMEOUT_MS);
        await store.markResult(paymentReference, {
            status: result.status, ghlUserId: result.ghlUserId, error: result.error || null
        });
        console.log(`GHL student account ${result.status} for ${paymentReference}${result.error ? `: ${result.error}` : ''}`);
        return toWebhookAccount(normalizedEmail, result);
    } catch (err) {
        console.log('GHL student account error (non-fatal):', safeError(err));
        return toWebhookAccount(normalizedEmail, { status: 'failed' });
    }
}

/**
 * Retries one already-claimed ledger row (attempts already bumped). On success sends the
 * follow-up LeadConnector webhook carrying the credentials. Returns the createOrFind result.
 */
async function retryRow(record, { sendWebhook = true } = {}) {
    const result = await withTimeout(createOrFind({ email: record.email, fullName: record.fullName }), OVERALL_TIMEOUT_MS);
    await store.markResult(record.paymentReference, {
        status: result.status, ghlUserId: result.ghlUserId, error: result.error || null
    });
    if (result.status === 'created' && sendWebhook) {
        try {
            await webhookService.sendToLeadConnector({
                event: 'ghl_student_account_created',
                paymentReference: record.paymentReference,
                productId: record.productId,
                fullName: record.fullName,
                email: record.email,
                ghlStudentAccount: toWebhookAccount(record.email, result),
                completedAt: new Date().toISOString()
            });
        } catch (err) {
            console.log('LeadConnector follow-up webhook error (non-fatal):', err.message);
        }
    }
    return result;
}

/** Scheduler entry point. Returns { attempted, created, existing, failed }. */
async function retryFailed({ limit = 10, minAgeMinutes = 5 } = {}) {
    const summary = { attempted: 0, created: 0, existing: 0, failed: 0 };
    const rows = await store.claimRetryable({ maxAttempts: MAX_ATTEMPTS, limit, minAgeMinutes });
    for (const record of rows) {
        summary.attempted += 1;
        const result = await retryRow(record).catch((err) => ({ status: 'failed', error: safeError(err) }));
        summary[result.status] += 1;
    }
    return summary;
}

module.exports = {
    MAX_ATTEMPTS, LOGIN_URL, getConfig, isStudentProduct, splitName, generatePassword, buildUserPayload,
    createOrFind, provisionForPayment, retryRow, retryFailed
};
