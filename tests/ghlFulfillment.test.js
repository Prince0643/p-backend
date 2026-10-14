require('./setupEnv');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ghlService = require('../services/ghlService');
const store = require('../utils/ghlFulfillmentStore');
const fulfillment = require('../services/ghlFulfillment');

const storeOriginals = {
    listEnabledRulesForProduct: store.listEnabledRulesForProduct,
    hasPriorSuccessfulEvent: store.hasPriorSuccessfulEvent,
    recordEvent: store.recordEvent
};
const ghlOriginals = {
    upsertContactInLocation: ghlService.upsertContactInLocation,
    addContactTags: ghlService.addContactTags,
    removeContactTags: ghlService.removeContactTags,
    updateContactCustomFields: ghlService.updateContactCustomFields
};

afterEach(() => {
    Object.assign(store, storeOriginals);
    Object.assign(ghlService, ghlOriginals);
});

test('test-mode payments still run configured GHL sub-account fulfillment', async () => {
    const calls = { rules: [], events: [], upserts: [], addTags: [], removeTags: [], fields: [] };
    const subAccount = { id: 'academy', name: 'Academy', locationId: 'loc_1', privateKey: 'pit_fake', active: true };

    store.listEnabledRulesForProduct = async (productId) => {
        calls.rules.push(productId);
        return [{
            productId,
            subAccountId: subAccount.id,
            subAccount,
            firstPaymentTags: ['course_availed'],
            renewalTags: ['course_renewed'],
            everyPaymentTags: ['paid_{{productId}}'],
            removeTags: ['course_expired'],
            customFields: [{ key: 'Payment Reference', fieldValue: '{{paymentReference}}' }]
        }];
    };
    store.hasPriorSuccessfulEvent = async () => false;
    store.recordEvent = async (event) => {
        calls.events.push(event);
        return event;
    };
    ghlService.upsertContactInLocation = async (account, contact) => {
        calls.upserts.push({ account, contact });
        return { contact: { id: 'contact_1' } };
    };
    ghlService.addContactTags = async (account, payload) => calls.addTags.push({ account, payload });
    ghlService.removeContactTags = async (account, payload) => calls.removeTags.push({ account, payload });
    ghlService.updateContactCustomFields = async (account, payload) => calls.fields.push({ account, payload });

    const result = await fulfillment.fulfillPayment({
        isTest: true,
        metadata: {
            productId: 'ghl_foundation',
            product: 'GHL Foundation Plan',
            paymentReference: 'PAYTEST123',
            email: 'buyer@example.com',
            fullName: 'Buyer Example',
            mobile: '+639171234567',
            source: 'paymongo'
        },
        paymentData: { id: 'pay_test_1', attributes: { amount: 100000, currency: 'PHP' } }
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(calls.rules, ['ghl_foundation']);
    assert.equal(calls.upserts.length, 1);
    assert.deepEqual(calls.upserts[0].contact.tags, ['paid_ghl_foundation', 'course_availed']);
    assert.deepEqual(calls.addTags[0].payload, { contactId: 'contact_1', tags: ['paid_ghl_foundation', 'course_availed'] });
    assert.deepEqual(calls.removeTags[0].payload, { contactId: 'contact_1', tags: ['course_expired'] });
    assert.deepEqual(calls.fields[0].payload, {
        contactId: 'contact_1',
        customFields: [{ key: 'Payment Reference', fieldValue: 'PAYTEST123' }]
    });
    assert.deepEqual(calls.events[0], {
        productId: 'ghl_foundation',
        subAccountId: 'academy',
        paymentReference: 'PAYTEST123',
        email: 'buyer@example.com',
        cycleType: 'availed',
        contactId: 'contact_1',
        status: 'succeeded'
    });
});
