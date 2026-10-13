const store = require('../utils/ghlFulfillmentStore');

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
