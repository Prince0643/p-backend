const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminProductCouponConfigController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/ghl-products', controller.listGhlProducts);
router.get('/product-coupon-config', controller.get);
router.put('/product-coupon-config', controller.save);
router.post('/product-coupon-config/ghl-sync', controller.ghlSync);

module.exports = router;
