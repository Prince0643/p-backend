const express = require('express');
const router = express.Router();
const adminAuthController = require('../controllers/adminAuthController');
const { requireAdminAuth } = require('../middleware/adminAuth');

// Applied per-route (not via a blanket router.use()) since several routers share the
// /api/admin mount prefix - a blanket .use() here would also intercept every other
// router's paths (e.g. /coupons) before they get a chance to run their own auth.
router.post('/auth/login', adminAuthController.login);
router.get('/auth/me', requireAdminAuth, adminAuthController.me);
router.get('/admins', requireAdminAuth, adminAuthController.list);
router.post('/admins', requireAdminAuth, adminAuthController.create);
router.delete('/admins/:id', requireAdminAuth, adminAuthController.revoke);

module.exports = router;
