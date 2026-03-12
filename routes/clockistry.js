// routes/clockistry.js
const express = require('express');
const router = express.Router();
const clockistryController = require('../controllers/clockistryController');

// Create payment intent for Clockistry subscription
router.post('/create-payment-intent', clockistryController.createPaymentIntent);

module.exports = router;
