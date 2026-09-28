const express = require('express');
const router = express.Router();
const adminCampaignSitesController = require('../controllers/adminCampaignSitesController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/campaign-sites', adminCampaignSitesController.list);
router.get('/campaign-sites/ghl-products', adminCampaignSitesController.getGhlProducts);
router.post('/campaign-sites', adminCampaignSitesController.create);
router.put('/campaign-sites/:id', adminCampaignSitesController.update);
router.delete('/campaign-sites/:id', adminCampaignSitesController.remove);

module.exports = router;
