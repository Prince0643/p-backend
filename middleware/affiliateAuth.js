// middleware/affiliateAuth.js
const { verifyToken } = require('../utils/authToken');
const affiliateStore = require('../utils/affiliateStore');

/** Protects the affiliate self-service portal routes (/api/affiliates/me, etc). */
const requireAffiliateAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!bearerToken) return res.status(401).json({ error: 'Not authenticated' });

    const payload = verifyToken(bearerToken);
    if (!payload || payload.type !== 'affiliate' || !payload.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const affiliate = await affiliateStore.findAffiliateById(payload.id);
        if (!affiliate || affiliate.status === 'terminated') {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        req.affiliate = affiliate;
        return next();
    } catch (err) {
        console.error('Affiliate auth check error:', err.message);
        return res.status(500).json({ error: 'Failed to verify session' });
    }
};

module.exports = { requireAffiliateAuth };
