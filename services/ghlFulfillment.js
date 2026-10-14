const ghlService = require('./ghlService');
const store = require('../utils/ghlFulfillmentStore');

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
            const customFields = resolveCustomFields(rule.customFields, context);

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
            if (customFields.length) await ghlService.updateContactCustomFields(rule.subAccount, { contactId, customFields });

            await store.recordEvent({
                productId,
                subAccountId: rule.subAccountId,
                paymentReference,
                email,
                cycleType,
                contactId,
                status: 'succeeded'
            });
            results.push({ subAccountId: rule.subAccountId, cycleType, contactId, status: 'succeeded' });
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
            results.push({ subAccountId: rule.subAccountId, cycleType, contactId, status: 'failed', error: err.message });
        }
    }
    return { skipped: false, results };
}

module.exports = { fulfillPayment, resolveTemplate, resolveCustomFields };
