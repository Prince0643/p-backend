require('./setupEnv');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const { parseOnlyArg, buildImportPlan, main } = require('../scripts/importGhlGeneralCoupons');
const { cleanupCoupon } = require('./fixtures');

after(async () => {
    await pool.end();
});

test('parseOnlyArg returns null when --only is absent', () => {
    assert.equal(parseOnlyArg(['node', 'script.js', '--apply']), null);
});

test('parseOnlyArg normalizes codes case-insensitively like couponStore.toCouponCode', () => {
    const only = parseOnlyArg(['node', 'script.js', '--only=abc123,Foo-Bar, baz']);
    assert.deepEqual([...only].sort(), ['ABC123', 'BAZ', 'FOO-BAR']);
});

test('buildImportPlan considers every GHL coupon when onlyCodes is null', () => {
    const ghlCoupons = [
        { code: 'AAA', discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' },
        { code: 'BBB', discountType: 'percentage', discountValue: 20, locationId: 'loc1', locationName: 'Loc1' }
    ];
    const plan = buildImportPlan({ ghlCoupons, localCodes: new Set(), onlyCodes: null });
    assert.equal(plan.toImport.length, 2);
    assert.equal(plan.ignoredNotInOnly, 0);
    assert.deepEqual(plan.notFoundOnlyCodes, []);
});

test('buildImportPlan with --only considers only listed codes and tallies the rest as ignored', () => {
    const ghlCoupons = [
        { code: 'AAA', discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' },
        { code: 'BBB', discountType: 'percentage', discountValue: 20, locationId: 'loc1', locationName: 'Loc1' },
        { code: 'CCC', discountType: 'percentage', discountValue: 30, locationId: 'loc1', locationName: 'Loc1' }
    ];
    const onlyCodes = new Set(['AAA', 'CCC']);
    const plan = buildImportPlan({ ghlCoupons, localCodes: new Set(), onlyCodes });

    assert.deepEqual(plan.toImport.map((c) => c.code).sort(), ['AAA', 'CCC']);
    assert.equal(plan.ignoredNotInOnly, 1); // BBB
    assert.deepEqual(plan.notFoundOnlyCodes, []);
});

test('buildImportPlan still applies existing skip rules (already local, non-percentage) to --only codes', () => {
    const ghlCoupons = [
        { code: 'AAA', discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' },
        { code: 'FIXED1', discountType: 'fixed', discountValue: 5, locationId: 'loc1', locationName: 'Loc1' }
    ];
    const onlyCodes = new Set(['AAA', 'FIXED1']);
    const plan = buildImportPlan({ ghlCoupons, localCodes: new Set(['AAA']), onlyCodes });

    assert.equal(plan.toImport.length, 0);
    assert.equal(plan.skipped.length, 2);
    assert.ok(plan.skipped.find((s) => s.code === 'AAA' && /already exists/.test(s.reason)));
    assert.ok(plan.skipped.find((s) => s.code === 'FIXED1' && /non-percentage/.test(s.reason)));
});

test('buildImportPlan reports --only codes that were not found in GHL', () => {
    const ghlCoupons = [
        { code: 'AAA', discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' }
    ];
    const onlyCodes = new Set(['AAA', 'MISSING1']);
    const plan = buildImportPlan({ ghlCoupons, localCodes: new Set(), onlyCodes });
    assert.deepEqual(plan.notFoundOnlyCodes, ['MISSING1']);
});

test('main --only dry run does not write to the database', async () => {
    const codeA = `TIONLYA${Date.now()}`.slice(0, 20);
    const codeB = `TIONLYB${Date.now()}`.slice(0, 20);

    const originalListCoupons = ghlService.listCouponsAcrossLocations;
    const originalArgv = process.argv;
    const originalEnd = pool.end;

    ghlService.listCouponsAcrossLocations = async () => ({
        coupons: [
            { code: codeA, discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' },
            { code: codeB, discountType: 'percentage', discountValue: 20, locationId: 'loc1', locationName: 'Loc1' }
        ],
        errors: []
    });
    pool.end = async () => {};
    process.argv = ['node', 'script.js', `--only=${codeA}`];

    try {
        await main();
        const { rows } = await pool.query('SELECT code FROM coupons WHERE code IN ($1, $2)', [codeA, codeB]);
        assert.equal(rows.length, 0, 'dry run must not write any coupons');
    } finally {
        ghlService.listCouponsAcrossLocations = originalListCoupons;
        process.argv = originalArgv;
        pool.end = originalEnd;
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});

test('main --apply --only writes only the listed codes', async () => {
    const codeA = `TIAPPLYA${Date.now()}`.slice(0, 20);
    const codeB = `TIAPPLYB${Date.now()}`.slice(0, 20);

    const originalListCoupons = ghlService.listCouponsAcrossLocations;
    const originalArgv = process.argv;
    const originalEnd = pool.end;

    ghlService.listCouponsAcrossLocations = async () => ({
        coupons: [
            { code: codeA, discountType: 'percentage', discountValue: 10, locationId: 'loc1', locationName: 'Loc1' },
            { code: codeB, discountType: 'percentage', discountValue: 20, locationId: 'loc1', locationName: 'Loc1' }
        ],
        errors: []
    });
    pool.end = async () => {};
    process.argv = ['node', 'script.js', '--apply', `--only=${codeA}`];

    try {
        await main();

        const { rows: importedRows } = await pool.query('SELECT code, type, discount_percent FROM coupons WHERE code = $1', [codeA]);
        assert.equal(importedRows.length, 1);
        assert.equal(importedRows[0].type, 'general');
        assert.equal(Number(importedRows[0].discount_percent), 0.10);

        const { rows: ignoredRows } = await pool.query('SELECT code FROM coupons WHERE code = $1', [codeB]);
        assert.equal(ignoredRows.length, 0, 'coupon not in --only must not be imported');
    } finally {
        ghlService.listCouponsAcrossLocations = originalListCoupons;
        process.argv = originalArgv;
        pool.end = originalEnd;
        await cleanupCoupon(codeA);
        await cleanupCoupon(codeB);
    }
});
