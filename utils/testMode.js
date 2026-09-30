// utils/testMode.js
//
// Per-checkout PayMongo TEST mode. The site is always LIVE; an admin can mint a short-lived
// signed token (POST /api/admin/test-checkout-token) and a checkout request that carries it
// (`testToken` body field, `x-nx-test-token` header, or `testToken` query param) runs in
// PayMongo test mode. A request with NO token is live, exactly as before; a token that is
// present but invalid/expired is a 403 - never a silent switch in either direction.
const { issueToken, verifyToken } = require('./authToken');
const adminStore = require('./adminStore');
const paymongoService = require('../services/paymongoService');

const TEST_TOKEN_TYPE = 'checkout_test';
const TEST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

class CheckoutModeError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'CheckoutModeError';
        this.status = status;
    }
}

/** Issues the admin-only test-checkout token (HMAC with AUTH_TOKEN_SECRET, ~2h expiry). */
function issueTestCheckoutToken(admin) {
    const token = issueToken(
        { type: TEST_TOKEN_TYPE, adminId: admin?.id || null, email: admin?.email || (admin?.master ? 'master-key' : null) },
        { ttlMs: TEST_TOKEN_TTL_MS }
    );
    return { token, expiresAt: new Date(Date.now() + TEST_TOKEN_TTL_MS).toISOString() };
}

function extractTestToken(req) {
    const candidates = [req.body && req.body.testToken, req.get && req.get('x-nx-test-token'), req.query && req.query.testToken];
    for (const value of candidates) {
        if (value === undefined || value === null || value === '') continue;
        return String(value);
    }
    return null;
}

/**
 * Resolves the PayMongo mode for a checkout-creating (or mode-sensitive) request.
 * Resolves to { mode: 'live'|'test', isTest, adminEmail, paymongo } where `paymongo` is the
 * mode-specific client. Throws CheckoutModeError (403 invalid/expired token) or the
 * TestModeUnavailableError from paymongoService (503, test env missing).
 */
async function resolveCheckoutMode(req) {
    const rawToken = extractTestToken(req);
    if (!rawToken) {
        return { mode: 'live', isTest: false, adminEmail: null, paymongo: paymongoService.forMode('live') };
    }

    const payload = verifyToken(rawToken);
    if (!payload || payload.type !== TEST_TOKEN_TYPE) {
        throw new CheckoutModeError(403, 'Invalid or expired test checkout token');
    }
    // The issuing admin must still be active (revocation kills outstanding test tokens too).
    if (payload.adminId) {
        let active = false;
        try {
            active = await adminStore.isAdminActive(payload.adminId);
        } catch (err) {
            console.error('Test token admin check error:', err.message);
        }
        if (!active) throw new CheckoutModeError(403, 'Invalid or expired test checkout token');
    }

    // Throws TestModeUnavailableError (503) if PAYMONGO_TEST_* is missing - never falls back to live.
    const paymongo = paymongoService.forMode('test');
    return { mode: 'test', isTest: true, adminEmail: payload.email || null, paymongo };
}

/** Sends the right status/body for an error thrown by resolveCheckoutMode. Returns true if handled. */
function respondModeError(res, err) {
    if (err && (err.name === 'CheckoutModeError' || err.code === 'TEST_MODE_UNAVAILABLE')) {
        res.status(err.status || 503).json({ error: err.message });
        return true;
    }
    return false;
}

/** Top-level flags added to LeadConnector payloads for test payments (nothing is added for live). */
function testPayloadFlags(isTest) {
    return isTest ? { isTest: true, livemode: false } : {};
}

module.exports = {
    TEST_TOKEN_TYPE,
    TEST_TOKEN_TTL_MS,
    CheckoutModeError,
    issueTestCheckoutToken,
    resolveCheckoutMode,
    respondModeError,
    testPayloadFlags
};
