// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const embedRoutes = require('./routes/embed');
const paymentRoutes = require('./routes/payments');
const clockistryRoutes = require('./routes/clockistry');
const adminProductRoutes = require('./routes/adminProducts');
const adminCouponRoutes = require('./routes/adminCoupons');
const adminGhlCouponRoutes = require('./routes/adminGhlCoupons');
const adminCampaignRoutes = require('./routes/adminCampaigns');
const adminCampaignSiteRoutes = require('./routes/adminCampaignSites');
const affiliateRoutes = require('./routes/affiliates');
const adminAffiliateRoutes = require('./routes/adminAffiliates');
const adminSolutionsRoutes = require('./routes/adminSolutions');
const adminSettingsRoutes = require('./routes/adminSettings');
const adminAuthRoutes = require('./routes/adminAuth');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));

// Public embed API (GHL-pasted widget on arbitrary origins). Mounted BEFORE the global
// cors()/limiter/json parser below: it carries its own open, credential-less CORS, 32kb
// body limit and per-endpoint rate limits (see routes/embed.js).
app.use('/api/embed', embedRoutes);

// CORS configuration - env ALLOWED_ORIGINS (permanent base) union the origins of
// currently-active campaign_sites (admin-managed storefronts/funnels), cached ~60s in
// utils/corsOrigins.js. If the DB lookup fails, we fall back to the env list only.
const { getActiveSiteOrigins } = require('./utils/corsOrigins');
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
app.use(cors({
    origin: async (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }
        try {
            const siteOrigins = await getActiveSiteOrigins();
            if (siteOrigins.includes(origin)) {
                return callback(null, true);
            }
        } catch {
            // getActiveSiteOrigins already falls back internally and never throws, but
            // guard anyway - CORS must never lock everyone out due to a DB hiccup.
        }
        callback(new Error('Not allowed by CORS'));
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

// Serve the checkout-attribution script cross-origin (GHL funnel pages load it from a
// different domain), overriding helmet's default same-origin CORP just for this one
// file - every other file under /public keeps helmet's defaults via the static mount below.
app.get('/public/nx-ref.js', (req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(__dirname, 'public', 'nx-ref.js'));
});

// Same for the embeddable checkout widget.
app.get('/public/nx-embed.js', (req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(__dirname, 'public', 'nx-embed.js'));
});

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
app.use('/api/admin', adminGhlCouponRoutes);
app.use('/api/admin', adminCampaignRoutes);
app.use('/api/admin', adminCampaignSiteRoutes);
app.use('/api/affiliates', affiliateRoutes);
app.use('/api/admin', adminAffiliateRoutes);
app.use('/api/admin', adminSolutionsRoutes);
app.use('/api/admin', adminSettingsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

if (hasExportedWebApp) {
    app.use(express.static(webOutDir, { redirect: false }));
    const exportedRoutes = [
        '/',
        '/admin',
        '/admin/dashboard',
        '/register',
        '/admin/login',
        '/admin/admins',
        '/admin/products',
        '/admin/coupons',
        '/admin/campaigns',
        '/admin/campaign-sites',
        '/admin/affiliates',
        '/admin/solutions',
        '/admin/settings',
        '/admin/test-checkout',
        '/affiliate/login',
        '/affiliate/dashboard'
    ];
    app.get(exportedRoutes, (req, res) => {
        const route = req.path === '/' ? 'index' : req.path.slice(1);
        const candidates = route === 'index'
            ? ['index.html']
            : [`${route}.html`, path.join(route, 'index.html')];
        const match = candidates.find((candidate) => fs.existsSync(path.join(webOutDir, candidate)));
        if (!match) return res.status(404).json({ error: 'Page not found' });
        return res.sendFile(path.join(webOutDir, match));
    });
} else {
    // Admin UI entry (served from /public)
    app.get('/admin', (req, res) => {
        res.redirect('/admin/products');
    });

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

// GHL order import scheduler (GLOBAL + MAIN locations) - only in production, never in tests or a bare
// `require('./index')` (e.g. the test suite imports `app` directly, which must never
// have side effects like a recurring timer touching a real/test database on its own).
if (process.env.NODE_ENV === 'production') {
    const { importGlobalOrders } = require('./services/ghlOrderImport');
    const IMPORT_INTERVAL_MS = 10 * 60 * 1000;
    const runImport = () => {
        importGlobalOrders({ backfill: false }).catch((err) => {
            console.error('GHL order import failed:', err.message);
        });
    };
    setTimeout(runImport, 30 * 1000);
    setInterval(runImport, IMPORT_INTERVAL_MS);

    // Retry GHL student-account creations that failed at payment time (max 5 attempts each).
    const { retryFailed: retryStudentUsers } = require('./services/ghlStudentUsers');
    const runStudentRetry = () => {
        retryStudentUsers().catch((err) => {
            console.error('GHL student account retry failed:', err.message);
        });
    };
    setTimeout(runStudentRetry, 60 * 1000);
    setInterval(runStudentRetry, IMPORT_INTERVAL_MS);
}

module.exports = app;
