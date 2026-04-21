// routes/payments.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

function requireDiagnosticToken(req, res, next) {
    const token = process.env.DIAGNOSTIC_TOKEN;
    if (!token) return next();

    const provided = req.get('x-diagnostic-token');
    if (provided && provided === token) return next();

    return res.status(401).json({ error: 'Unauthorized' });
}

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

// Diagnostic: PayMongo merchant payment method capabilities (sanitized)
router.get('/capabilities', requireDiagnosticToken, paymentController.getPaymongoCapabilities);

// Validate payment details
router.post('/validate', paymentController.validatePayment);

module.exports = router;
