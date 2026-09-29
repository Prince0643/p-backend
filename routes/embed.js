// routes/embed.js
// Public, cross-origin API for the embeddable checkout widget (public/nx-embed.js) pasted
// into GoHighLevel custom code on arbitrary domains. Mounted in index.js BEFORE the global
// cors()/limiter/json parser, so it carries its own (open, credential-less) CORS, body
// limit and rate limits.
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const embedController = require('../controllers/embedController');

const router = express.Router();

const limiter = ({ windowMs, max }) => rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Too many requests, please try again later.' })
});

router.use(cors({ origin: '*', credentials: false }));
router.use(express.json({ limit: '32kb' }));

router.get('/products/:id', limiter({ windowMs: 60 * 1000, max: 120 }), embedController.getProduct);
router.post('/quote', limiter({ windowMs: 60 * 1000, max: 60 }), embedController.quote);
router.post('/checkout', limiter({ windowMs: 15 * 60 * 1000, max: 15 }), embedController.checkout);

module.exports = router;
