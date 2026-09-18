// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const paymentRoutes = require('./routes/payments');
const clockistryRoutes = require('./routes/clockistry');
const adminProductRoutes = require('./routes/adminProducts');
const adminCouponRoutes = require('./routes/adminCoupons');
const affiliateRoutes = require('./routes/affiliates');
const adminAffiliateRoutes = require('./routes/adminAffiliates');
const adminSolutionsRoutes = require('./routes/adminSolutions');
const adminAuthRoutes = require('./routes/adminAuth');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing
// `verify` captures the raw request body so the PayMongo webhook signature
// (computed over the exact bytes PayMongo sent) can be checked before trusting req.body.
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files (if needed)
app.use('/public', express.static(path.join(__dirname, 'public')));
const webOutDir = path.join(__dirname, 'web', 'out');
const hasExportedWebApp = fs.existsSync(path.join(webOutDir, 'index.html'));

// Routes
app.use('/api/payments', paymentRoutes);
app.use('/api/clockistry', clockistryRoutes);
// adminAuthRoutes must be mounted before the other /api/admin routers below - it's
// the only one with a public route (/auth/login), and since every router sharing this
// mount prefix guards itself with a blanket, path-unfiltered auth check, whichever
// router is mounted first gets first look at any given /api/admin/* request.
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin', adminProductRoutes);
app.use('/api/admin', adminCouponRoutes);
app.use('/api/affiliates', affiliateRoutes);
app.use('/api/admin', adminAffiliateRoutes);
app.use('/api/admin', adminSolutionsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

if (hasExportedWebApp) {
    app.use(express.static(webOutDir));
    const exportedRoutes = [
        '/',
        '/register',
        '/admin/login',
        '/admin/admins',
        '/admin/products',
        '/admin/coupons',
        '/admin/affiliates',
        '/admin/solutions',
        '/affiliate/login',
        '/affiliate/dashboard'
    ];
    app.get(exportedRoutes, (req, res) => {
        const routePath = req.path === '/' ? 'index.html' : path.join(req.path.slice(1), 'index.html');
        res.sendFile(path.join(webOutDir, routePath));
    });
} else {
    // Admin UI entry (served from /public)
    app.get('/admin/products', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'products', 'index.html'));
    });

    app.get('/admin/coupons', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'coupons', 'index.html'));
    });

    app.get('/admin/affiliates', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'affiliates', 'index.html'));
    });

    app.get('/admin/solutions', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin', 'solutions', 'index.html'));
    });

    // Public affiliate self-registration page
    app.get('/register', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'register', 'index.html'));
    });

    // Root endpoint
    app.get('/', (req, res) => {
        res.json({
            name: 'Nexistry Academy PayMongo API',
            version: '1.0.0',
            endpoints: {
                createPayment: '/api/payments/create-payment-intent',
                paymentWebhook: '/api/payments/webhook',
                checkStatus: '/api/payments/status/:id',
                paymongoCapabilities: '/api/payments/capabilities',
                clockistryPayment: '/api/clockistry/create-payment-intent',
                health: '/health'
            }
        });
    });
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server (skipped when required as a module, e.g. by the test suite, so
// importing `app` never binds a real port or collides with an already-running server).
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV}`);
        console.log(`💰 PayMongo integration ready`);
    });
}

module.exports = app;
