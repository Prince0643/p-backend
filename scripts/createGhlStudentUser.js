// scripts/createGhlStudentUser.js
// Manually create (or retry) the GHL student user for a payment, or for an arbitrary email + name,
// in the Nexistry Academy (Students) sub-account.
//
// Usage:
//   node scripts/createGhlStudentUser.js --payment-ref PAY123              (DRY RUN - prints the payload, password masked)
//   node scripts/createGhlStudentUser.js --email a@b.com --name "Ann Bee"  (DRY RUN)
//   ... --apply                    creates the user in GHL, updates ghl_student_users, and for a payment
//                                  reference sends the follow-up LeadConnector webhook with the credentials
//   ... --apply --print-password   also prints the password to the terminal (otherwise it is not shown anywhere)
//   --product ID                   product id to record (email/name mode; default ghl_practice_access)
require('dotenv').config();
const pool = require('../db/pool');
const store = require('../utils/ghlStudentUserStore');
const students = require('../services/ghlStudentUsers');
const webhookService = require('../services/webhookService');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
}

async function resolveTarget() {
    const paymentReference = arg('payment-ref');
    if (paymentReference) {
        let record = await store.findByPaymentReference(paymentReference);
        if (!record) {
            const { rows } = await pool.query(
                'SELECT customer_email, customer_name, product_id FROM digital_solutions_transactions WHERE transaction_id = $1',
                [paymentReference]
            );
            if (!rows[0]) throw new Error(`No ghl_student_users row or transaction found for ${paymentReference}`);
            record = { paymentReference, email: rows[0].customer_email, fullName: rows[0].customer_name, productId: rows[0].product_id, attempts: 0, status: null };
        }
        return record;
    }
    const email = arg('email');
    const name = arg('name');
    if (!email || !name) throw new Error('Pass --payment-ref REF, or --email and --name');
    return { paymentReference: `manual:${String(email).toLowerCase()}`, email, fullName: name, productId: arg('product') || 'ghl_practice_access', attempts: 0, status: null };
}

async function main() {
    const apply = process.argv.includes('--apply');
    const printPassword = process.argv.includes('--print-password');
    const target = await resolveTarget();
    const cfg = students.getConfig();

    console.log(apply ? 'APPLY run' : 'DRY RUN - nothing is written and GHL is not called');
    console.log(`Payment reference: ${target.paymentReference} (existing status: ${target.status || 'none'})`);
    console.log('Payload that would be sent (password masked):');
    console.log(JSON.stringify(students.buildUserPayload({ email: target.email, fullName: target.fullName, password: '********' }), null, 2));
    if (!cfg.locationId || !cfg.privateKey) console.log('WARNING: GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS / GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS are not set');
    if (!apply) return;

    if (target.status === 'created') throw new Error('Already created for this payment reference; refusing to create again');

    const { record } = await store.claim({ paymentReference: target.paymentReference, email: String(target.email).toLowerCase(), fullName: target.fullName, productId: target.productId });
    if (target.attempts > 0 || record.attempts > 1) await store.beginManualAttempt(target.paymentReference);
    else await store.markResult(target.paymentReference, { status: 'pending' });

    const result = await students.createOrFind({ email: target.email, fullName: target.fullName });
    await store.markResult(target.paymentReference, { status: result.status, ghlUserId: result.ghlUserId, error: result.error || null });
    console.log(`Result: ${result.status}${result.ghlUserId ? ` (GHL user ${result.ghlUserId})` : ''}${result.error ? ` - ${result.error}` : ''}`);

    if (result.status === 'created') {
        if (!target.paymentReference.startsWith('manual:')) {
            await webhookService.sendToLeadConnector({
                event: 'ghl_student_account_created',
                paymentReference: target.paymentReference,
                productId: target.productId,
                fullName: target.fullName,
                email: String(target.email).toLowerCase(),
                ghlStudentAccount: { email: String(target.email).toLowerCase(), password: result.password, loginUrl: students.LOGIN_URL, status: 'created' },
                completedAt: new Date().toISOString()
            }).then(() => console.log('Follow-up LeadConnector webhook sent'))
                .catch((err) => console.log('Follow-up LeadConnector webhook failed:', err.message));
        }
        if (printPassword || target.paymentReference.startsWith('manual:')) {
            console.log(`Password (shown once, not stored): ${result.password}`);
        }
    }
}

main()
    .catch((err) => { console.error('Failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
