# PayMongo Subscription Implementation Guide

This guide explains how to implement recurring monthly payments using PayMongo's Subscriptions API in your Nexistry Academy backend.

---

## Overview

PayMongo's Subscriptions API allows you to bill customers automatically on a recurring schedule (e.g., monthly). The workflow involves:

1. **Plans** - Define the billing schedule (amount, currency, interval)
2. **Customers** - Store customer payment information
3. **Subscriptions** - Link customers to plans
4. **Invoices** - Auto-generated for each billing cycle

**⚠️ Important Limitation:** Subscriptions only support **Card** and **Maya** payment methods. GCash, GrabPay, and bank transfers are NOT supported for recurring billing.

---

## Step-by-Step Implementation

### Step 1: Create a Plan

Before creating subscriptions, you need to define a plan. This is typically done once during setup or admin configuration.

**API Call:**
```
POST https://api.paymongo.com/v1/plans
```

**Request Body:**
```json
{
  "data": {
    "attributes": {
      "name": "Monthly VA Course Subscription",
      "description": "Unlimited access to VA course materials with monthly billing",
      "amount": 150000,
      "currency": "PHP",
      "interval": "monthly",
      "interval_count": 1,
      "cycle_count": null
    }
  }
}
```

**Key Fields:**
- `amount` - Amount in centavos (150000 = ₱1,500.00)
- `interval` - `"monthly"`, `"weekly"`, `"yearly"`
- `interval_count` - Number of intervals (1 = every 1 month)
- `cycle_count` - Optional. Number of billing cycles. Omit or set `null` for indefinite billing.

**Save the `plan_id` returned - you'll use it when creating subscriptions.**

---

### Step 2: Create a Customer

Each subscription needs a PayMongo customer record.

**API Call:**
```
POST https://api.paymongo.com/v1/customers
```

**Request Body:**
```json
{
  "data": {
    "attributes": {
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "+639123456789"
    }
  }
}
```

**Save the `customer_id` - needed for subscription creation.**

---

### Step 3: Create a Subscription

Link the customer to a plan.

**API Call:**
```
POST https://api.paymongo.com/v1/subscriptions
```

**Request Body:**
```json
{
  "data": {
    "attributes": {
      "customer_id": "cus_Exy3jegPk4eEagpQcE6wnLB4",
      "plan_id": "plan_ajeDG2y6WgnrCXaamWFmPUw2",
      "anchor_date": "2026-02-27"
    }
  }
}
```

**Response includes:**
```json
{
  "data": {
    "id": "sub_abc123",
    "attributes": {
      "status": "pending",
      "next_billing_schedule": "2026-03-27",
      "latest_invoice": {
        "id": "inv_def456",
        "attributes": {
          "payment_intent": {
            "id": "pi_ghi789",
            "attributes": {
              "client_secret": "pi_ghi789_secret_xyz",
              "checkout_url": "https://checkout.paymongo.com/..."
            }
          }
        }
      }
    }
  }
}
```

**Critical:** Save `latest_invoice.payment_intent.id` and `client_secret` - the customer must pay this first invoice within 24 hours or the subscription auto-cancels.

---

### Step 4: Create and Attach Payment Method

For subscriptions, only **card** and **maya** are supported.

**Create Payment Method:**
```
POST https://api.paymongo.com/v1/payment_methods
```

**For Card:**
```json
{
  "data": {
    "attributes": {
      "type": "card",
      "details": {
        "card_number": "4343434343434345",
        "exp_month": 2,
        "exp_year": 2029,
        "cvc": "123"
      },
      "billing": {
        "name": "John Doe",
        "email": "john@example.com"
      }
    }
  }
}
```

**Attach to Payment Intent:**
```
POST https://api.paymongo.com/v1/payment_intents/{payment_intent_id}/attach
```

```json
{
  "data": {
    "attributes": {
      "payment_method": "pm_abc123",
      "client_secret": "pi_ghi789_secret_xyz"
    }
  }
}
```

---

### Step 5: Handle 3D Secure / Authentication

If authentication is required, PayMongo will return:

```json
{
  "data": {
    "attributes": {
      "next_action": {
        "type": "redirect",
        "redirect": {
          "url": "https://3ds.paymongo.com/authenticate/..."
        }
      }
    }
  }
}
```

Redirect the customer to the `url`. After authentication, they'll return to your `success_url`.

---

### Step 6: Webhook Events for Subscriptions

Configure webhooks to listen for subscription events:

| Event | Description |
|-------|-------------|
| `subscription.created` | Subscription was created |
| `subscription.updated` | Status or schedule changed |
| `subscription.canceled` | Subscription was canceled |
| `invoice.created` | New invoice generated (1 day before billing) |
| `invoice.finalized` | Invoice finalized, payment will be attempted |
| `invoice.paid` | Invoice payment successful |
| `invoice.payment_failed` | Invoice payment failed |

**Webhook Payload Example (`invoice.paid`):**
```json
{
  "data": {
    "id": "evt_abc123",
    "type": "event",
    "attributes": {
      "type": "invoice.paid",
      "data": {
        "id": "inv_def456",
        "type": "invoice",
        "attributes": {
          "subscription_id": "sub_ghi789",
          "amount_due": 150000,
          "currency": "PHP",
          "status": "paid",
          "paid_at": 1709059200
        }
      }
    }
  }
}
```

---

## API Endpoints to Add to Your Backend

### 1. Create Subscription Plan (Admin Only)

```
POST /api/subscriptions/plans
```

```javascript
// Controller logic
async createPlan(req, res) {
  const { name, description, amount, interval, intervalCount, cycleCount } = req.body;
  
  const plan = await paymongoService.createPlan({
    name,
    description,
    amount: amount * 100, // Convert to centavos
    currency: 'PHP',
    interval,
    interval_count: intervalCount,
    cycle_count: cycleCount
  });
  
  // Save plan to your database with plan.id
  res.json({ success: true, planId: plan.id });
}
```

### 2. Create Customer Subscription

```
POST /api/subscriptions
```

```javascript
async createSubscription(req, res) {
  const { fullName, email, mobile, planId } = req.body;
  
  // 1. Create or get PayMongo customer
  const customer = await paymongoService.createCustomer({
    first_name: fullName.split(' ')[0],
    last_name: fullName.split(' ').slice(1).join(' '),
    email,
    phone: mobile
  });
  
  // 2. Create subscription
  const subscription = await paymongoService.createSubscription({
    customer_id: customer.id,
    plan_id: planId,
    anchor_date: new Date().toISOString().split('T')[0]
  });
  
  // 3. Extract payment intent for first payment
  const paymentIntent = subscription.attributes.latest_invoice.payment_intent;
  
  // 4. Save to your database
  await db.subscriptions.create({
    paymongoSubscriptionId: subscription.id,
    customerId: customer.id,
    planId,
    status: 'pending',
    nextBillingDate: subscription.attributes.next_billing_schedule,
    userEmail: email,
    paymentIntentId: paymentIntent.id
  });
  
  res.json({
    success: true,
    subscriptionId: subscription.id,
    checkoutUrl: paymentIntent.attributes.checkout_url,
    clientSecret: paymentIntent.attributes.client_secret
  });
}
```

### 3. Cancel Subscription

```
POST /api/subscriptions/:id/cancel
```

```javascript
async cancelSubscription(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  
  const result = await paymongoService.cancelSubscription(id, reason);
  
  await db.subscriptions.update(
    { status: 'canceled', cancellationReason: reason },
    { where: { paymongoSubscriptionId: id } }
  );
  
  res.json({ success: true, message: 'Subscription canceled' });
}
```

### 4. Get Subscription Status

```
GET /api/subscriptions/:id
```

```javascript
async getSubscription(req, res) {
  const { id } = req.params;
  
  const subscription = await paymongoService.getSubscription(id);
  
  res.json({
    id: subscription.id,
    status: subscription.attributes.status, // pending, active, canceled, past_due
    nextBillingDate: subscription.attributes.next_billing_schedule,
    anchorDate: subscription.attributes.anchor_date,
    plan: subscription.attributes.plan
  });
}
```

### 5. List User Subscriptions

```
GET /api/subscriptions/user/:email
```

### 6. Handle Subscription Webhooks

```
POST /api/subscriptions/webhook
```

```javascript
async handleSubscriptionWebhook(req, res) {
  const event = req.body;
  const eventType = event.data?.attributes?.type;
  
  switch (eventType) {
    case 'invoice.paid':
      await handleSuccessfulBilling(event.data.attributes.data);
      break;
    case 'invoice.payment_failed':
      await handleFailedBilling(event.data.attributes.data);
      break;
    case 'subscription.canceled':
      await handleCancellation(event.data.attributes.data);
      break;
  }
  
  res.status(200).json({ received: true });
}
```

---

## PayMongo Service Methods to Add

```javascript
// services/paymongoService.js

// Create a plan
async createPlan({ name, description, amount, currency, interval, interval_count, cycle_count }) {
  const response = await this.client.post('/plans', {
    data: {
      attributes: {
        name,
        description,
        amount,
        currency: currency.toUpperCase(),
        interval,
        interval_count,
        cycle_count
      }
    }
  });
  return response.data.data;
}

// Create a customer
async createCustomer({ first_name, last_name, email, phone }) {
  const response = await this.client.post('/customers', {
    data: {
      attributes: {
        first_name,
        last_name,
        email,
        phone
      }
    }
  });
  return response.data.data;
}

// Create a subscription
async createSubscription({ customer_id, plan_id, anchor_date }) {
  const response = await this.client.post('/subscriptions', {
    data: {
      attributes: {
        customer_id,
        plan_id,
        anchor_date
      }
    }
  });
  return response.data.data;
}

// Get subscription
async getSubscription(subscriptionId) {
  const response = await this.client.get(`/subscriptions/${subscriptionId}`);
  return response.data.data;
}

// Cancel subscription
async cancelSubscription(subscriptionId, cancellation_reason = '') {
  const response = await this.client.post(`/subscriptions/${subscriptionId}/cancel`, {
    data: {
      attributes: {
        cancellation_reason
      }
    }
  });
  return response.data.data;
}

// Update subscription (change plan)
async updateSubscription(subscriptionId, { plan_id }) {
  const response = await this.client.put(`/subscriptions/${subscriptionId}`, {
    data: {
      attributes: {
        plan_id
      }
    }
  });
  return response.data.data;
}

// List invoices for subscription
async listInvoices(subscriptionId) {
  const response = await this.client.get('/invoices', {
    params: { subscription_id: subscriptionId }
  });
  return response.data.data;
}
```

---

## Database Schema (Suggested)

```sql
CREATE TABLE subscription_plans (
  id INT PRIMARY KEY AUTO_INCREMENT,
  paymongo_plan_id VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  description TEXT,
  amount DECIMAL(10,2),
  currency VARCHAR(3) DEFAULT 'PHP',
  interval_type VARCHAR(20), -- monthly, weekly, yearly
  interval_count INT,
  cycle_count INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscriptions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  paymongo_subscription_id VARCHAR(255) NOT NULL,
  paymongo_customer_id VARCHAR(255),
  plan_id INT,
  user_email VARCHAR(255),
  status VARCHAR(50), -- pending, active, canceled, past_due
  anchor_date DATE,
  next_billing_date DATE,
  cancellation_reason TEXT,
  canceled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
);

CREATE TABLE subscription_invoices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  paymongo_invoice_id VARCHAR(255),
  subscription_id INT,
  amount_due DECIMAL(10,2),
  status VARCHAR(50), -- draft, finalized, paid, uncollectible
  billing_date DATE,
  paid_at TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);
```

---

## Important Considerations

### Payment Method Limitations
- **Subscriptions ONLY support Card and Maya**
- GCash, GrabPay, ShopeePay, and bank transfers cannot be used for recurring billing
- Consider offering both one-time (GCash) and subscription (Card/Maya) options

### Timing Requirements
- Customer must complete first payment within **24 hours** of subscription creation
- Set up webhook listeners to handle automatic retries for failed payments

### Invoice Adjustments
- You can add line items to adjust the next invoice amount before it's finalized
- Useful for prorated billing or variable amounts

### Testing Subscriptions
PayMongo provides a way to trigger test subscription cycles:
```
POST https://api.paymongo.com/v1/subscriptions/{id}/test-cycle
```

---

## Integration Flow Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Customer      │────▶│  Selects Monthly │────▶│  Backend Creates │
│   Selects Plan  │     │   Subscription   │     │  PayMongo Plan   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                              ┌────────────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │  Create Customer │
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ Create Subscription│
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  First Payment   │◀── Card/Maya only
                    │  (within 24hrs)  │
                    └──────────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              ┌─────────┐          ┌──────────┐
              │ Success │          │  Fail    │
              │ Active  │          │  Cancel  │
              └─────────┘          └──────────┘
                    │
                    ▼
           ┌────────────────┐
           │ Monthly Billing │◀── Auto by PayMongo
           │   Continues     │
           └────────────────┘
```

---

## Next Steps

1. **Decide on Plan Structure** - What plans will you offer? (e.g., Basic ₱999/mo, Premium ₱1,999/mo)
2. **Database Setup** - Add tables for plans, subscriptions, and invoices
3. **Backend Implementation** - Add the service methods and controllers
4. **Frontend Updates** - Show subscription options alongside one-time purchases
5. **Webhook Configuration** - Set up webhook endpoints in PayMongo dashboard
6. **Testing** - Use PayMongo's test cycle feature to verify billing flow

Would you like me to implement any specific part of this subscription system?
