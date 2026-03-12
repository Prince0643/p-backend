# PayMongo Backend Integration Guide for Nexiflow

This document explains how Nexiflow should integrate with the Nexistry PayMongo Backend for processing subscription payments.

---

## Overview

The PayMongo Backend has been configured to support Clockistry/Nexiflow subscription payments with the following features:
- Dedicated endpoint for creating subscription payment intents
- Dynamic pricing based on plan (Office/Enterprise) and user count
- Automatic webhook forwarding to Nexiflow backend
- GHL integration is bypassed for Clockistry payments

---

## Backend Endpoint

**Base URL:** `https://api.nexistrydigitalsolutions.com` (or your deployed backend URL)

### Create Payment Intent

**POST** `/api/clockistry/create-payment-intent`

Creates a PayMongo checkout session for subscription upgrades.

#### Request Body

```json
{
  "companyId": "uuid-string",
  "userId": "uuid-string",
  "plan": "office",
  "userCount": 5,
  "successUrl": "https://nexiflow-new.nexistrydigitalsolutions.com/billing/success",
  "cancelUrl": "https://nexiflow-new.nexistrydigitalsolutions.com/billing/cancel",
  "customerEmail": "user@company.com",
  "customerName": "John Doe"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `companyId` | string | Yes | Company UUID for the subscription |
| `userId` | string | No | User ID who initiated the upgrade |
| `plan` | string | Yes | `"office"` or `"enterprise"` |
| `userCount` | number | No | Number of users (default: 1) |
| `successUrl` | string | No | Custom success redirect URL |
| `cancelUrl` | string | No | Custom cancel redirect URL |
| `customerEmail` | string | No | Customer email for receipt |
| `customerName` | string | No | Customer name |

#### Response

```json
{
  "success": true,
  "checkoutUrl": "https://checkout.paymongo.com/...",
  "checkoutSessionId": "cs_xxxxx",
  "transactionId": "CLK-XXXXXX",
  "amount": 261000,
  "currency": "PHP"
}
```

| Field | Description |
|-------|-------------|
| `checkoutUrl` | Redirect customer here to complete payment |
| `checkoutSessionId` | PayMongo checkout session ID |
| `transactionId` | Internal transaction reference (CLK-XXXXXX) |
| `amount` | Total amount in centavos |
| `currency` | Currency code (PHP) |

---

## Pricing

| Plan | USD/User | PHP/User | Per-User (centavos) |
|------|----------|----------|---------------------|
| Office | $9 | ₱522 | 52200 |
| Enterprise | $12 | ₱696 | 69600 |

**Calculation:** `totalAmount = pricePerUserCentavos × userCount`

Example: 5 users on Office plan = 52200 × 5 = 261000 centavos (₱2,610.00)

---

## Webhook Integration

The backend will automatically forward PayMongo webhooks to your Nexiflow webhook endpoint.

### Your Webhook Endpoint

**URL:** `https://nexiflow-new.nexistrydigitalsolutions.com/api/billing/webhook`  
**Method:** POST  
**Content-Type:** application/json

### Webhook Payload

```json
{
  "eventType": "checkout_session.payment.paid",
  "checkoutSessionId": "cs_xxxxx",
  "paymentIntentId": "pi_xxxxx",
  "amount": 261000,
  "currency": "PHP",
  "status": "paid",
  "metadata": {
    "company_id": "uuid",
    "user_id": "uuid",
    "pricing_level": "office",
    "user_count": "5",
    "price_per_user": "52200",
    "internal_transaction_id": "CLK-XXXXXX",
    "source": "clockistry",
    "customer_email": "user@company.com",
    "customer_name": "John Doe"
  },
  "paidAt": "2026-03-12T14:30:00Z"
}
```

### Event Types

| Event Type | Description | Action Required |
|------------|-------------|-----------------|
| `checkout_session.payment.paid` | Payment successful | Upgrade company plan, provision seats |
| `payment.failed` | Payment failed | Mark transaction failed, notify user |
| `payment.cancelled` | Payment cancelled | Mark transaction cancelled |

### Important Metadata Fields

| Field | Purpose |
|-------|---------|
| `company_id` | Identify which company to upgrade |
| `pricing_level` | Office or Enterprise plan |
| `user_count` | Number of seats to provision |
| `internal_transaction_id` | Your internal reference (CLK-XXXXXX) |
| `source` | Always "clockistry" for your payments |

---

## Implementation Steps

### 1. Call Create Payment Intent

```javascript
const response = await fetch('https://api.nexistrydigitalsolutions.com/api/clockistry/create-payment-intent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    companyId: 'your-company-uuid',
    userId: 'user-uuid',
    plan: 'office', // or 'enterprise'
    userCount: 5,
    customerEmail: 'admin@company.com',
    customerName: 'John Doe'
  })
});

const data = await response.json();

if (data.success) {
  // Redirect to PayMongo checkout
  window.location.href = data.checkoutUrl;
}
```

### 2. Handle Webhook in Your Backend

```javascript
// POST /api/billing/webhook
app.post('/api/billing/webhook', async (req, res) => {
  const { eventType, metadata, checkoutSessionId } = req.body;
  
  // Verify it's from the PayMongo backend (optional: check X-Webhook-Secret header)
  
  if (eventType === 'checkout_session.payment.paid') {
    // Upgrade the company plan
    await upgradeCompanyPlan({
      companyId: metadata.company_id,
      plan: metadata.pricing_level,
      userCount: parseInt(metadata.user_count),
      transactionId: metadata.internal_transaction_id,
      checkoutSessionId
    });
  }
  
  // Always return 200
  res.status(200).json({ received: true });
});
```

### 3. Handle Redirect Pages

**Success Page** (`/billing/success`):
- Show confirmation message
- Display updated plan details
- Refresh user session to reflect new permissions

**Cancel Page** (`/billing/cancel`):
- Show cancellation message
- Offer option to retry

---

## Testing

1. **Test Endpoint:** Call `/api/clockistry/create-payment-intent` with test data
2. **Test Checkout:** Complete a test payment using PayMongo test card: `4343434343434345`
3. **Verify Webhook:** Check that your webhook receives the event
4. **Verify Plan Upgrade:** Confirm company is upgraded after payment

---

## Important Notes

1. **No GHL Integration:** Clockistry payments do NOT go to GHL/LeadConnector - they are processed separately
2. **Idempotency:** Use `checkoutSessionId` or `internal_transaction_id` to prevent duplicate upgrades
3. **Webhook Retries:** The backend always returns 200 to PayMongo, but will retry forwarding to your webhook once after 5 seconds if it fails
4. **Security:** Consider implementing `X-Webhook-Secret` header verification in your webhook handler

---

## Support

For issues or questions:
- Check backend logs via PM2: `pm2 logs paymongo-backend`
- Verify webhook URL is accessible from the internet
- Confirm CORS origin is whitelisted in backend `.env`
