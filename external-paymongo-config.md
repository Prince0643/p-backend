# Clockistry Integration Configuration Guide
**For:** Nexistry PayMongo Backend (https://api.nexistrydigitalsolutions.com/)  
**Integrating with:** Clockistry SaaS Platform  
**Date:** March 2026  
**Integration Type:** Direct API Integration

---

## Overview

Clockistry will call your PayMongo backend API to create payment intents for subscription upgrades. Your backend needs to:

1. Accept CORS requests from Clockistry's domain
2. Support dynamic per-user pricing (not fixed product prices)
3. Send webhooks back to Clockistry when payments complete

---

## Required Configuration Changes

### 1. CORS Origins (CRITICAL)

Add Clockistry's domain to your `ALLOWED_ORIGINS` environment variable:

```env
# Current configuration
ALLOWED_ORIGINS=https://nexiflow-new.nexistrydigitalsolutions.com

# If Clockistry is on localhost during development:
ALLOWED_ORIGINS=https://nexiflow-new.nexistrydigitalsolutions.com,http://localhost:3000,http://localhost:5173
```

**Clockistry domains to whitelist:**
- Production: `https://nexiflow-new.nexistrydigitalsolutions.com`
- Development: `http://localhost:3000` or `http://localhost:5173`

---

### 2. New API Endpoint: Create Payment Intent for Clockistry

Your backend needs a new endpoint specifically for Clockistry's subscription model.

**Endpoint:** `POST /api/clockistry/create-payment-intent`

#### Request Body (from Clockistry)

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

#### Pricing Logic (to implement in your backend)

| Plan | USD/User | PHP Rate (₱58/$) | Per-User Price (centavos) |
|------|----------|------------------|--------------------------|
| office | $9 | ₱522 | 52200 |
| enterprise | $12 | ₱696 | 69600 |

**Calculation:**
```javascript
const USD_TO_PHP_RATE = 58;
const pricePerUserUSD = plan === 'office' ? 9 : 12;
const pricePerUserCentavos = pricePerUserUSD * USD_TO_PHP_RATE * 100;
const totalAmount = pricePerUserCentavos * userCount;
```

#### PayMongo Checkout Session to Create

```javascript
{
  data: {
    attributes: {
      line_items: [{
        name: `Nexiflow ${plan} Plan`,  // "Nexiflow office Plan"
        amount: totalAmount,              // Total in centavos
        currency: 'PHP',
        description: `Subscription for ${userCount} user(s)`,
        quantity: 1
      }],
      payment_method_types: ['card', 'gcash', 'qrph', 'maya', 'grabpay'], // Enable all
      success_url: successUrl,
      cancel_url: cancelUrl,
      description: `Upgrade to ${plan} plan`,
      send_email_receipt: true,
      show_description: true,
      show_line_items: true,
      metadata: {
        // CRITICAL: These fields are required for Clockistry webhook processing
        company_id: companyId,
        user_id: userId,
        pricing_level: plan,           // "office" or "enterprise"
        user_count: userCount,
        price_per_user: pricePerUserCentavos,
        internal_transaction_id: "uuid-generated-by-your-backend",
        source: "clockistry"           // To identify Clockistry payments
      }
    }
  }
}
```

#### Response to Clockistry

```json
{
  "success": true,
  "checkoutUrl": "https://checkout.paymongo.com/...",
  "checkoutSessionId": "cs_xxxxx",
  "transactionId": "internal_transaction_id",
  "amount": 261000,
  "currency": "PHP"
}
```

---

### 3. Webhook Handling Modifications

Your existing `/api/payments/webhook` endpoint receives PayMongo webhooks. You need to add logic to forward Clockistry-specific events to Clockistry's backend.

#### When to Forward Webhooks

Check the metadata in the PayMongo webhook payload:
```javascript
const metadata = payload.data?.attributes?.data?.attributes?.metadata;

if (metadata?.source === 'clockistry') {
  // Forward to Clockistry
  await forwardToClockistry(payload);
}
```

#### Clockistry Webhook Endpoint

**URL:** `https://nexiflow-new.nexistrydigitalsolutions.com/api/billing/webhook`  
**Method:** POST  
**Content-Type:** application/json

#### Payload to Send to Clockistry

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
    "user_count": 5,
    "price_per_user": 52200,
    "internal_transaction_id": "uuid",
    "source": "clockistry"
  },
  "paidAt": "2026-03-12T14:30:00Z"
}
```

#### Events to Forward

| PayMongo Event | Clockistry Action |
|----------------|-------------------|
| `checkout_session.payment.paid` | Upgrade company plan |
| `payment.failed` | Mark transaction failed |
| `payment.cancelled` | Mark transaction cancelled |

---

### 4. Environment Variables to Add

```env
# Clockistry Integration
CLOCKISTRY_WEBHOOK_URL=https://nexiflow-new.nexistrydigitalsolutions.com/api/billing/webhook
# Optional: Secret for signing webhooks to Clockistry
CLOCKISTRY_WEBHOOK_SECRET=your_secret_here

# If you want to verify Clockistry requests (optional)
CLOCKISTRY_API_KEY=clockistry_provided_key
```

---

### 5. Code Implementation Example

Add to your Express app:

```javascript
// Clockistry-specific payment intent creation
app.post('/api/clockistry/create-payment-intent', async (req, res) => {
  try {
    const { companyId, userId, plan, userCount, successUrl, cancelUrl, customerEmail, customerName } = req.body;
    
    // Validate
    if (!companyId || !plan || !['office', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    // Calculate price
    const USD_TO_PHP_RATE = 58;
    const pricePerUserUSD = plan === 'office' ? 9 : 12;
    const pricePerUserCentavos = pricePerUserUSD * USD_TO_PHP_RATE * 100;
    const count = parseInt(userCount) || 1;
    const totalAmount = pricePerUserCentavos * count;
    
    // Create PayMongo checkout session
    const response = await axios.post(
      'https://api.paymongo.com/v1/checkout_sessions',
      {
        data: {
          attributes: {
            line_items: [{
              name: `Nexiflow ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
              amount: totalAmount,
              currency: 'PHP',
              description: `Subscription for ${count} user(s)`,
              quantity: 1
            }],
            payment_method_types: ['card', 'gcash', 'qrph', 'maya', 'grabpay'],
            success_url: successUrl,
            cancel_url: cancelUrl,
            description: `Upgrade to ${plan} plan`,
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            metadata: {
              company_id: companyId,
              user_id: userId,
              pricing_level: plan,
              user_count: count,
              price_per_user: pricePerUserCentavos,
              internal_transaction_id: generateUUID(),
              source: 'clockistry'
            }
          }
        }
      },
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const checkoutData = response.data.data;
    
    res.json({
      success: true,
      checkoutUrl: checkoutData.attributes.checkout_url,
      checkoutSessionId: checkoutData.id,
      transactionId: checkoutData.attributes.metadata.internal_transaction_id,
      amount: totalAmount,
      currency: 'PHP'
    });
    
  } catch (error) {
    console.error('Clockistry payment creation error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Modified webhook handler to forward to Clockistry
async function handlePaymongoWebhook(req, res) {
  // Your existing webhook handling...
  
  const payload = req.body;
  const metadata = payload.data?.attributes?.data?.attributes?.metadata;
  
  // Forward to Clockistry if it's a Clockistry payment
  if (metadata?.source === 'clockistry' && process.env.CLOCKISTRY_WEBHOOK_URL) {
    try {
      await axios.post(process.env.CLOCKISTRY_WEBHOOK_URL, {
        eventType: payload.data?.attributes?.type,
        checkoutSessionId: payload.data?.attributes?.data?.id,
        paymentIntentId: payload.data?.attributes?.data?.attributes?.payment_intent?.id,
        amount: payload.data?.attributes?.data?.attributes?.amount,
        currency: payload.data?.attributes?.data?.attributes?.currency,
        status: payload.data?.attributes?.type.includes('paid') ? 'paid' : 'failed',
        metadata: metadata,
        paidAt: new Date().toISOString()
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': process.env.CLOCKISTRY_WEBHOOK_SECRET // Optional
        }
      });
      console.log('Webhook forwarded to Clockistry');
    } catch (forwardError) {
      console.error('Failed to forward webhook to Clockistry:', forwardError.message);
      // Don't fail the response - PayMongo should get 200
    }
  }
  
  res.status(200).json({ received: true });
}
```

---

## Testing Checklist

- [ ] Add Clockistry domain to `ALLOWED_ORIGINS`
- [ ] Deploy new `/api/clockistry/create-payment-intent` endpoint
- [ ] Test endpoint with Clockistry credentials
- [ ] Create test payment in PayMongo test mode
- [ ] Verify webhook is received by Clockistry backend
- [ ] Confirm Clockistry updates company plan after payment
- [ ] Test failed payment flow
- [ ] Switch to PayMongo live mode

---

## Support Contacts

**Clockistry Team:** [Your contact info]  
**PayMongo Docs:** https://developers.paymongo.com/

---

## Important Notes

1. **Metadata is critical:** Clockistry requires `company_id`, `pricing_level`, and `user_count` in the metadata to process upgrades correctly.

2. **Webhook forwarding:** Always return 200 to PayMongo, even if forwarding to Clockistry fails. Use logging to track failures.

3. **Idempotency:** Clockistry uses `checkout_session_id` to prevent duplicate processing. Include it in webhooks.

4. **Security:** Consider implementing a shared secret (`CLOCKISTRY_WEBHOOK_SECRET`) to verify webhook authenticity.
