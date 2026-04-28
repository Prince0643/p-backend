// middleware/auth.js
const crypto = require('crypto');

// Simple API key authentication
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    // Compare with stored key (you'd store this in env)
    const validKey = process.env.API_KEY;

    if (apiKey !== validKey) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
};

// Admin API key authentication (falls back to API_KEY if not set)
const validateAdminApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    const validKey = process.env.ADMIN_API_KEY || process.env.API_KEY;
    if (!validKey) {
        return res.status(500).json({ error: 'Admin API key is not configured' });
    }

    if (apiKey !== validKey) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
};

// Rate limiting by user
const userRateLimit = new Map();

const rateLimitByUser = (maxRequests = 10, windowMs = 60000) => {
    return (req, res, next) => {
        const userId = req.body.email || req.ip;
        const now = Date.now();

        if (!userRateLimit.has(userId)) {
            userRateLimit.set(userId, []);
        }

        const timestamps = userRateLimit.get(userId);
        const windowStart = now - windowMs;

        // Remove old timestamps
        const validTimestamps = timestamps.filter(t => t > windowStart);
        userRateLimit.set(userId, validTimestamps);

        if (validTimestamps.length >= maxRequests) {
            return res.status(429).json({
                error: 'Too many requests, please try again later'
            });
        }

        validTimestamps.push(now);
        userRateLimit.set(userId, validTimestamps);

        next();
    };
};

// CORS validation
const validateOrigin = (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];

    if (origin && !allowedOrigins.includes(origin) && process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }

    next();
};

module.exports = {
    validateApiKey,
    validateAdminApiKey,
    rateLimitByUser,
    validateOrigin
};
