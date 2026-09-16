const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');

// Public: affiliate self-registration (replaces the Google Apps Script target)
router.post('/register', affiliateController.register);

module.exports = router;
