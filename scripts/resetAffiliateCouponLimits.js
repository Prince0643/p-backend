// scripts/resetAffiliateCouponLimits.js
// One-off migration script: affiliate coupons used to be created with maxRedemptions:1
// (one-time-use). The business rule is now that affiliate codes have NO total usage
// cap - only a per-customer-once rule enforced separately at checkout. This clears
// max_redemptions on every existing type='affiliate' coupon.
//
// Usage:
//   node scripts/resetAffiliateCouponLimits.js            (dry run - prints the plan only)
//   node scripts/resetAffiliateCouponLimits.js --apply    (writes the change)
require('dotenv').config();
const pool = require('../db/pool');

async function main() {
    const apply = process.argv.includes('--apply');

    const { rows } = await pool.query(
        `SELECT code, max_redemptions FROM coupons WHERE type = 'affiliate' AND max_redemptions IS NOT NULL ORDER BY code ASC`
    );

    console.log(`Found ${rows.length} affiliate coupon(s) with a max_redemptions cap:`);
    for (const row of rows) {
        console.log(`  ${row.code}: max_redemptions=${row.max_redemptions} -> NULL (unlimited)`);
    }

    if (!apply) {
        console.log('\nDry run only - no changes made. Re-run with --apply to update the database.');
        await pool.end();
        return;
    }

    const { rowCount } = await pool.query(
        `UPDATE coupons SET max_redemptions = NULL, updated_at = now() WHERE type = 'affiliate' AND max_redemptions IS NOT NULL`
    );
    console.log(`\nUpdated ${rowCount} affiliate coupon(s): max_redemptions set to NULL (unlimited).`);
    await pool.end();
}

main().catch((err) => {
    console.error('resetAffiliateCouponLimits failed:', err);
    process.exitCode = 1;
});
