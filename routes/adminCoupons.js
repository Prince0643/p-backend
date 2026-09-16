const express = require('express');
const router = express.Router();
const adminCouponsController = require('../controllers/adminCouponsController');
const { validateAdminApiKey } = require('../middleware/auth');

router.use(validateAdminApiKey);

router.get('/coupons', adminCouponsController.list);
router.get('/coupons/redemptions', adminCouponsController.listRedemptions);
router.post('/coupons/redemptions/mark-paid', adminCouponsController.markRedemptionsPaid);
router.get('/coupons/:code', adminCouponsController.getOne);
router.post('/coupons', adminCouponsController.upsert);
router.put('/coupons/:code', adminCouponsController.upsert);
router.delete('/coupons/:code', adminCouponsController.remove);

module.exports = router;
