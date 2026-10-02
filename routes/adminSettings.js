const express = require('express');
const router = express.Router();
const adminSettingsController = require('../controllers/adminSettingsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/settings', adminSettingsController.get);
router.put('/settings', adminSettingsController.update);

module.exports = router;
