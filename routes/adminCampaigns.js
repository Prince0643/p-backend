const express = require('express');
const router = express.Router();
const adminCampaignsController = require('../controllers/adminCampaignsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/campaigns', adminCampaignsController.list);
router.get('/campaigns/:id', adminCampaignsController.getOne);
router.post('/campaigns', adminCampaignsController.create);
router.put('/campaigns/:id', adminCampaignsController.update);
router.delete('/campaigns/:id', adminCampaignsController.remove);

module.exports = router;
