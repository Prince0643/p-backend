// tests/fixtures.js
const crypto = require('crypto');
const pool = require('../db/pool');
const couponStore = require('../utils/couponStore');
const campaignSiteStore = require('../utils/campaignSiteStore');

const COUPON_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 6-char random code, well under the production coupon code length cap (50 chars). */
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

/** Creates a test campaign site (defaults: local channel, unique https url). Returns the site. */
async function createTestCampaignSite(overrides = {}) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const site = await campaignSiteStore.createSite({
        name: `Test Site ${suffix}`,
        url: `https://test-site-${suffix}.example.com`,
        channel: 'local',
        active: true,
        products: [],
        ...overrides
    });
    return site;
}

async function cleanupCampaignSite(id) {
    if (!id) return;
    await pool.query('DELETE FROM campaign_sites WHERE id = $1', [id]);
}

async function cleanupAffiliate(email) {
    const { rows } = await pool.query('SELECT coupon_code FROM affiliates WHERE email = $1', [email]);
    // affiliates.coupon_code references coupons(code), so the affiliate row must go first.
    await pool.query('DELETE FROM affiliates WHERE email = $1', [email]);
    for (const row of rows) {
        if (row.coupon_code) await cleanupCoupon(row.coupon_code);
    }
}

// PayMongo header format: live events populate `li` (te empty); test events populate `te` (li empty).
// `mode` picks which slot is populated and (unless `secret` is given) which webhook secret signs it.
function signWebhookBody(bodyObj, { mode = 'live', secret, timestamp = Math.floor(Date.now() / 1000) } = {}) {
    const signingSecret = secret || (mode === 'test' ? process.env.PAYMONGO_TEST_WEBHOOK_SECRET : process.env.PAYMONGO_WEBHOOK_SECRET);
    const body = JSON.stringify(bodyObj);
    const signedPayload = `${timestamp}.${body}`;
    const signature = crypto.createHmac('sha256', signingSecret).update(signedPayload).digest('hex');
    return { body, header: mode === 'test' ? `t=${timestamp},te=${signature},li=` : `t=${timestamp},te=,li=${signature}` };
}

function paymentEventPayload(type, metadata, { amountCentavos = 100000, livemode = true } = {}) {
    return {
        data: {
            attributes: {
                type,
                livemode,
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
    createTestCampaignSite,
    cleanupCampaignSite,
    cleanupAffiliate,
    signWebhookBody,
    paymentEventPayload
};
