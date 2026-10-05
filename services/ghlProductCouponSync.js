// services/ghlProductCouponSync.js
// Reflects the per-product coupon config (utils/productCouponConfig.js) in GHL by writing each
// coupon's productIds at every tracked location where the coupon exists - for our affiliate
// coupons AND GHL-origin general coupons. Per coupon + location:
//   allowed = location's GHL products ∩ the coupon's ORIGINAL restriction (empty = all) − blocked
// Nothing blocked -> the original restriction is restored; blocked -> an explicit productIds list;
// allowed empty -> the coupon is ended there (endDate = now; GHL has no status field and reads empty
// productIds as "all products") and its original endDate restored once it is non-empty again. The original restriction is snapshotted in
// coupons.ghl_product_sync before we first overwrite it so repeated pushes never compound.
// Failures are recorded per location and never thrown to the caller.
const ghlService = require('./ghlService');
const couponStore = require('../utils/couponStore');
const productCouponConfig = require('../utils/productCouponConfig');
const { makeExistingCache } = require('./ghlCouponPush');

function errorMessage(err) {
    return err.response?.data?.message || err.response?.data?.error || err.message || 'GHL request failed';
}

const sorted = (ids) => [...ids].map(String).sort();
const sameSet = (a, b) => {
    const x = sorted(a);
    const y = sorted(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Pure: what a coupon's GHL productIds should be at one location. `original` is the coupon's
 * own restriction (empty = all products), `blocked` the product ids it is switched off for.
 * Returns { productIds, allowed, deactivate } - productIds is what to push ([] = unrestricted).
 */
function computeProductIds({ universe, original, blocked }) {
    const base = original.length ? universe.filter((id) => original.includes(id)) : [...universe];
    const effectivelyBlocked = base.filter((id) => blocked.has(id));
    if (effectivelyBlocked.length === 0) return { productIds: [...original], allowed: base, deactivate: false };
    const allowed = base.filter((id) => !blocked.has(id));
    return { productIds: allowed, allowed, deactivate: allowed.length === 0 };
}

let inflightAll = null;

/**
 * Syncs `coupons` (default: every coupon) across the tracked locations. Returns
 * { attempted, results: [{ code, locationKey, action, error? }], errors: [{ code, locationKey, error }] }.
 */
async function syncCoupons({ codes = null } = {}) {
    const results = [];
    const locations = ghlService.getTrackedLocations();
    if (locations.length === 0) return { attempted: 0, results, errors: [] };

    const wanted = codes ? new Set(codes.map((c) => couponStore.toCouponCode(c))) : null;
    const coupons = (await couponStore.listCoupons()).filter((c) => !wanted || wanted.has(c.code));
    if (coupons.length === 0) return { attempted: 0, results, errors: [] };

    const rules = await productCouponConfig.loadGhlBlockRules();
    const existingFor = makeExistingCache();

    for (const location of locations) {
        const existing = await existingFor(location);
        if (existing.error) {
            results.push({ code: null, locationKey: location.key, action: 'error', error: existing.error });
            continue;
        }
        const locRules = rules.get(location.key) || { affiliateOff: new Set(), blocked: new Map() };
        const blockedFor = (c) => (c.type === 'affiliate' ? locRules.affiliateOff : (locRules.blocked.get(c.code) || new Set()));
        // Only coupons that exist in this location AND are either blocked somewhere or were written
        // by us before need work - an untouched, unblocked coupon is already correct (and the
        // location's products need not even be listed).
        const present = coupons.filter((c) => existing.has(c.code.toUpperCase())
            && (blockedFor(c).size > 0 || c.ghlProductSync?.[location.key]));
        if (present.length === 0) continue;

        let universe = null;
        let universeError = null;
        try {
            universe = (await ghlService.listLocationProducts(location, { withPrices: false })).map((p) => String(p.ref));
            // An empty listing would make every blocked coupon look fully blocked - treat it as a failure.
            if (universe.length === 0) universeError = 'GHL returned no products for this location - skipped';
        } catch (err) {
            universeError = errorMessage(err);
        }

        for (const coupon of present) {
            const base = { code: coupon.code, locationKey: location.key };
            const prior = coupon.ghlProductSync?.[location.key] || null;
            const record = (state) => couponStore.setGhlProductSyncState(coupon.code, location.key, { ...(prior || {}), ...state });
            if (universeError) {
                results.push({ ...base, action: 'error', error: universeError });
                await record({ status: 'error', error: universeError }).catch(() => {});
                continue;
            }
            try {
                const ghlCoupon = existing.get(coupon.code.toUpperCase());
                const currentIds = ghlCoupon.productIds || [];
                const currentEnd = ghlCoupon.endDate || null;

                // We are the only writer of `pushed` / `pushedEndDate`; if GHL no longer matches
                // them, an admin changed the coupon in GHL, so what is there now is the new original.
                const ours = Boolean(prior?.deactivatedByUs) && sameSet(currentIds, prior.pushed || []) && currentEnd === (prior.pushedEndDate || null);
                const idsUntouched = prior && Array.isArray(prior.pushed) && sameSet(currentIds, prior.pushed);
                const original = idsUntouched ? prior.original : currentIds;
                const originalEndDate = ours ? (prior.originalEndDate ?? null) : currentEnd;

                // Expired in GHL before we touched it, or inactive/expired on our side: an admin
                // switched it off, so it is left alone (and never reactivated).
                const expiredAt = (d) => d && new Date(d).getTime() <= Date.now();
                if (!ours && (expiredAt(currentEnd) || !coupon.active || expiredAt(coupon.expiresAt))) {
                    results.push({ ...base, action: 'skipped_inactive' });
                    continue;
                }
                if (ours && (!coupon.active || expiredAt(coupon.expiresAt))) {
                    results.push({ ...base, action: 'skipped_inactive' });
                    continue;
                }

                const { productIds, deactivate } = computeProductIds({ universe, original, blocked: blockedFor(coupon) });

                // GHL has no status field: deactivating = ending the coupon now (kept after its
                // startDate), reactivating = restoring the original endDate. The restriction stays
                // at the original while ended - an empty list would mean "all products".
                let endDate;
                if (deactivate && !ours) {
                    const start = ghlCoupon.startDate ? new Date(ghlCoupon.startDate).getTime() : 0;
                    endDate = new Date(Math.max(Date.now(), start + 60 * 1000)).toISOString();
                } else if (!deactivate && ours) {
                    endDate = originalEndDate;
                }
                const deactivatedByUs = deactivate;
                const pushIds = deactivate ? original : productIds;
                const pushedEndDate = endDate === undefined ? currentEnd : endDate;
                const drifted = !sameSet(currentIds, pushIds) || endDate !== undefined;
                const synced = { status: 'synced', error: null, original, pushed: pushIds, deactivatedByUs, originalEndDate, pushedEndDate };

                if (!drifted) {
                    if (!prior || prior.status !== 'synced' || !sameSet(prior.original || [], original) || !sameSet(prior.pushed || [], pushIds)) await record(synced);
                    results.push({ ...base, action: 'unchanged' });
                    continue;
                }
                // Snapshot first, so a failed write can't lose the original endDate/restriction.
                await record({ original, originalEndDate });
                await ghlService.updateCouponProductRestriction(location, ghlCoupon, pushIds, { endDate });
                ghlCoupon.productIds = pushIds;
                if (endDate !== undefined) ghlCoupon.endDate = endDate;
                await record(synced);
                results.push({ ...base, action: deactivate && !ours ? 'deactivated' : !deactivate && ours ? 'reactivated' : 'updated', productIds: pushIds });
            } catch (err) {
                const message = errorMessage(err);
                results.push({ ...base, action: 'error', error: message });
                await record({ status: 'error', error: message }).catch(() => {});
            }
        }
    }

    const errors = results.filter((r) => r.action === 'error').map((r) => ({ code: r.code, locationKey: r.locationKey, error: r.error }));
    return { attempted: results.length, results, errors };
}

/** Non-fatal: syncs only the given coupon codes; never throws (used after an admin save). */
async function syncCouponsSafe(codes) {
    try {
        const out = await syncCoupons({ codes });
        for (const e of out.errors) console.log(`GHL product coupon sync failed (non-fatal) [${e.locationKey}] ${e.code}:`, e.error);
        return out;
    } catch (err) {
        console.log('GHL product coupon sync failed (non-fatal):', err.message);
        return { attempted: 0, results: [], errors: [{ code: null, locationKey: null, error: err.message }] };
    }
}

/** Full re-sync of every coupon (manual trigger + periodic job). Concurrent calls share one run. */
function syncAll() {
    if (!inflightAll) {
        inflightAll = syncCoupons().finally(() => { inflightAll = null; });
    }
    return inflightAll;
}

module.exports = { computeProductIds, syncCoupons, syncCouponsSafe, syncAll };
