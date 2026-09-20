const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/affiliates', affiliateController.list);
router.get('/affiliates/:id', affiliateController.getOne);
router.patch('/affiliates/:id/status', affiliateController.updateStatus);

module.exports = router;
