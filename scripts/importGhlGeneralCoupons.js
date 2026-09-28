// scripts/importGhlGeneralCoupons.js
// One-off migration script: mirrors ACTIVE, percentage-discount coupons that already
// exist in GHL locations (e.g. OCTFEST15, MICKA15) into our DB as type='general',
// local_enabled=false coupons, so the admin coupon list/GHL sync page has full
// visibility of them. Coupons already known to us (by code) are skipped, as are
// non-percentage discounts (reported, not imported).
//
// Usage:
//   node scripts/importGhlGeneralCoupons.js            (dry run - prints the plan only)
//   node scripts/importGhlGeneralCoupons.js --apply    (writes the coupons)
require('dotenv').config();
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');

async function main() {
    const apply = process.argv.includes('--apply');

    const [{ coupons: ghlCoupons, errors }, { rows: localCoupons }] = await Promise.all([
        ghlService.listCouponsAcrossLocations({ status: 'active' }),
        pool.query('SELECT code FROM coupons')
    ]);

    if (errors.length > 0) {
        console.log('Warning: some GHL locations failed to list coupons and were skipped:');
        for (const e of errors) console.log(`  ${e.locationName} (${e.locationId}): ${e.error}`);
    }

    const localCodes = new Set(localCoupons.map((r) => String(r.code).toUpperCase()));

    // Group GHL coupon entries by normalized code (the same code can exist in multiple locations).
    const byCode = new Map();
    for (const c of ghlCoupons) {
        const code = couponStore.toCouponCode(c.code);
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(c);
    }

    const toImport = [];
    const skipped = [];

    for (const [code, entries] of byCode.entries()) {
        if (localCodes.has(code)) {
            skipped.push({ code, reason: 'already exists in our DB' });
            continue;
        }

        const nonPercentage = entries.filter((e) => e.discountType && e.discountType !== 'percentage');
        if (nonPercentage.length > 0) {
            skipped.push({ code, reason: `non-percentage discountType ("${nonPercentage[0].discountType}") - not imported` });
            continue;
        }

        const first = entries[0];
        const discountPercent = Number(first.discountValue || 0) / 100;
        const expiresAt = first.endDate || null;
        const maxRedemptions = first.usageLimit || null;
        const ghlLocationIds = entries.map((e) => e.locationId);
        const ghlCouponMeta = {
            productIds: first.productIds || [],
            byLocation: entries.map((e) => ({ locationId: e.locationId, locationName: e.locationName, ghlCouponId: e.id }))
        };

        toImport.push({ code, name: first.name, discountPercent, expiresAt, maxRedemptions, ghlLocationIds, ghlCouponMeta });
    }

    console.log(`Plan: import ${toImport.length} coupon(s), skip ${skipped.length} coupon(s).\n`);
    for (const c of toImport) {
        console.log(
            `  IMPORT ${c.code}: discountPercent=${c.discountPercent}, locations=[${c.ghlLocationIds.join(', ')}], ` +
            `maxRedemptions=${c.maxRedemptions ?? 'none'}, expiresAt=${c.expiresAt ?? 'none'}`
        );
    }
    for (const s of skipped) {
        console.log(`  SKIP ${s.code}: ${s.reason}`);
    }

    if (!apply) {
        console.log('\nDry run only - no changes made. Re-run with --apply to write these coupons.');
        await pool.end();
        return;
    }

    for (const c of toImport) {
        await couponStore.upsertCoupon({
            code: c.code,
            type: 'general',
            discountPercent: c.discountPercent,
            active: true,
            localEnabled: false,
            expiresAt: c.expiresAt,
            maxRedemptions: c.maxRedemptions,
            ghlLocationIds: c.ghlLocationIds,
            ghlCouponMeta: c.ghlCouponMeta,
            notes: `Imported from GHL (${c.ghlLocationIds.join(', ')})`
        });
    }
    console.log(`\nImported ${toImport.length} coupon(s).`);
    await pool.end();
}

main().catch((err) => {
    console.error('importGhlGeneralCoupons failed:', err);
    process.exitCode = 1;
});
