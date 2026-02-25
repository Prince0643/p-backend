// routes/payments.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Create a payment intent
router.post('/create-payment-intent', paymentController.createPaymentIntent);

// Get payment status
router.get('/status/:paymentId', paymentController.getPaymentStatus);

// PayMongo webhook endpoint (for payment updates)
router.post('/webhook', paymentController.handleWebhook);

// Cancel payment
router.post('/cancel/:paymentId', paymentController.cancelPayment);

// Retry payment
router.post('/retry/:paymentId', paymentController.retryPayment);

// Get payment methods
router.get('/methods', paymentController.getPaymentMethods);

// Validate payment details
router.post('/validate', paymentController.validatePayment);

module.exports = router;