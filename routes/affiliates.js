const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');
const affiliateAuthController = require('../controllers/affiliateAuthController');
const { requireAffiliateAuth } = require('../middleware/affiliateAuth');

// Public: affiliate self-registration (replaces the Google Apps Script target)
router.post('/register', affiliateController.register);

// Public: affiliate self-service portal login
router.post('/login', affiliateAuthController.login);

// Self-service portal (requires the affiliate's own session)
router.get('/me', requireAffiliateAuth, affiliateAuthController.me);
router.get('/me/campaigns', requireAffiliateAuth, affiliateAuthController.myCampaigns);
router.patch('/me/payout', requireAffiliateAuth, affiliateAuthController.updatePayout);

module.exports = router;
