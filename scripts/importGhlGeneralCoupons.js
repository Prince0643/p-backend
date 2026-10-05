// scripts/importGhlGeneralCoupons.js
// One-off migration script: mirrors ACTIVE, percentage-discount coupons that already
// exist in GHL locations (e.g. OCTFEST15, MICKA15) into our DB as type='general',
// local_enabled=false coupons, so the admin coupon list/GHL sync page has full
// visibility of them. Coupons already known to us (by code) are skipped, as are
// non-percentage discounts (reported, not imported).
//
// Usage:
//   node scripts/importGhlGeneralCoupons.js                      (dry run - prints the plan only)
//   node scripts/importGhlGeneralCoupons.js --apply               (writes the coupons)
//   node scripts/importGhlGeneralCoupons.js --only=CODE1,CODE2    (only consider these codes; dry run)
//   node scripts/importGhlGeneralCoupons.js --only=CODE1 --apply  (only import/skip these codes)
//
// --only limits which GHL coupons are considered at all - every other GHL coupon is
// rolled up into a single "ignored" summary line instead of being listed individually.
// Codes are matched case-insensitively and normalized the same way coupon codes are
// stored (see couponStore.toCouponCode). If a --only code isn't found among the GHL
// coupons, a warning is printed.
require('dotenv').config();
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const couponStore = require('../utils/couponStore');

/** Parses --only=CODE1,CODE2 from argv into a normalized Set of codes, or null if absent. */
function parseOnlyArg(argv) {
    const prefix = '--only=';
    const arg = argv.find((a) => a.startsWith(prefix));
    if (!arg) return null;
    const codes = arg
        .slice(prefix.length)
        .split(',')
        .map((c) => couponStore.toCouponCode(c))
        .filter(Boolean);
    return new Set(codes);
}

/**
 * Pure planning step: groups GHL coupon entries by normalized code, decides which to
 * import vs skip, and (when onlyCodes is given) tallies everything outside that set as
 * "ignored" instead of listing it individually.
 */
function buildImportPlan({ ghlCoupons, localCodes, onlyCodes = null }) {
    const byCode = new Map();
    for (const c of ghlCoupons) {
        const code = couponStore.toCouponCode(c.code);
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(c);
    }

    const toImport = [];
    const skipped = [];
    let ignoredNotInOnly = 0;

    for (const [code, entries] of byCode.entries()) {
        if (onlyCodes && !onlyCodes.has(code)) {
            ignoredNotInOnly += 1;
            continue;
        }

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
        // GHL only has a boolean limitPerCustomer: true -> 1 use per customer, otherwise unlimited.
        const limitPerCustomer = Boolean(first.limitPerCustomer);
        const maxRedemptionsPerCustomer = limitPerCustomer ? 1 : null;
        const ghlCouponMeta = {
            limitPerCustomer,
            productIds: first.productIds || [],
            byLocation: entries.map((e) => ({ locationId: e.locationId, locationName: e.locationName, ghlCouponId: e.id }))
        };

        toImport.push({ code, name: first.name, discountPercent, expiresAt, maxRedemptions, maxRedemptionsPerCustomer, ghlLocationIds, ghlCouponMeta });
    }

    let notFoundOnlyCodes = [];
    if (onlyCodes) {
        notFoundOnlyCodes = [...onlyCodes].filter((code) => !byCode.has(code));
    }

    return { toImport, skipped, ignoredNotInOnly, notFoundOnlyCodes };
}

async function main() {
    const apply = process.argv.includes('--apply');
    const onlyCodes = parseOnlyArg(process.argv);

    const [{ coupons: ghlCoupons, errors }, { rows: localCoupons }] = await Promise.all([
        ghlService.listCouponsAcrossLocations({ status: 'active' }),
        pool.query('SELECT code FROM coupons')
    ]);

    if (errors.length > 0) {
        console.log('Warning: some GHL locations failed to list coupons and were skipped:');
        for (const e of errors) console.log(`  ${e.locationName} (${e.locationId}): ${e.error}`);
    }

    const localCodes = new Set(localCoupons.map((r) => String(r.code).toUpperCase()));

    const { toImport, skipped, ignoredNotInOnly, notFoundOnlyCodes } = buildImportPlan({ ghlCoupons, localCodes, onlyCodes });

    for (const code of notFoundOnlyCodes) {
        console.log(`Warning: --only code not found in GHL: ${code}`);
    }

    console.log(`Plan: import ${toImport.length} coupon(s), skip ${skipped.length} coupon(s).\n`);
    for (const c of toImport) {
        console.log(
            `  IMPORT ${c.code}: discountPercent=${c.discountPercent}, locations=[${c.ghlLocationIds.join(', ')}], ` +
            `maxRedemptions=${c.maxRedemptions ?? 'none'}, perCustomer=${c.maxRedemptionsPerCustomer ?? 'unlimited'}, expiresAt=${c.expiresAt ?? 'none'}`
        );
    }
    for (const s of skipped) {
        console.log(`  SKIP ${s.code}: ${s.reason}`);
    }
    if (onlyCodes) {
        console.log(`  ignored ${ignoredNotInOnly} coupon(s) not in --only`);
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
            maxRedemptionsPerCustomer: c.maxRedemptionsPerCustomer,
            ghlLocationIds: c.ghlLocationIds,
            ghlCouponMeta: c.ghlCouponMeta,
            notes: `Imported from GHL (${c.ghlLocationIds.join(', ')})`
        });
    }
    console.log(`\nImported ${toImport.length} coupon(s).`);
    await pool.end();
}

module.exports = { parseOnlyArg, buildImportPlan, main };

if (require.main === module) {
    main().catch((err) => {
        console.error('importGhlGeneralCoupons failed:', err);
        process.exitCode = 1;
    });
}
