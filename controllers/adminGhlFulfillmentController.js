const store = require('../utils/ghlFulfillmentStore');
const ghlService = require('../services/ghlService');
const ghlFulfillment = require('../services/ghlFulfillment');

function slug(input) {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
}

function uniqueLocations(locations) {
    const seen = new Set();
    return locations.filter((location) => {
        if (!location?.locationId || !location?.privateKey) return false;
        if (seen.has(location.locationId)) return false;
        seen.add(location.locationId);
        return true;
    });
}

function envSubAccounts() {
    const configured = [];
    const main = ghlService.resolveMainLocation();
    if (main) configured.push({ id: 'main', name: main.name || 'Main', ...main });
    const global = ghlService.resolveGlobalLocation();
    if (global) configured.push({ id: 'global', name: global.name || 'Nexistry Core Global', ...global });
    for (const location of ghlService.getConfiguredLocations()) {
        configured.push({ id: slug(location.name || location.locationId), ...location });
    }
    if (process.env.GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS && process.env.GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS) {
        configured.push({
            id: 'nexistry_academy_students',
            name: 'Nexistry Academy Students',
            locationId: process.env.GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS,
            privateKey: process.env.GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS
        });
    }
    return uniqueLocations(configured).map((location) => ({
        id: location.id || slug(location.name || location.locationId),
        name: location.name || location.locationId,
        locationId: location.locationId,
        privateKey: location.privateKey,
        businessName: location.name || '',
        active: true
    }));
}

exports.list = async (req, res) => {
    try {
        const [subAccounts, rules] = await Promise.all([
            store.listSubAccounts(),
            store.listRules()
        ]);
        res.json({ success: true, subAccounts, rules });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load GHL fulfillment config' });
    }
};

exports.saveSubAccount = async (req, res) => {
    try {
        const subAccount = await store.upsertSubAccount(req.body);
        res.json({ success: true, subAccount });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save GHL sub-account' });
    }
};

exports.importEnvSubAccounts = async (req, res) => {
    try {
        const locations = envSubAccounts();
        const imported = [];
        for (const location of locations) {
            imported.push(await store.upsertSubAccount(location));
        }
        res.json({ success: true, imported, count: imported.length });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to import env GHL sub-accounts' });
    }
};

exports.ensureCustomFields = async (req, res) => {
    try {
        const accounts = await store.listSubAccounts({ includeSecret: true });
        const activeAccounts = accounts.filter((account) => account.active);
        const results = [];
        for (const account of activeAccounts) {
            try {
                const summary = await ghlFulfillment.ensurePaymongoCustomFields(account);
                results.push({
                    subAccountId: account.id,
                    name: account.name,
                    locationId: account.locationId,
                    created: summary.created.map((field) => ({
                        id: field.id,
                        name: field.name,
                        fieldKey: field.fieldKey
                    })),
                    existing: summary.existing
                });
            } catch (err) {
                results.push({
                    subAccountId: account.id,
                    name: account.name,
                    locationId: account.locationId,
                    error: err.response?.data?.message || err.message
                });
            }
        }
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to ensure GHL custom fields' });
    }
};

exports.deleteSubAccount = async (req, res) => {
    try {
        const ok = await store.deleteSubAccount(req.params.id);
        if (!ok) return res.status(404).json({ error: 'GHL sub-account not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete GHL sub-account' });
    }
};

exports.saveRule = async (req, res) => {
    try {
        const rule = await store.upsertRule(req.body);
        res.json({ success: true, rule });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save fulfillment rule' });
    }
};

exports.deleteRule = async (req, res) => {
    try {
        const ok = await store.deleteRule({
            productId: req.params.productId,
            subAccountId: req.params.subAccountId
        });
        if (!ok) return res.status(404).json({ error: 'Fulfillment rule not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete fulfillment rule' });
    }
};
