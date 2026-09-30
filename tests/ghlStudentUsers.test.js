require('./setupEnv');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index');
const pool = require('../db/pool');
const ghlService = require('../services/ghlService');
const webhookService = require('../services/webhookService');
const students = require('../services/ghlStudentUsers');
const template = require('../services/ghlStudentUserTemplate');
const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const { signWebhookBody, paymentEventPayload } = require('./fixtures');

const LOCATION_ID = 'v2W0eRHua65rErE7Jsw2';
const COMPANY_ID = 'hv6XwC1sqbvEgneGm5AY';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

const originalCreateClient = ghlService.createClient;
const originalSend = webhookService.sendToLeadConnector;
const originalLog = console.log;
const originalEnv = {};
const ENV = {
    GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS: LOCATION_ID,
    GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS: 'pit_test_students',
    GHL_STUDENTS_COMPANY_ID: '',
    GHL_STUDENT_USER_PRODUCTS: ''
};

let calls; // { gets: [], posts: [] }
let sent; // webhook payloads
let logs;
let existingUsers;
let postBehavior;
const refs = [];

function ref(suffix) {
    const r = `GSU${Date.now()}${suffix}`;
    refs.push(r);
    return r;
}

beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { originalEnv[k] = process.env[k]; process.env[k] = v; }
    calls = { gets: [], posts: [] };
    sent = [];
    logs = [];
    existingUsers = [];
    postBehavior = (body) => ({ data: { id: `ghluser_${Math.random().toString(36).slice(2, 8)}`, email: body.email } });
    ghlService.createClient = () => ({
        get: async (url, opts) => {
            calls.gets.push({ url, opts });
            if (url === '/users/') return { data: { users: existingUsers } };
            return { data: { users: [] } };
        },
        post: async (url, body) => {
            calls.posts.push({ url, body });
            return postBehavior(body);
        }
    });
    webhookService.sendToLeadConnector = async (data) => { sent.push(data); };
    console.log = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
});

afterEach(async () => {
    console.log = originalLog;
    ghlService.createClient = originalCreateClient;
    webhookService.sendToLeadConnector = originalSend;
    for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
    const r = refs.splice(0);
    if (r.length) await pool.query('DELETE FROM ghl_student_users WHERE payment_reference = ANY($1)', [r]);
});

after(async () => {
    await pool.end();
});

async function pay(productId, { paymentReference, email = 'Jane.Doe@Example.com', fullName = 'Jane Mary Doe' } = {}) {
    const payload = paymentEventPayload('payment.paid', { paymentReference, email, fullName, productId, product: productId });
    const { body, header } = signWebhookBody(payload);
    return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('Paymongo-Signature', header).send(body);
}

const dbRow = async (r) => (await pool.query('SELECT * FROM ghl_student_users WHERE payment_reference = $1', [r])).rows[0];
const paidWebhook = () => sent.find((d) => d.status === 'payment_successful');

for (const productId of ['ghl_practice_access', 'ghl_premium_plan']) {
    test(`paid ${productId} creates the GHL user with the exact template payload`, async () => {
        const r = ref(productId.slice(4, 8));
        const res = await pay(productId, { paymentReference: r });
        assert.equal(res.status, 200);

        assert.equal(calls.posts.length, 1);
        const { url, body } = calls.posts[0];
        assert.equal(url, '/users/');
        const { password, ...rest } = body;
        assert.deepEqual(rest, {
            companyId: COMPANY_ID,
            firstName: 'Jane Mary',
            lastName: 'Doe',
            email: 'jane.doe@example.com',
            type: 'account',
            role: 'admin',
            locationIds: [LOCATION_ID],
            permissions: template.PERMISSIONS,
            scopes: template.SCOPES,
            scopesAssignedToOnly: ['contacts.write', 'opportunities.write']
        });
        assert.ok(password && password.length >= 12);

        const account = paidWebhook().ghlStudentAccount;
        assert.deepEqual(account, { email: 'jane.doe@example.com', password, loginUrl: 'https://app.gohighlevel.com/', status: 'created' });

        const row = await dbRow(r);
        assert.equal(row.status, 'created');
        assert.equal(row.product_id, productId);
        assert.match(row.ghl_user_id, /^ghluser_/);
    });
}

test('other products do nothing', async () => {
    const r = ref('other');
    const res = await pay('test_product', { paymentReference: r });
    assert.equal(res.status, 200);
    assert.equal(calls.posts.length, 0);
    assert.equal(calls.gets.length, 0);
    assert.equal(paidWebhook().ghlStudentAccount, undefined);
    assert.equal(await dbRow(r), undefined);
});

test('GHL_STUDENT_USER_PRODUCTS overrides the product list', async () => {
    process.env.GHL_STUDENT_USER_PRODUCTS = 'test_product';
    const r = ref('env');
    await pay('test_product', { paymentReference: r });
    assert.equal(calls.posts.length, 1);
    process.env.GHL_STUDENT_USER_PRODUCTS = '';
});

test('an existing user (case-insensitive) is recorded as existing with no create call', async () => {
    existingUsers = [{ id: 'ghluser_existing', email: 'JANE.DOE@example.COM' }];
    const r = ref('exist');
    await pay('ghl_premium_plan', { paymentReference: r });
    assert.equal(calls.posts.length, 0);
    assert.deepEqual(paidWebhook().ghlStudentAccount, { email: 'jane.doe@example.com', loginUrl: 'https://app.gohighlevel.com/', status: 'existing' });
    const row = await dbRow(r);
    assert.equal(row.status, 'existing');
    assert.equal(row.ghl_user_id, 'ghluser_existing');
});

test('a repeated webhook for the same payment does not create twice', async () => {
    const r = ref('repeat');
    await pay('ghl_practice_access', { paymentReference: r });
    await pay('ghl_practice_access', { paymentReference: r });
    assert.equal(calls.posts.length, 1);
    const paid = sent.filter((d) => d.status === 'payment_successful');
    assert.equal(paid.length, 2);
    assert.equal(paid[1].ghlStudentAccount.status, 'created');
    assert.equal(paid[1].ghlStudentAccount.password, undefined, 'repeat delivery must not carry a password');
    const { rows } = await pool.query('SELECT 1 FROM ghl_student_users WHERE payment_reference = $1', [r]);
    assert.equal(rows.length, 1);
});

test('a GHL error yields failed, the payment still succeeds and the webhook says failed', async () => {
    postBehavior = () => { const e = new Error('Request failed'); e.response = { status: 422, data: { message: 'email already in use elsewhere' } }; throw e; };
    const r = ref('fail');
    const res = await pay('ghl_practice_access', { paymentReference: r });
    assert.equal(res.status, 200);
    assert.deepEqual(paidWebhook().ghlStudentAccount, { email: 'jane.doe@example.com', loginUrl: 'https://app.gohighlevel.com/', status: 'failed' });
    const row = await dbRow(r);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /422.*already in use/);
    assert.equal(row.attempts, 1);
});

test('a missing GHL configuration is recorded as failed', async () => {
    process.env.GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS = '';
    const r = ref('nocfg');
    await pay('ghl_practice_access', { paymentReference: r });
    assert.equal(paidWebhook().ghlStudentAccount.status, 'failed');
    assert.match((await dbRow(r)).error, /not configured/);
});

test('retry recreates a failed user with a new password and sends the follow-up webhook', async () => {
    let fail = true;
    postBehavior = (body) => {
        if (fail) { const e = new Error('boom'); e.response = { status: 500, data: { message: 'server down' } }; throw e; }
        return { data: { id: 'ghluser_retry', email: body.email } };
    };
    const r = ref('retry');
    await pay('ghl_premium_plan', { paymentReference: r });
    const firstPassword = calls.posts[0].body.password;
    assert.equal((await dbRow(r)).status, 'failed');

    // Too recent: nothing to retry with the default 5 minute age gate.
    assert.equal((await students.retryFailed()).attempted, 0);

    fail = false;
    sent.length = 0;
    const summary = await students.retryFailed({ minAgeMinutes: 0 });
    assert.deepEqual(summary, { attempted: 1, created: 1, existing: 0, failed: 0 });
    const secondPassword = calls.posts[1].body.password;
    assert.notEqual(secondPassword, firstPassword);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'ghl_student_account_created');
    assert.equal(sent[0].paymentReference, r);
    assert.deepEqual(sent[0].ghlStudentAccount, { email: 'jane.doe@example.com', password: secondPassword, loginUrl: 'https://app.gohighlevel.com/', status: 'created' });
    const row = await dbRow(r);
    assert.equal(row.status, 'created');
    assert.equal(row.attempts, 2);
    assert.equal(row.ghl_user_id, 'ghluser_retry');
    assert.equal(row.error, null);
});

test('retry stops after 5 attempts', async () => {
    postBehavior = () => { throw new Error('still down'); };
    const r = ref('max');
    await pay('ghl_practice_access', { paymentReference: r });
    for (let i = 0; i < 6; i++) await students.retryFailed({ minAgeMinutes: 0 });
    const row = await dbRow(r);
    assert.equal(row.attempts, 5);
    assert.equal(row.status, 'failed');
    assert.equal(calls.posts.length, 5);
});

test('generated passwords are strong and unique', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const p = students.generatePassword();
        assert.ok(p.length >= 12 && p.length === 16);
        assert.match(p, /[A-Z]/);
        assert.match(p, /[a-z]/);
        assert.match(p, /[0-9]/);
        assert.match(p, /[^A-Za-z0-9]/);
        seen.add(p);
    }
    assert.equal(seen.size, 500);
});

test('name splitting satisfies GHL non-empty first/last name', () => {
    assert.deepEqual(students.splitName('Cher'), { firstName: 'Cher', lastName: 'Student' });
    assert.deepEqual(students.splitName('  Ana  de la Cruz '), { firstName: 'Ana de la', lastName: 'Cruz' });
    assert.deepEqual(students.splitName('', 'kim@example.com'), { firstName: 'kim', lastName: 'Student' });
});

test('the password never appears in logs or DB rows', async () => {
    const r = ref('leak');
    await pay('ghl_practice_access', { paymentReference: r });
    const password = calls.posts[0].body.password;
    assert.ok(password);
    assert.equal(paidWebhook().ghlStudentAccount.password, password);
    assert.ok(!logs.join('\n').includes(password), 'password found in logs');
    const all = await pool.query('SELECT t::text AS row FROM ghl_student_users t WHERE payment_reference = $1', [r]);
    assert.ok(!all.rows[0].row.includes(password), 'password found in DB row');

    // Also when GHL echoes the password back inside an error message.
    postBehavior = (body) => { const e = new Error('bad'); e.response = { status: 400, data: { message: `invalid ${body.password}` } }; throw e; };
    const r2 = ref('leak2');
    await pay('ghl_practice_access', { paymentReference: r2, email: 'other@example.com' });
    const p2 = calls.posts[1].body.password;
    const row2 = await dbRow(r2);
    assert.ok(!row2.error.includes(p2));
    assert.ok(!logs.join('\n').includes(p2));
});

test('admin endpoint lists rows and the Solutions audit returns the student record', async () => {
    const r = ref('admin');
    await pay('ghl_practice_access', { paymentReference: r });
    const list = await request(app).get('/api/admin/ghl-student-users?status=created&email=jane.doe@example.com').set('x-api-key', ADMIN_KEY);
    assert.equal(list.status, 200);
    assert.ok(list.body.students.some((s) => s.paymentReference === r && s.status === 'created'));
    assert.ok(!JSON.stringify(list.body).includes(calls.posts[0].body.password));
    const noAuth = await request(app).get('/api/admin/ghl-student-users');
    assert.equal(noAuth.status, 401);

    // The Solutions audit endpoint attaches the record for student-account products. test_product is
    // the seeded catalog row, so point the product list at it for this part.
    process.env.GHL_STUDENT_USER_PRODUCTS = 'test_product';
    await pool.query('UPDATE ghl_student_users SET product_id = $2 WHERE payment_reference = $1', [r, 'test_product']);
    await digitalSolutionsStore.recordTransaction({
        type: 'academy_product', transactionId: r, customerEmail: 'jane.doe@example.com', customerName: 'Jane',
        productId: 'test_product', productName: 'Test Product', amount: 500, status: 'paid'
    });
    try {
        const detail = await request(app).get(`/api/admin/solutions/${r}`).set('x-api-key', ADMIN_KEY);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.ghlStudentUser.status, 'created');
        assert.equal(detail.body.ghlStudentUser.paymentReference, r);
    } finally {
        await pool.query('DELETE FROM digital_solutions_transactions WHERE transaction_id = $1', [r]);
    }
});
