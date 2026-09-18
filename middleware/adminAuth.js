// middleware/adminAuth.js
const { verifyToken } = require('../utils/authToken');
const adminStore = require('../utils/adminStore');

/**
 * Protects every /api/admin/* route. Accepts either:
 * 1. The env-configured master key (ADMIN_API_KEY, falling back to API_KEY) via the
 *    `x-api-key` header - a permanent bootstrap/break-glass credential.
 * 2. A signed session token (from POST /api/admin/auth/login) via
 *    `Authorization: Bearer <token>`, as long as that admin account hasn't been revoked.
 * All admins have identical full access - there are no permission tiers.
 */
const requireAdminAuth = async (req, res, next) => {
    const masterKey = process.env.ADMIN_API_KEY || process.env.API_KEY;
    const apiKey = req.headers['x-api-key'];
    if (masterKey && apiKey && apiKey === masterKey) {
        req.admin = { id: null, email: null, master: true };
        return next();
    }

    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (bearerToken) {
        const payload = verifyToken(bearerToken);
        if (payload && payload.type === 'admin' && payload.id) {
            try {
                if (await adminStore.isAdminActive(payload.id)) {
                    req.admin = { id: payload.id, email: payload.email, master: false };
                    return next();
                }
            } catch (err) {
                console.error('Admin auth check error:', err.message);
                return res.status(500).json({ error: 'Failed to verify session' });
            }
        }
    }

    return res.status(401).json({ error: 'Not authenticated' });
};

module.exports = { requireAdminAuth };
