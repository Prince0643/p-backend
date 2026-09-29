const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminGhlCouponsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/ghl-coupons', controller.list);
router.post('/ghl-coupons/:code/assign', controller.assign);
router.post('/ghl-coupons/:code/credit-past', controller.creditPast);
router.post('/ghl-coupons/:code/unassign', controller.unassign);

module.exports = router;
