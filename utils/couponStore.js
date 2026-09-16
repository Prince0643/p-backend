// utils/couponStore.js
const fs = require('fs');
const path = require('path');

const COUPONS_PATH = process.env.COUPON_CATALOG_PATH
    ? path.resolve(process.env.COUPON_CATALOG_PATH)
    : path.join(__dirname, '..', 'data', 'coupons.json');

const REDEMPTIONS_PATH = process.env.COUPON_REDEMPTIONS_PATH
    ? path.resolve(process.env.COUPON_REDEMPTIONS_PATH)
    : path.join(__dirname, '..', 'data', 'coupon_redemptions.json');

function safeJsonParse(raw) {
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
        return { ok: false, error: err };
    }
}

function toCouponCode(input) {
    return String(input || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/g, '');
}

function readJsonFile(filePath, defaultValue) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = safeJsonParse(raw);
        if (!parsed.ok) {
            throw new Error(`Failed to parse JSON at ${filePath}: ${parsed.error.message}`);
        }
        return parsed.value;
    } catch (err) {
        if (err.code === 'ENOENT') return defaultValue;
        throw err;
    }
}

function writeJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function normalizePercent(value, fieldName, { required = false, defaultValue = 0 } = {}) {
    if (value == null || value === '') {
        if (required) throw new Error(`${fieldName} is required`);
        return defaultValue;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
        throw new Error(`${fieldName} must be a number between 0 and 1`);
    }
    return num;
}

function normalizeCoupon(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid coupon payload');
    }

    const code = toCouponCode(payload.code);
    if (!code) throw new Error('Coupon code is required');

    const discountPercent = normalizePercent(payload.discountPercent, 'discountPercent', { required: true });
    const affiliateFeePercent = normalizePercent(payload.affiliateFeePercent, 'affiliateFeePercent', { defaultValue: 0 });

    const affiliateEmail = payload.affiliateEmail ? String(payload.affiliateEmail).trim() : '';

    const active = payload.active === undefined ? true : Boolean(payload.active);

    let expiresAt = null;
    if (payload.expiresAt) {
        const d = new Date(payload.expiresAt);
        if (Number.isNaN(d.getTime())) throw new Error('expiresAt must be a valid date/time');
        expiresAt = d.toISOString();
    }

    const productIds = Array.isArray(payload.productIds)
        ? payload.productIds.map((id) => String(id).trim()).filter(Boolean)
        : [];

    const maxRedemptions = (payload.maxRedemptions === undefined || payload.maxRedemptions === null || payload.maxRedemptions === '')
        ? null
        : Number(payload.maxRedemptions);
    if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
        throw new Error('maxRedemptions must be a positive integer, if set');
    }

    const notes = payload.notes ? String(payload.notes) : '';

    return {
        code,
        discountPercent,
        affiliateFeePercent,
        affiliateEmail,
        active,
        expiresAt,
        productIds,
        maxRedemptions,
        notes
    };
}

function readCatalog() {
    const catalog = readJsonFile(COUPONS_PATH, { version: 1, coupons: [] });
    const coupons = Array.isArray(catalog?.coupons) ? catalog.coupons : [];
    return { version: Number(catalog?.version || 1), coupons };
}

function writeCatalog(catalog) {
    writeJsonFile(COUPONS_PATH, catalog);
}

function readRedemptions() {
    const store = readJsonFile(REDEMPTIONS_PATH, { version: 1, redemptions: [] });
    const redemptions = Array.isArray(store?.redemptions) ? store.redemptions : [];
    return { version: Number(store?.version || 1), redemptions };
}

function writeRedemptions(store) {
    writeJsonFile(REDEMPTIONS_PATH, store);
}

function listCoupons() {
    const catalog = readCatalog();
    const normalized = catalog.coupons.map(normalizeCoupon);
    normalized.sort((a, b) => a.code.localeCompare(b.code));
    return normalized;
}

function findCoupon(code) {
    const normalizedCode = toCouponCode(code);
    if (!normalizedCode) return null;
    const coupons = listCoupons();
    return coupons.find((c) => c.code === normalizedCode) || null;
}

function upsertCoupon(payload) {
    const incoming = normalizeCoupon(payload);
    const catalog = readCatalog();

    const existingIndex = catalog.coupons.findIndex((c) => toCouponCode(c.code) === incoming.code);
    const nextCoupons = [...catalog.coupons];
    if (existingIndex >= 0) {
        nextCoupons[existingIndex] = incoming;
    } else {
        nextCoupons.push(incoming);
    }

    writeCatalog({ version: catalog.version || 1, coupons: nextCoupons });
    return incoming;
}

function deleteCoupon(code) {
    const normalizedCode = toCouponCode(code);
    const catalog = readCatalog();
    const nextCoupons = catalog.coupons.filter((c) => toCouponCode(c.code) !== normalizedCode);
    if (nextCoupons.length === catalog.coupons.length) return false;
    writeCatalog({ version: catalog.version || 1, coupons: nextCoupons });
    return true;
}

function countRedemptions(code) {
    const normalizedCode = toCouponCode(code);
    const { redemptions } = readRedemptions();
    return redemptions.filter((r) => toCouponCode(r.code) === normalizedCode).length;
}

/**
 * Validates a coupon code against server-side truth for a specific product/charge.
 * Returns { coupon } on success, or { error, reason } on failure. Never throws for
 * expected validation failures so callers can turn this straight into a 400 response.
 */
function validateCouponForCharge({ code, productId }) {
    if (!code) return { error: 'No promo code provided' };

    const coupon = findCoupon(code);
    if (!coupon) return { error: 'Invalid promo code', reason: 'not_found' };

    if (!coupon.active) return { error: 'This promo code is no longer active', reason: 'inactive' };

    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
        return { error: 'This promo code has expired', reason: 'expired' };
    }

    if (coupon.productIds.length > 0 && productId && !coupon.productIds.includes(productId)) {
        return { error: 'This promo code is not valid for the selected product', reason: 'product_not_eligible' };
    }

    if (coupon.maxRedemptions != null) {
        const used = countRedemptions(coupon.code);
        if (used >= coupon.maxRedemptions) {
            return { error: 'This promo code has reached its redemption limit', reason: 'max_redemptions_reached' };
        }
    }

    return { coupon };
}

function recordRedemption(entry) {
    const store = readRedemptions();
    const id = `RDM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const record = {
        id,
        code: toCouponCode(entry.code),
        paymentReference: String(entry.paymentReference || ''),
        productId: String(entry.productId || ''),
        email: String(entry.email || ''),
        fullName: String(entry.fullName || ''),
        baseAmount: Number(entry.baseAmount) || 0,
        discountAmount: Number(entry.discountAmount) || 0,
        affiliateFeeAmount: Number(entry.affiliateFeeAmount) || 0,
        affiliateEmail: String(entry.affiliateEmail || ''),
        currency: String(entry.currency || 'PHP'),
        status: 'pending',
        createdAt: new Date().toISOString(),
        paidAt: null
    };

    store.redemptions.push(record);
    writeRedemptions({ version: store.version || 1, redemptions: store.redemptions });
    return record;
}

function listRedemptions({ code, status } = {}) {
    const { redemptions } = readRedemptions();
    const normalizedCode = code ? toCouponCode(code) : null;

    return redemptions
        .filter((r) => (normalizedCode ? toCouponCode(r.code) === normalizedCode : true))
        .filter((r) => (status ? r.status === status : true))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function markRedemptionsPaid(ids) {
    const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const store = readRedemptions();
    let updated = 0;

    const nextRedemptions = store.redemptions.map((r) => {
        if (idSet.has(String(r.id)) && r.status !== 'paid') {
            updated += 1;
            return { ...r, status: 'paid', paidAt: new Date().toISOString() };
        }
        return r;
    });

    if (updated > 0) {
        writeRedemptions({ version: store.version || 1, redemptions: nextRedemptions });
    }
    return updated;
}

module.exports = {
    COUPONS_PATH,
    REDEMPTIONS_PATH,
    toCouponCode,
    listCoupons,
    findCoupon,
    upsertCoupon,
    deleteCoupon,
    validateCouponForCharge,
    recordRedemption,
    listRedemptions,
    markRedemptionsPaid
};
