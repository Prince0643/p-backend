const ghlService = require('./ghlService');
const store = require('../utils/ghlFulfillmentStore');

const PAYMONGO_CUSTOM_FIELDS = [
    { key: 'nxacademy_product', name: 'NXAcademy Product', dataType: 'TEXT' },
    { key: 'paymongo_product_id', name: 'PayMongo Product ID', dataType: 'TEXT' },
    { key: 'paymongo_reference', name: 'PayMongo Reference', dataType: 'TEXT' },
    { key: 'paymongo_payment_id', name: 'PayMongo Payment ID', dataType: 'TEXT' },
    { key: 'paymongo_amount', name: 'PayMongo Amount', dataType: 'TEXT' },
    { key: 'paymongo_currency', name: 'PayMongo Currency', dataType: 'TEXT' },
    { key: 'paymongo_cycle_type', name: 'PayMongo Cycle Type', dataType: 'TEXT' },
    { key: 'paymongo_paid_at', name: 'PayMongo Paid At', dataType: 'TEXT' }
];

function contactIdFromUpsert(result) {
    return result?.contact?.id || result?.id || result?.contactId || result?.contact?._id || null;
}

function tokenContext({ metadata, paymentData, cycleType }) {
    const amountCentavos = Number(paymentData?.attributes?.amount);
    const amount = Number.isFinite(amountCentavos) ? Number((amountCentavos / 100).toFixed(2)) : '';
    return {
        cycleType,
        fullName: metadata.fullName || '',
        email: metadata.email || '',
        mobile: metadata.mobile || '',
        product: metadata.product || '',
        productId: metadata.productId || '',
        paymentReference: metadata.paymentReference || '',
        paymentId: paymentData?.id || '',
        paymentMethod: metadata.paymentMethod || '',
        source: metadata.source || '',
        promoCode: metadata.promoCode || '',
        totalAmount: metadata.totalAmount || (amount !== '' ? String(amount) : ''),
        baseAmount: metadata.baseAmount || '',
        discountAmount: metadata.discountAmount || '',
        taxAmount: metadata.taxAmount || '',
        currency: paymentData?.attributes?.currency || 'PHP',
        paidAt: new Date().toISOString()
    };
}

function resolveTemplate(value, context) {
    return String(value ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        return context[key] != null ? String(context[key]) : '';
    });
}

function resolveCustomFields(fields, context) {
    return (fields || []).map((field) => ({
        ...(field.id ? { id: field.id } : {}),
        ...(field.key ? { key: field.key } : {}),
        fieldValue: resolveTemplate(field.fieldValue, context)
    }));
}

function automaticCustomFields(context) {
    const values = {
        nxacademy_product: context.product,
        paymongo_product_id: context.productId,
        paymongo_reference: context.paymentReference,
        paymongo_payment_id: context.paymentId,
        paymongo_amount: context.totalAmount,
        paymongo_currency: context.currency,
        paymongo_cycle_type: context.cycleType,
        paymongo_paid_at: context.paidAt
    };
    return PAYMONGO_CUSTOM_FIELDS.map((field) => ({
        key: field.key,
        fieldValue: values[field.key]
    })).filter((field) => field.fieldValue != null && String(field.fieldValue).trim() !== '');
}

async function ensurePaymongoCustomFields(location) {
    return ghlService.ensureCustomFieldsForLocation(location, PAYMONGO_CUSTOM_FIELDS);
}

function paymentAmount(paymentData) {
    const amountCentavos = Number(paymentData?.attributes?.amount);
    return Number.isFinite(amountCentavos) ? Number((amountCentavos / 100).toFixed(2)) : null;
}

function invoiceIdFrom(result) {
    return result?.invoice?._id || result?.invoice?.id || result?._id || result?.id || null;
}

function invoiceItems({ metadata, paymentData, amount }) {
    const currency = String(paymentData?.attributes?.currency || 'PHP').toUpperCase();
    const productName = metadata.product ? String(metadata.product) : 'PayMongo Payment';
    const metaSetupFee = Number(metadata.setupFeeAmount);
    const setupFeeAmount = Number.isFinite(metaSetupFee) && metaSetupFee > 0 && metaSetupFee < amount ? metaSetupFee : 0;
    return [
        {
            name: productName,
            description: metadata.paymentReference ? `Ref: ${metadata.paymentReference}` : undefined,
            currency,
            amount: setupFeeAmount > 0 ? Number((amount - setupFeeAmount).toFixed(2)) : amount,
            qty: 1,
            type: 'one_time'
        },
        ...(setupFeeAmount > 0 ? [{
            name: 'Setup fee',
            currency,
            amount: setupFeeAmount,
            qty: 1,
            type: 'one_time'
        }] : [])
    ].map((item) => {
        Object.keys(item).forEach((key) => item[key] === undefined && delete item[key]);
        return item;
    });
}

async function createPaidInvoiceInSubAccount({ rule, contactId, metadata, paymentData }) {
    const amount = paymentAmount(paymentData);
    if (!amount) return { skipped: true, reason: 'missing_amount' };

    const now = new Date();
    const issueDate = now.toISOString().slice(0, 10);
    const currency = String(paymentData?.attributes?.currency || 'PHP').toUpperCase();
    const invoice = await ghlService.createInvoiceInLocation(rule.subAccount, {
        contactId,
        contactDetails: {
            name: metadata.fullName,
            phoneNo: metadata.mobile,
            email: metadata.email
        },
        name: metadata.product ? String(metadata.product) : 'PayMongo Payment',
        currency,
        issueDate,
        dueDate: issueDate,
        items: invoiceItems({ metadata, paymentData, amount })
    });

    const invoiceId = invoiceIdFrom(invoice);
    if (!invoiceId) return { skipped: true, reason: 'missing_invoice_id' };

    const paySource = paymentData?.attributes?.source || {};
    const cardBrand = paySource?.brand || paySource?.card_brand;
    const cardLast4 = paySource?.last4 || paySource?.last_4;
    await ghlService.recordInvoicePaymentInLocation(rule.subAccount, {
        invoiceId,
        amount,
        mode: 'card',
        cardBrand,
        cardLast4,
        notes: `PayMongo payment ${paymentData?.id || ''}`.trim(),
        fulfilledAt: now.toISOString()
    });

    return { skipped: false, invoiceId };
}

async function fulfillPayment({ metadata, paymentData, isTest = false }) {
    const productId = metadata.productId;
    const email = metadata.email;
    const paymentReference = metadata.paymentReference || paymentData?.id;
    if (!productId || !email || !paymentReference) {
        return { skipped: true, reason: 'missing_product_email_or_reference' };
    }

    const rules = await store.listEnabledRulesForProduct(productId);
    if (rules.length === 0) return { skipped: true, reason: 'no_rules' };

    const results = [];
    for (const rule of rules) {
        let cycleType = 'availed';
        let contactId = null;
        let invoiceId = null;
        try {
            const prior = await store.hasPriorSuccessfulEvent({
                productId,
                subAccountId: rule.subAccountId,
                email,
                paymentReference
            });
            cycleType = prior ? 'renewed' : 'availed';
            const context = tokenContext({ metadata, paymentData, cycleType });
            const tagsToAdd = store.cleanList([
                ...rule.everyPaymentTags,
                ...(cycleType === 'renewed' ? rule.renewalTags : rule.firstPaymentTags)
            ].map((tag) => resolveTemplate(tag, context)));
            const tagsToRemove = store.cleanList(rule.removeTags.map((tag) => resolveTemplate(tag, context)));
            const customFields = [
                ...automaticCustomFields(context),
                ...resolveCustomFields(rule.customFields, context)
            ];

            await ensurePaymongoCustomFields(rule.subAccount).catch((err) => {
                console.log('GHL custom field setup error (non-fatal):', err.response?.data || err.message);
            });

            const upsertResult = await ghlService.upsertContactInLocation(rule.subAccount, {
                fullName: metadata.fullName,
                email,
                phone: metadata.mobile,
                tags: tagsToAdd,
                customFields,
                source: metadata.source || 'paymongo'
            });
            contactId = contactIdFromUpsert(upsertResult);
            if (!contactId) throw new Error('GHL contact upsert did not return a contact id');

            if (tagsToAdd.length) await ghlService.addContactTags(rule.subAccount, { contactId, tags: tagsToAdd });
            if (tagsToRemove.length) await ghlService.removeContactTags(rule.subAccount, { contactId, tags: tagsToRemove });
            if (customFields.length) {
                await ghlService.updateContactCustomFields(rule.subAccount, { contactId, customFields }).catch((err) => {
                    console.log('GHL custom field update error (non-fatal):', err.response?.data || err.message);
                });
            }

            const invoiceResult = await createPaidInvoiceInSubAccount({ rule, contactId, metadata, paymentData });
            invoiceId = invoiceResult.invoiceId || null;

            await store.recordEvent({
                productId,
                subAccountId: rule.subAccountId,
                paymentReference,
                email,
                cycleType,
                contactId,
                status: 'succeeded'
            });
            results.push({ subAccountId: rule.subAccountId, cycleType, contactId, invoiceId, status: 'succeeded' });
        } catch (err) {
            await store.recordEvent({
                productId,
                subAccountId: rule.subAccountId,
                paymentReference,
                email,
                cycleType,
                contactId,
                status: 'failed',
                error: err.response?.data?.message || err.message
            }).catch(() => {});
            results.push({ subAccountId: rule.subAccountId, cycleType, contactId, invoiceId, status: 'failed', error: err.message });
        }
    }
    return { skipped: false, results };
}

module.exports = {
    PAYMONGO_CUSTOM_FIELDS,
    fulfillPayment,
    resolveTemplate,
    resolveCustomFields,
    automaticCustomFields,
    ensurePaymongoCustomFields,
    createPaidInvoiceInSubAccount,
    invoiceItems
};
