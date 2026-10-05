const ghlService = require('../services/ghlService');
const productCouponConfig = require('../utils/productCouponConfig');
const ghlProductCouponSync = require('../services/ghlProductCouponSync');
const couponStore = require('../utils/couponStore');

function sendError(res, err, fallback) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error(fallback, err);
    res.status(500).json({ error: err.message || fallback });
}

// GHL products per tracked location. One location failing is reported on that location only.
exports.listGhlProducts = async (req, res) => {
    try {
        const locations = await Promise.all(ghlService.getTrackedLocations().map(async (location) => {
            const entry = { key: location.key, locationId: location.locationId };
            try {
                const products = await ghlService.listLocationProducts(location);
                entry.products = products.map((p) => ({ id: p.ref, name: p.name, price: p.price == null ? null : Number(p.price) }));
            } catch (err) {
                entry.products = [];
                entry.error = err.response?.data?.message || err.message || 'Failed to list GHL products';
            }
            return entry;
        }));
        res.json({ locations });
    } catch (err) {
        sendError(res, err, 'Failed to list GHL products');
    }
};

exports.get = async (req, res) => {
    try {
        const key = await productCouponConfig.normalizeProductKey({ kind: req.query.kind, location: req.query.location, ref: req.query.ref });
        res.json(await productCouponConfig.buildConfigView(key));
    } catch (err) {
        sendError(res, err, 'Failed to load product coupon config');
    }
};

exports.save = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const key = await productCouponConfig.normalizeProductKey(body);
        const { before, after } = await productCouponConfig.saveConfig(key, body);

        // GHL only mirrors GHL products; a local product's config is enforced at checkout/quote.
        let ghlSync = { attempted: 0, errors: [] };
        if (key.kind === 'ghl') {
            const affected = new Set([...before.disabledCodes, ...after.disabledCodes].filter((c) => before.disabledCodes.has(c) !== after.disabledCodes.has(c)));
            if (before.affiliateCouponsEnabled !== after.affiliateCouponsEnabled) {
                (await couponStore.listCoupons({ type: 'affiliate' })).forEach((c) => affected.add(c.code));
            }
            if (affected.size > 0) {
                const out = await ghlProductCouponSync.syncCouponsSafe([...affected]);
                ghlSync = { attempted: out.attempted, errors: out.errors };
            }
        }
        res.json({ ...(await productCouponConfig.buildConfigView(key)), ghlSync });
    } catch (err) {
        sendError(res, err, 'Failed to save product coupon config');
    }
};

exports.ghlSync = async (req, res) => {
    try {
        const { results, errors } = await ghlProductCouponSync.syncAll();
        res.json({ results, errors });
    } catch (err) {
        sendError(res, err, 'GHL product coupon sync failed');
    }
};
