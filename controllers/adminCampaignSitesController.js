const campaignSiteStore = require('../utils/campaignSiteStore');
const ghlService = require('../services/ghlService');
const { invalidateActiveSiteOriginsCache } = require('../utils/corsOrigins');

function statusForError(err) {
    if (err.statusCode) return err.statusCode;
    return 400;
}

exports.list = async (req, res) => {
    try {
        const sites = await campaignSiteStore.listSites();
        res.json({ success: true, sites });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list campaign sites' });
    }
};

exports.getGhlProducts = async (req, res) => {
    try {
        const products = await ghlService.listGlobalLocationProducts();
        res.json({ success: true, products });
    } catch (err) {
        res.status(err.statusCode === 502 ? 502 : 500).json({ error: err.message || 'Failed to list GHL products' });
    }
};

exports.create = async (req, res) => {
    try {
        const site = await campaignSiteStore.createSite(req.body);
        invalidateActiveSiteOriginsCache();
        res.status(201).json({ success: true, site });
    } catch (err) {
        res.status(statusForError(err)).json({ error: err.message || 'Failed to create campaign site' });
    }
};

exports.update = async (req, res) => {
    try {
        const site = await campaignSiteStore.updateSite(req.params.id, req.body);
        if (!site) return res.status(404).json({ error: 'Campaign site not found' });
        invalidateActiveSiteOriginsCache();
        res.json({ success: true, site });
    } catch (err) {
        res.status(statusForError(err)).json({ error: err.message || 'Failed to update campaign site' });
    }
};

exports.remove = async (req, res) => {
    try {
        const ok = await campaignSiteStore.deleteSite(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Campaign site not found' });
        invalidateActiveSiteOriginsCache();
        res.json({ success: true });
    } catch (err) {
        res.status(statusForError(err)).json({ error: err.message || 'Failed to delete campaign site' });
    }
};
