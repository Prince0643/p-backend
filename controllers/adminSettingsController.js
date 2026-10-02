const { getGlobalLegalLinks, setGlobalLegalLinks } = require('../utils/legalLinks');

exports.get = async (req, res) => {
    try {
        res.json({ success: true, settings: await getGlobalLegalLinks() });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load settings' });
    }
};

exports.update = async (req, res) => {
    let settings;
    try {
        settings = await setGlobalLegalLinks(req.body);
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to save settings' });
    }
    res.json({ success: true, settings });
};
