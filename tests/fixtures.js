// tests/fixtures.js
const crypto = require('crypto');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');

const COUPON_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 6-char random code (matches the production 6-character coupon code limit). */
function testCouponCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += COUPON_CODE_CHARS[Math.floor(Math.random() * COUPON_CODE_CHARS.length)];
    }
    return code;
}

async function createTestCoupon(overrides = {}) {
    const code = overrides.code || testCouponCode();
    await couponStore.upsertCoupon({
        discountPercent: 0.15,
        affiliateFeePercent: 0.10,
        active: true,
        maxRedemptions: null,
        productIds: [],
        notes: 'created by automated test suite',
        ...overrides,
        code
    });
    return code;
}

/** Deletes a test coupon and everything referencing it (FK order matters). */
async function cleanupCoupon(code) {
    await pool.query('DELETE FROM digital_solutions_transactions WHERE promo_code = $1', [code]);
    await pool.query('DELETE FROM coupon_redemptions WHERE code = $1', [code]);
    await pool.query('DELETE FROM coupons WHERE code = $1', [code]);
}

async function cleanupAffiliate(email) {
    const { rows } = await pool.query('SELECT coupon_code FROM affiliates WHERE email = $1', [email]);
    // affiliates.coupon_code references coupons(code), so the affiliate row must go first.
    await pool.query('DELETE FROM affiliates WHERE email = $1', [email]);
    for (const row of rows) {
        if (row.coupon_code) await cleanupCoupon(row.coupon_code);
    }
}

function signWebhookBody(bodyObj, { secret = process.env.PAYMONGO_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const body = JSON.stringify(bodyObj);
    const signedPayload = `${timestamp}.${body}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return { body, header: `t=${timestamp},te=${signature}` };
}

function paymentEventPayload(type, metadata, { amountCentavos = 100000 } = {}) {
    return {
        data: {
            attributes: {
                type,
                data: {
                    id: `pay_test_${Math.random().toString(36).slice(2, 8)}`,
                    attributes: {
                        amount: amountCentavos,
                        currency: 'PHP',
                        metadata
                    }
                }
            }
        }
    };
}

module.exports = {
    testCouponCode,
    createTestCoupon,
    cleanupCoupon,
    cleanupAffiliate,
    signWebhookBody,
    paymentEventPayload
};
