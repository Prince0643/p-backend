// scripts/backfillGhlCouponOrders.js
// One-off full-history backfill of coupon-bearing GHL orders from BOTH tracked locations
// (GLOBAL + MAIN) into coupon_redemptions - the same logic as the scheduled import, but
// with no lookback window. Idempotent: orders already recorded are never re-inserted.
//
// Usage:
//   node scripts/backfillGhlCouponOrders.js           (DRY RUN - reads GHL, prints what would be inserted/created)
//   node scripts/backfillGhlCouponOrders.js --apply   (writes redemptions + auto-created coupons)
require('dotenv').config();
const pool = require('../db/pool');
const { importGlobalOrders } = require('../services/ghlOrderImport');

function printLocation(key, s, apply) {
    console.log(`\n[${key}] location ${s.locationId}`);
    console.log(`  scanned: ${s.scanned}`);
    console.log(`  skipped: noCoupon=${s.skipped.noCoupon} invoice=${s.skipped.invoice} test=${s.skipped.test}`);
    if (apply) console.log(`  inserted redemptions: ${s.imported} (no affiliate: ${s.unassigned})`);
    else console.log(`  would insert redemptions: ${s.wouldImport}`);
    console.log(`  refunds applied: released=${s.refunded} flagged=${s.flagged}`);
    console.log(`  coupons ${s.wouldCreateCoupons.length ? `that would be created: ${s.wouldCreateCoupons.join(', ')}` : `created: ${s.couponsCreated}`}`);
    for (const e of s.errors) console.log(`  ERROR: ${e}`);
}

async function main() {
    const apply = process.argv.includes('--apply');
    const summary = await importGlobalOrders({ backfill: true, dryRun: !apply });

    console.log(apply ? 'APPLY run (full history)' : 'DRY RUN (full history) - nothing is written');
    for (const [key, s] of Object.entries(summary.locations)) printLocation(key, s, apply);
    for (const e of summary.errors.filter((err) => !/^\[/.test(err))) console.log(`ERROR: ${e}`);

    if (!apply) console.log('\nDry run only - no changes made. Re-run with --apply to write.');
    await pool.end();
}

module.exports = { main };

if (require.main === module) {
    main().catch((err) => {
        console.error('backfillGhlCouponOrders failed:', err);
        process.exitCode = 1;
    });
}
