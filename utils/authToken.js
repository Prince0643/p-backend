// utils/authToken.js
// Minimal signed session token - HMAC-SHA256 over a base64url JSON payload, same
// signing approach already used for PayMongo webhooks (middleware/paymongoWebhook.js).
// Avoids pulling in a JWT library for something this simple: prove "this is admin/
// affiliate X, issued at T" without a server-side session store. Revocation is
// enforced separately, per-request, by checking the account itself is still active.
const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret() {
    const secret = process.env.AUTH_TOKEN_SECRET;
    if (!secret) {
        throw new Error('AUTH_TOKEN_SECRET is not configured');
    }
    return secret;
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function sign(payloadB64) {
    return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

/** Issues a signed token identifying a subject (e.g. { type: 'admin', id }). */
function issueToken(subject) {
    const payload = { ...subject, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
    const payloadB64 = base64url(JSON.stringify(payload));
    const signature = sign(payloadB64);
    return `${payloadB64}.${signature}`;
}

/** Verifies a token's signature and expiry. Returns the subject payload, or null. */
function verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;

    let expectedSignature;
    try {
        expectedSignature = sign(payloadB64);
    } catch {
        return null;
    }

    const expectedBuf = Buffer.from(expectedSignature, 'base64url');
    const providedBuf = Buffer.from(signature, 'base64url');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
}

module.exports = { issueToken, verifyToken };
