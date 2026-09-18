const adminStore = require('../utils/adminStore');
const { issueToken } = require('../utils/authToken');

// POST /api/admin/auth/login (public)
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const admin = await adminStore.verifyAdminCredentials({ email, password });
        if (!admin) return res.status(401).json({ error: 'Invalid email or password' });

        const token = issueToken({ type: 'admin', id: admin.id, email: admin.email });
        res.json({ success: true, token, admin });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to log in' });
    }
};

// GET /api/admin/auth/me (requires auth)
exports.me = async (req, res) => {
    if (req.admin.master) {
        return res.json({ success: true, admin: { id: null, email: null, master: true } });
    }
    try {
        const admin = await adminStore.findAdminById(req.admin.id);
        if (!admin) return res.status(404).json({ error: 'Admin not found' });
        res.json({ success: true, admin: { id: admin.id, email: admin.email, active: !admin.revoked_at } });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load session' });
    }
};

// GET /api/admin/admins (requires auth)
exports.list = async (req, res) => {
    try {
        const admins = await adminStore.listAdmins();
        res.json({ success: true, admins });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list admins' });
    }
};

// POST /api/admin/admins (requires auth) - any existing admin can create another,
// who immediately picks their own email + password right here (no invite link/email
// needed). Auto-logs the new account in too, matching how affiliate self-registration
// works.
exports.create = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const admin = await adminStore.createAdmin({ email, password });
        const token = issueToken({ type: 'admin', id: admin.id, email: admin.email });
        res.status(201).json({ success: true, admin, token });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to create admin' });
    }
};

// DELETE /api/admin/admins/:id (requires auth)
exports.revoke = async (req, res) => {
    try {
        if (req.admin.id === req.params.id) {
            return res.status(400).json({ error: 'You cannot revoke your own account while logged in as it' });
        }
        const revoked = await adminStore.revokeAdmin(req.params.id);
        if (!revoked) return res.status(404).json({ error: 'Admin not found or already revoked' });
        res.json({ success: true, admin: revoked });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to revoke admin' });
    }
};
