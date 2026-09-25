const campaignStore = require('../utils/campaignStore');

function statusForError(err) {
    if (err.statusCode) return err.statusCode;
    return 400;
}

exports.list = async (req, res) => {
    try {
        const { couponCode, active } = req.query;
        const campaigns = await campaignStore.listCampaigns({ couponCode, active });
        res.json({ success: true, campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list campaigns' });
    }
};

exports.getOne = async (req, res) => {
    try {
        const campaign = await campaignStore.findCampaignById(req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        res.json({ success: true, campaign });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get campaign' });
    }
};

exports.create = async (req, res) => {
    try {
        const campaign = await campaignStore.createCampaign(req.body);
        res.status(201).json({ success: true, campaign });
    } catch (err) {
        res.status(statusForError(err)).json({ error: err.message || 'Failed to create campaign' });
    }
};

exports.update = async (req, res) => {
    try {
        const campaign = await campaignStore.updateCampaign(req.params.id, req.body);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        res.json({ success: true, campaign });
    } catch (err) {
        res.status(statusForError(err)).json({ error: err.message || 'Failed to update campaign' });
    }
};

exports.remove = async (req, res) => {
    try {
        const ok = await campaignStore.deleteCampaign(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Campaign not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete campaign' });
    }
};
