// utils/corsOrigins.js
// CORS allowed-origins are env ALLOWED_ORIGINS (permanent base) union the URLs of
// currently-ACTIVE campaign_sites (admin-managed storefronts/funnels). The DB-backed
// half is cached in memory for ~60s to avoid a query on every request, and invalidated
// immediately whenever a campaign site is created/updated/deleted so changes take
// effect right away. If the DB lookup fails for any reason, callers fall back to the
// env list only - CORS must never throw or lock everyone out.
const CACHE_TTL_MS = 60 * 1000;

let cachedOrigins = null;
let cachedAt = 0;
let inFlight = null;

function invalidateActiveSiteOriginsCache() {
    cachedOrigins = null;
    cachedAt = 0;
    inFlight = null;
}

async function getActiveSiteOrigins() {
    const now = Date.now();
    if (cachedOrigins !== null && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedOrigins;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            // Required lazily to avoid a require cycle with anything that loads this
            // module before the DB pool is ready (e.g. very early in index.js).
            const campaignSiteStore = require('./campaignSiteStore');
            const origins = await campaignSiteStore.listActiveSiteOrigins();
            cachedOrigins = origins;
            cachedAt = Date.now();
            return origins;
        } catch (err) {
            console.warn('Failed to load active campaign site origins for CORS, falling back to env list only:', err.message);
            // Do not cache a failure - retry on the next request instead of being stuck
            // on an empty list for a full TTL window.
            cachedOrigins = null;
            cachedAt = 0;
            return [];
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

module.exports = { getActiveSiteOrigins, invalidateActiveSiteOriginsCache };
