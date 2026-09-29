// scripts/pushAffiliateCouponsToGhl.js
// One-off: pushes every existing LOCAL affiliate coupon to the tracked GHL locations
// (GLOBAL + MAIN). Coupons already present at a location (matched by code) are skipped,
// never modified. GHL-origin coupons are never pushed.
//
// Usage:
//   node scripts/pushAffiliateCouponsToGhl.js           (DRY RUN - prints the plan only)
//   node scripts/pushAffiliateCouponsToGhl.js --apply   (creates the missing coupons)
require('dotenv').config();
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');
const { pushCoupon, makeExistingCache } = require('../services/ghlCouponPush');

async function main() {
    const apply = process.argv.includes('--apply');
    const locations = ghlService.getTrackedLocations();
    if (locations.length === 0) {
        console.log('No GHL location is configured - nothing to do.');
        await pool.end();
        return;
    }
    console.log(`Locations: ${locations.map((l) => `${l.key}=${l.locationId}`).join(', ')}`);

    const coupons = (await couponStore.listCoupons({ type: 'affiliate' })).filter((c) => c.origin === 'local');
    const existingFor = makeExistingCache();
    const tally = {};

    for (const coupon of coupons) {
        const outcome = await pushCoupon(coupon, { dryRun: !apply, updateExisting: false, locations, existingFor });
        if (outcome.skipped) {
            console.log(`  SKIP ${coupon.code}: ${outcome.skipped}`);
            continue;
        }
        for (const r of outcome.results) {
            console.log(`  ${r.action.toUpperCase()} ${coupon.code} @ ${r.key}${r.error ? ` - ${r.error}` : ''}`);
            tally[r.action] = (tally[r.action] || 0) + 1;
        }
    }

    console.log(`\n${coupons.length} local affiliate coupon(s). Totals: ${JSON.stringify(tally)}`);
    if (!apply) console.log('Dry run only - no changes made. Re-run with --apply to push.');
    await pool.end();
}

module.exports = { main };

if (require.main === module) {
    main().catch((err) => {
        console.error('pushAffiliateCouponsToGhl failed:', err);
        process.exitCode = 1;
    });
}
