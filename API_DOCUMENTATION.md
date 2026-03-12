# PayMongo Backend API Documentation

This document describes how to integrate with the Nexistry Academy PayMongo Backend API from external systems.

---

## Overview

This backend provides a REST API for processing payments through PayMongo (Philippines payment gateway). It handles:
- Payment intent creation with multiple payment methods (GCash, GrabPay, Maya, BPI, UnionBank, Cards, QRPh)
- Payment status tracking
- Webhook handling for payment events
- GHL (GoHighLevel) CRM integration
- LeadConnector webhook notifications

---

## Base URL

```
Production: https://your-domain.com/api
Health Check: https://your-domain.com/health
```

Replace `your-domain.com` with the actual deployed domain.

---

## Authentication & Security

### CORS (Cross-Origin Resource Sharing)

The backend uses CORS-based origin validation. Your system's domain must be added to the `ALLOWED_ORIGINS` environment variable on the backend.

**Format:** Comma-separated list of allowed origins
```
ALLOWED_ORIGINS=https://yoursystem.com,https://app.yoursystem.com
```

### Rate Limiting

- **Limit:** 100 requests per 15 minutes per IP
- **Applies to:** All `/api/*` endpoints

---

## Available Endpoints

### 1. Create Payment Intent

**POST** `/api/payments/create-payment-intent`

Creates a new payment intent and returns a checkout URL for the customer to complete payment.

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fullName` | string | Yes | Customer's full name |
| `email` | string | Yes | Customer's email address |
| `mobile` | string | Yes | Customer's mobile number (Philippine format) |
| `product` | string | Yes | Product name (see [Available Products](#available-products)) |
| `paymentMethod` | string | No | Preferred payment method (default: `qrph`) |
| `source` | string | No | Source identifier for tracking (default: `nexistry_academy`) |
| `amount` | number | No | Custom amount (overrides product price, useful for discounts) |
| `discountAmount` | number | No | Discount amount applied |
| `promoCode` | string | No | Promo code used |
| `notes` | string | No | Additional notes |
| `businessName` | string | No | Customer's business name |
| `setupType` | string | No | Setup type (if applicable) |
| `timezone` | string | No | Customer's timezone |
| `experienceLevel` | string | No | Experience level (if applicable) |
| `coachingGoals` | string | No | Coaching goals (if applicable) |
| `targetClient` | string | No | Target client information |
| `metadata` | object | No | Additional custom metadata |

#### Available Payment Methods

| Method ID | Description | Category |
|-----------|-------------|----------|
| `qrph` | QRPh (All Methods via QR) | QR |
| `gcash` | GCash E-Wallet | E-Wallet |
| `grabpay` | GrabPay E-Wallet | E-Wallet |
| `maya` | Maya E-Wallet | E-Wallet |
| `shopeepay` | ShopeePay E-Wallet | E-Wallet |
| `bpi` | BPI Online Banking | Bank |
| `unionbank` | UnionBank Online | Bank |
| `card` | Credit/Debit Card | Card |

#### Available Products

| Product Name | Amount (PHP) |
|--------------|--------------|
| `START UP VA Course` | 1,500.00 |
| `GHL Practice Access` | 500.00 |
| `Freelancer Plan` | 3,500.00 |
| `Dedicated Coaching` | 999.00 |
| `Customization Plan` | 5,000.00 |
| `Client Finder Tool` | 500.00 |
| `Customized Coaching + OJT` | 1,990.00 |

#### Response

```json
{
  "success": true,
  "paymentIntentId": "pi_xxxxxxxxxxxxxxxx",
  "clientSecret": "pi_xxxxxxxxxxxxxxxx_secret_xxxxxxxxxxxxxxxx",
  "checkoutUrl": "https://checkout.paymongo.com/...",
  "paymentReference": "PAY-XXXXXX",
  "amount": 1650.00,
  "baseAmount": 1500.00,
  "taxRate": 0.10,
  "taxAmount": 150.00,
  "discountAmount": 0,
  "promoCode": "",
  "currency": "PHP"
}
```

#### Error Response

```json
{
  "error": "Missing required fields",
  "required": ["fullName", "email", "mobile", "product"]
}
```

---

### 2. Get Payment Status

**GET** `/api/payments/status/:paymentId`

Retrieves the current status of a payment intent.

#### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paymentId` | string | Yes | The PayMongo payment intent ID |

#### Response

```json
{
  "success": true,
  "status": "succeeded",
  "paid": true,
  "paymentIntent": {
    "id": "pi_xxxxxxxxxxxxxxxx",
    "type": "payment_intent",
    "attributes": {
      "status": "succeeded",
      "amount": 165000,
      "currency": "PHP",
      "description": "Product Name - Customer Name",
      "metadata": { ... }
    }
  }
}
```

---

### 3. Cancel Payment

**POST** `/api/payments/cancel/:paymentId`

Marks a payment as cancelled (records the cancellation).

#### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paymentId` | string | Yes | The PayMongo payment intent ID |

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | No | Reason for cancellation |

#### Response

```json
{
  "success": true,
  "message": "Payment cancelled",
  "paymentId": "pi_xxxxxxxxxxxxxxxx"
}
```

---

### 4. Retry Payment

**POST** `/api/payments/retry/:paymentId`

Retrieves the checkout URL to retry a payment.

#### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paymentId` | string | Yes | The PayMongo payment intent ID |

#### Response

```json
{
  "success": true,
  "checkoutUrl": "https://checkout.paymongo.com/...",
  "paymentIntentId": "pi_xxxxxxxxxxxxxxxx"
}
```

---

### 5. Get Payment Methods

**GET** `/api/payments/methods`

Returns the list of available payment methods supported by the backend.

#### Response

```json
{
  "methods": [
    { "id": "qrph", "name": "QRPh (All Methods)", "icon": "qrph-icon.png", "category": "qr" },
    { "id": "gcash", "name": "GCash", "icon": "gcash-icon.png", "category": "ewallet" },
    { "id": "grabpay", "name": "GrabPay", "icon": "grab-icon.png", "category": "ewallet" },
    { "id": "maya", "name": "Maya", "icon": "maya-icon.png", "category": "ewallet" },
    { "id": "shopeepay", "name": "ShopeePay", "icon": "shopee-icon.png", "category": "ewallet" },
    { "id": "bpi", "name": "BPI Online", "icon": "bpi-icon.png", "category": "bank" },
    { "id": "unionbank", "name": "UnionBank Online", "icon": "unionbank-icon.png", "category": "bank" },
    { "id": "card", "name": "Credit/Debit Card", "icon": "card-icon.png", "category": "card" }
  ]
}
```

---

### 6. Validate Payment Details

**POST** `/api/payments/validate`

Validates payment form data before submission.

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fullName` | string | Yes | Customer's full name |
| `email` | string | Yes | Customer's email address |
| `mobile` | string | Yes | Customer's mobile number |
| `amount` | number | No | Payment amount |

#### Response - Valid

```json
{
  "valid": true
}
```

#### Response - Invalid

```json
{
  "valid": false,
  "errors": [
    "Full name must be at least 2 characters",
    "Valid email is required"
  ]
}
```

---

### 7. Health Check

**GET** `/health`

Returns the health status of the API.

#### Response

```json
{
  "status": "OK",
  "timestamp": "2026-03-12T13:45:30.123Z",
  "environment": "production"
}
```

---

### 8. Root Endpoint (API Info)

**GET** `/`

Returns basic API information and available endpoints.

#### Response

```json
{
  "name": "Nexistry Academy PayMongo API",
  "version": "1.0.0",
  "endpoints": {
    "createPayment": "/api/payments/create-payment-intent",
    "paymentWebhook": "/api/payments/webhook",
    "checkStatus": "/api/payments/status/:id",
    "health": "/health"
  }
}
```

---

## Webhook Endpoint (Internal)

**POST** `/api/payments/webhook`

This endpoint is for **PayMongo webhook callbacks only**. Do not call this directly from your system.

PayMongo sends webhook events to this endpoint when:
- `payment.paid` - Payment successfully completed
- `payment.failed` - Payment failed
- `payment.pending` - Payment is pending

---

## Backend Configuration Requirements

To integrate your system with this backend, the following configurations must be set on the backend server:

### Required Environment Variables

#### PayMongo Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYMONGO_SECRET_KEY` | Yes | PayMongo API secret key (sk_...) |
| `TAX_RATE` | Yes | Tax rate as decimal (e.g., `0.10` for 10%) |

#### CORS Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed origins including your system |

#### Frontend Redirect URLs

| Variable | Required | Description |
|----------|----------|-------------|
| `FRONTEND_SUCCESS_URL` | Yes | URL to redirect after successful payment |
| `FRONTEND_FAILURE_URL` | Yes | URL to redirect after failed payment |
| `FRONTEND_CANCEL_URL` | Yes | URL to redirect after cancelled payment |

#### GHL Integration (Optional)

| Variable | Required | Description |
|----------|----------|-------------|
| `GHL_PRIVATE_KEY` | No | GoHighLevel API private key |
| `GHL_LOCATION_ID` | No | GoHighLevel location ID |
| `GHL_BUSINESS_NAME` | No | Business name for invoices (default: "Nexistry Academy") |

#### LeadConnector Webhook (Optional)

| Variable | Required | Description |
|----------|----------|-------------|
| `LEADCONNECTOR_WEBHOOK` | No | LeadConnector webhook URL for payment notifications |
| `DISABLE_LEADCONNECTOR_WEBHOOK` | No | Set to `true` to disable LeadConnector webhooks |

#### Server Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (`production`, `development`) |

### Example .env Configuration

```env
# Server
NODE_ENV=production
PORT=3000

# CORS - Add your system's origin here
ALLOWED_ORIGINS=https://yoursystem.com,https://app.yoursystem.com

# PayMongo
PAYMONGO_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxx
TAX_RATE=0.10

# Frontend URLs
FRONTEND_SUCCESS_URL=https://yoursystem.com/payment/success?session_id={CHECKOUT_SESSION_ID}
FRONTEND_FAILURE_URL=https://yoursystem.com/payment/failed
FRONTEND_CANCEL_URL=https://yoursystem.com/payment/cancelled

# GHL Integration (optional)
GHL_PRIVATE_KEY=your_ghl_private_key
GHL_LOCATION_ID=your_ghl_location_id
GHL_BUSINESS_NAME=Your Business Name

# LeadConnector Webhook (optional)
LEADCONNECTOR_WEBHOOK=https://services.leadconnectorhq.com/hooks/your-webhook-id
```

---

## Integration Flow

### Basic Payment Flow

```
1. Your System          2. PayMongo Backend          3. PayMongo Gateway
     |                          |                             |
     | POST /create-payment-intent|                             |
     |------------------------->|                             |
     |                          | Create Payment Intent       |
     |                          |------------------------->  |
     |                          |                             |
     |                          |<-------------------------  |
     |<-------------------------| Return checkout_url         |
     | checkoutUrl              |                             |
     |                          |                             |
     | Redirect customer to checkoutUrl                      |
     |------------------------------------------------------>|
     |                          |                             |
     |<------------------------------------------------------|
     | Customer completes payment on PayMongo checkout page   |
     |                          |                             |
     |                          | POST /webhook               |
     |                          |<-------------------------  |
     | LeadConnector webhook    |                             |
     | (if configured)          |                             |
     |<-------------------------|                             |
```

### JavaScript Integration Example

```javascript
// Create a payment
async function createPayment(customerData) {
  const response = await fetch('https://your-api-domain.com/api/payments/create-payment-intent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fullName: customerData.name,
      email: customerData.email,
      mobile: customerData.phone,
      product: 'START UP VA Course',
      paymentMethod: 'gcash',
      source: 'your_system_name'
    })
  });

  const data = await response.json();
  
  if (data.success) {
    // Redirect to PayMongo checkout
    window.location.href = data.checkoutUrl;
  } else {
    console.error('Payment creation failed:', data.error);
  }
}

// Check payment status
async function checkPaymentStatus(paymentIntentId) {
  const response = await fetch(`https://your-api-domain.com/api/payments/status/${paymentIntentId}`);
  const data = await response.json();
  
  return {
    isPaid: data.paid,
    status: data.status
  };
}
```

---

## Error Handling

### Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `400` | Bad Request - Invalid input data |
| `404` | Not Found - Endpoint or resource not found |
| `429` | Too Many Requests - Rate limit exceeded |
| `500` | Internal Server Error |

### Error Response Format

```json
{
  "error": "Error description",
  "message": "Detailed error message",
  "timestamp": "2026-03-12T13:45:30.123Z"
}
```

---

## Support

For issues or questions:
- Check the backend logs via PM2: `pm2 logs paymongo-backend`
- Verify your origin is in `ALLOWED_ORIGINS`
- Confirm PayMongo secret key is correctly configured

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-03-12 | Initial API documentation |
