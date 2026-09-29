// services/ghlCouponPush.js
// Pushes LOCAL affiliate coupons (origin 'local', type 'affiliate') to the two tracked GHL
// locations (GLOBAL + MAIN), recording per-location state in coupons.ghl_sync so failed
// pushes are retried at the start of every scheduled order import. Coupons discovered from
// GHL orders (origin 'ghl') are never pushed or updated from our side.
const pool = require('../db/pool');
const ghlService = require('./ghlService');
const couponStore = require('../utils/couponStore');

function errorMessage(err) {
    return err.response?.data?.message || err.response?.data?.error || err.message || 'GHL request failed';
}

/** Lazily lists (and caches per location) the coupons that already exist in GHL, keyed by upper-cased code. */
function makeExistingCache() {
    const cache = new Map();
    return async function existingFor(location) {
        if (!cache.has(location.locationId)) {
            try {
                const listed = await ghlService.listCouponsForLocation(location);
                cache.set(location.locationId, new Map(listed.coupons.map((c) => [String(c.code || '').toUpperCase(), c])));
            } catch (err) {
                cache.set(location.locationId, { error: errorMessage(err) });
            }
        }
        return cache.get(location.locationId);
    };
}

async function affiliateCouponName(code) {
    const { rows } = await pool.query('SELECT first_name, last_name FROM affiliates WHERE coupon_code = $1 LIMIT 1', [code]);
    const full = rows[0] ? `${rows[0].first_name} ${rows[0].last_name}`.trim() : '';
    return full ? `${full} Affiliate` : `Affiliate ${code}`;
}

/**
 * Creates the coupon at each tracked location where it is missing, and (when
 * `updateExisting`) updates drifted ones. `dryRun` writes nothing (no GHL calls that
 * mutate, no state). Returns { code, skipped?, results: [{ key, locationId, action, ghlCouponId?, error? }] }.
 */
async function pushCoupon(coupon, { dryRun = false, updateExisting = true, locations, existingFor = makeExistingCache() } = {}) {
    if (coupon.origin === 'ghl') return { code: coupon.code, skipped: 'ghl_origin', results: [] };
    if (coupon.type !== 'affiliate') return { code: coupon.code, skipped: 'not_affiliate', results: [] };
    if (!coupon.active) return { code: coupon.code, skipped: 'inactive', results: [] };

    const targets = locations || ghlService.getTrackedLocations();
    if (targets.length === 0) return { code: coupon.code, skipped: 'no_locations', results: [] };

    const results = [];
    const record = async (location, state) => {
        if (!dryRun) await couponStore.setGhlSyncState(coupon.code, location.key, { locationId: location.locationId, ...state });
    };

    for (const location of targets) {
        const base = { key: location.key, locationId: location.locationId };
        const existing = await existingFor(location);
        if (existing.error) {
            results.push({ ...base, action: 'error', error: existing.error });
            await record(location, { status: 'error', error: existing.error });
            continue;
        }

        const present = existing.get(String(coupon.code).toUpperCase());
        try {
            if (!present) {
                if (dryRun) {
                    results.push({ ...base, action: 'would_create' });
                    continue;
                }
                await record(location, { status: 'pending' });
                const name = await affiliateCouponName(coupon.code);
                const created = await ghlService.createCouponForLocation(location, { ...coupon, name });
                existing.set(String(coupon.code).toUpperCase(), created);
                results.push({ ...base, action: 'created', ghlCouponId: created.id || null });
                await record(location, { status: 'synced', ghlCouponId: created.id || null });
            } else if (updateExisting && ghlService.couponNeedsUpdate(present, coupon)) {
                if (dryRun) {
                    results.push({ ...base, action: 'would_update', ghlCouponId: present.id || null });
                    continue;
                }
                await record(location, { status: 'pending' });
                const updated = await ghlService.updateCouponForLocation(location, present, coupon);
                results.push({ ...base, action: 'updated', ghlCouponId: updated.id || present.id || null });
                await record(location, { status: 'synced', ghlCouponId: updated.id || present.id || null });
            } else {
                results.push({ ...base, action: dryRun || !updateExisting ? 'exists' : 'unchanged', ghlCouponId: present.id || null });
                await record(location, { status: 'synced', ghlCouponId: present.id || null });
            }
        } catch (err) {
            const message = errorMessage(err);
            results.push({ ...base, action: 'error', error: message });
            await record(location, { status: 'error', error: message });
        }
    }
    return { code: coupon.code, results };
}

/** Non-fatal wrapper for request paths (registration, admin edits): never throws. */
async function pushCouponSafe(code) {
    try {
        const coupon = await couponStore.findCoupon(code);
        if (!coupon) return null;
        const outcome = await pushCoupon(coupon);
        for (const r of outcome.results) {
            if (r.action === 'error') console.log(`GHL affiliate coupon push failed (non-fatal) [${r.key}] ${coupon.code}:`, r.error);
        }
        return outcome;
    } catch (err) {
        console.log('GHL affiliate coupon push failed (non-fatal):', err.message);
        return null;
    }
}

/** Retries every affiliate coupon whose last push attempt is still pending/errored. */
async function retryPendingPushes() {
    const summary = { attempted: 0, synced: 0, failed: 0 };
    const coupons = await couponStore.listCouponsWithPendingGhlPush();
    const existingFor = makeExistingCache();
    for (const coupon of coupons) {
        summary.attempted++;
        const outcome = await pushCoupon(coupon, { existingFor });
        if (outcome.results.some((r) => r.action === 'error')) summary.failed++;
        else summary.synced++;
    }
    return summary;
}

module.exports = { pushCoupon, pushCouponSafe, retryPendingPushes, makeExistingCache };
