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
Production: https://api.nexistrydigitalsolutions.com/api
Health Check: https://api.nexistrydigitalsolutions.com/health
```

Replace the base URL if you're running in a different environment.

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
| `productId` | string | Yes* | Product ID from the backend catalog (recommended) |
| `product` | string | Yes* | Product name from the backend catalog (legacy) |
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
| `all` | Let backend include all available PayMongo methods (recommended default) | Mixed |
| `qrph` | QRPh only | QR |
| `gcash` | GCash E-Wallet | E-Wallet |
| `grabpay` | GrabPay E-Wallet | E-Wallet |
| `maya` | Maya E-Wallet | E-Wallet |
| `shopeepay` | ShopeePay E-Wallet | E-Wallet |
| `dob` | Online Banking (PayMongo renders the bank list in checkout; includes BPI/UnionBank only if enabled for your merchant) | Bank |
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

> Note: Products are now catalog-backed. Add/edit products via the admin UI (`/admin/products`) or the admin API, then use the generated snippet on your HTML pages.

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
    { "id": "dob", "name": "Online Banking", "icon": "online-banking-icon.png", "category": "bank" },
    { "id": "card", "name": "Credit/Debit Card", "icon": "card-icon.png", "category": "card" }
  ]
}
```

---

### 6. PayMongo Capabilities (Diagnostic)

**GET** `/api/payments/capabilities`

Returns PayMongo merchant payment method capabilities (sanitized). Use this to confirm whether `dob` (Direct Online Banking) is enabled for the merchant.

#### Optional authentication

If the backend has `DIAGNOSTIC_TOKEN` set, include an `x-diagnostic-token` header matching that value.

#### Example (curl)

```bash
curl -sS https://api.nexistrydigitalsolutions.com/api/payments/capabilities
```

With token:

```bash
curl -sS https://api.nexistrydigitalsolutions.com/api/payments/capabilities \
  -H "x-diagnostic-token: YOUR_DIAGNOSTIC_TOKEN"
```

#### Response (example)

```json
{
  "success": true,
  "count": 6,
  "capabilities": [
    { "id": "pm_xxx", "type": "payment_method", "methodType": "dob", "status": "enabled", "brand": null, "country": "PH" }
  ]
}
```

#### Error response

If PayMongo returns an unexpected response shape or the upstream request fails, this endpoint returns HTTP `502`.

---

### 7. Validate Payment Details

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

### 8. Health Check

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

### 9. Root Endpoint (API Info)

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
    "paymongoCapabilities": "/api/payments/capabilities",
    "health": "/health"
  }
}
```

---

## GHL Coupon Tracking & Affiliate Commissions (Admin)

All routes are under `/api/admin` and require admin auth (`x-api-key` or admin token).

- The scheduled importer (every 10 min in production) reads native GHL orders from the GLOBAL location (`GHL_GLOBAL_LOCATION_ID`, key from `GHL_LOCATIONS_JSON` or `GHL_GLOBAL_PRIVATE_KEY`) and the MAIN location (`GHL_LOCATION_ID` + `GHL_PRIVATE_KEY`). Every paid, live, non-invoice order with a coupon code is recorded (`source='ghl'`, idempotent per order id). Unknown codes are auto-created as `type='general'`, `origin='ghl'`, `local_enabled=false` and are never pushed back to GHL. Commission base = `subtotal - discount` (no tax/shipping); the affiliate fee is credited only when the coupon has an affiliate, otherwise `affiliate_email` is NULL and fee 0.
- **Solutions mirror**: the same importer also upserts EVERY non-invoice GHL order (live or test-mode, with or without a coupon) into `digital_solutions_transactions` as `type='ghl_order'`, `transaction_id='ghl:<orderId>'`, `source='ghl'` (idempotent on `transaction_id`). Status maps from GHL `paymentStatus` (`paid`, `refunded`, `partially_refunded`, `failed`; `unpaid`/empty -> `pending`; anything else its lowercased value) and is updated on later runs; the order detail is only re-fetched when the row is new or its status changed. `is_test=true` for `liveMode=false` / `markAsTest` orders - these are excluded from dashboard revenue. (Test coupon redemptions: see "Test-mode redemptions" below.) Amount = order-level paid total (detail `amount`, falling back to list `amount`). `GET /payments/orders` returns live and test orders by default (no `paymentMode` needed). Import summary gains `solutionsRecorded`, `solutionsUpdated` (and `wouldRecordSolutions` on dry runs). Invoice-sourced orders (our PayMongo mirror) stay skipped.
- `GET /api/admin/solutions[?type=&status=&companyId=&email=&isTest=true|false]` rows now include `isTest`, and for `ghl_order` rows `ghlOrderId`, `ghlLocationId`, `ghlLocationKey` (`global`/`main`/null), `ghlProductIds`, `ghlPaymentStatus`, `promoCode`. `GET /api/admin/solutions/:transactionId` additionally returns `transaction.raw` (small snapshot of the GHL detail: totals, items, mode) and, for `ghl_order`, `redemption` (the linked `coupon_redemptions` row: `code`, `state` = `active`/`refunded`/`flagged`, `affiliateEmail`, `commissionBase`, `affiliateFeeAmount`, ...) or `null` (no coupon, or not credited / unknown test code). Test orders return their test redemption with `isTest: true`.
- Local (PayMongo) commission = pre-tax, post-discount amount x affiliate fee %; `coupon_redemptions.commission_base` records the basis for both channels. Campaign attribution is no longer set on new sales.
- Affiliate coupons (`origin='local'`) are pushed to GHL GLOBAL + MAIN on registration and on admin create/update; per-location state lives in `coupons.ghl_sync` and failed pushes are retried at the start of each import run.
- `POST /api/admin/coupons/ghl/import-orders` `{ backfill? }` returns the aggregate summary plus `locations.global` / `locations.main`.

| Route | Purpose |
|-------|---------|
| `GET /ghl-coupons` | `{ coupons: [{ code, origin, type, discountPercent, affiliate: {email,name}\|null, locations: [{ key: 'global'\|'main', locationId, ghlCouponId, status }], usage: { paidCount, unassignedCount } }], errors: [string] }`. `status` is GHL's coupon status, or `missing` / `pending` / `error` / `unknown` (list failed). |
| `POST /ghl-coupons/:code/assign` | Body `{ affiliateEmail, affiliateFeePercent? }` (fraction, default 0.10). 404 unknown code, 400 unknown affiliate / bad fee / registration coupon. Returns `{ coupon, creditable: [redemption] }`. |
| `POST /ghl-coupons/:code/credit-past` | Body `{ redemptionIds? }`. Credits unassigned paid GHL rows: fee = `commission_base` x coupon fee %. Returns `{ credited, totalsByCurrency: { USD: { commission } } }`. 409 if no affiliate. |
| `POST /ghl-coupons/:code/unassign` | GHL-origin coupons only (400 otherwise): type back to `general`, affiliate cleared; past credited rows untouched. |
| `GET /coupons/:code/usage` | `{ code, redemptions: [{ id, source, status, email, fullName, currency, baseAmount, discountAmount, commissionBase, affiliateFeeAmount, affiliateEmail, createdAt, ghlOrderId, ghlLocationKey, isTest }], totalsByCurrency: { [cur]: { orders, revenue, discount, commission } } }` (paid LIVE rows only in totals; `isTest` rows are listed but not counted). |

`GET /api/affiliates/me`, `GET /api/admin/affiliates` (per affiliate) and `GET /api/admin/affiliates/:id` now include `totalsByCurrency: { PHP: { sales, commission, earned, paidOut, unpaid }, USD: {...} }` alongside the existing fields (`commission` == `earned`).

**Test-mode redemptions** (`coupon_redemptions.is_test`, default false): a PAID GHL test order (`liveMode:false` / `markAsTest`) with a coupon we already know now creates a redemption with the same commission math (fee % x (subtotal - discount), pre-tax; same affiliate resolution) and `is_test=true`, so the affiliate flow can be verified without real money. A test order with an unknown code creates NO coupon and NO redemption (`skipped.testUnknownCoupon` in the import summary; `skipped.test` was removed). Refunds / partial refunds of test orders update their rows like live ones; existing test orders backfill on the next import run (within the lookback window, or with `backfill`). Test rows are NEVER counted as real money: they are excluded from affiliate/coupon totals, sales counts, commission and payout figures (they cannot be marked paid out), campaign stats, coupon usage counts, `max_redemptions`, one-affiliate-discount-per-customer checks, pending holds and `credit-past`. They are only listed, flagged `isTest: true` (`GET /api/admin/coupons/redemptions`, `/coupons/:code/usage`, `GET /api/affiliates/me` `redemptions`, `GET /api/admin/affiliates/:id` `redemptions`). Separate test figures: `testTotalsByCurrency: { USD: { sales, commission } }` on `GET /api/admin/affiliates` (per affiliate), `GET /api/admin/affiliates/:id` and `GET /api/affiliates/me`; `GET /api/affiliates/me` `stats.totalRedemptions`/`paidRedemptions`/`totalEarnings` are live-only, plus `stats.testRedemptions`.

Scripts: `node scripts/backfillGhlCouponOrders.js [--apply]` (full-history backfill, dry-run by default) and `node scripts/pushAffiliateCouponsToGhl.js [--apply]` (pushes existing local affiliate coupons to GLOBAL + MAIN, skipping ones already present).

---

## Per-customer coupon limits (Admin)

A customer is identified by lowercased email; only `status='paid'`, `is_test=false` redemptions count (this includes imported GHL orders, and refunded ones still count). Pending holds and test rows never count. `max_redemptions` (total cap across all customers) is unchanged.

- **General coupons**: `maxRedemptionsPerCustomer` on `POST /api/admin/coupons` and `PUT /api/admin/coupons/:code` - a positive integer, or `null`/`''` for unlimited. Counted per code across all products. Omitted: default `1` on create, existing value kept on update. Invalid values (0, negatives, non-integers) return 400 `maxRedemptionsPerCustomer must be a positive integer, if set`. Rejection: reason `coupon_already_used`, message `You have already used this coupon.` (limit 1) or `You have reached the limit for this coupon.` (limit > 1); it reaches `/api/embed/quote` as `promo.message` and the checkout error like other coupon rejections. Migration: existing local general coupons are set to 1; GHL-sourced coupons take 1 only when `ghl_coupon_meta.limitPerCustomer` was stored as true, otherwise NULL (unlimited).
- **Affiliate coupons**: ignore the per-coupon field (stored NULL). One global setting, `affiliateDiscountsPerCustomer`, in `GET`/`PUT /api/admin/settings` (positive integer, or `null`/`''` for unlimited; default 1; stored in `app_settings`), counted across ALL affiliate codes. Rejection: reason `affiliate_already_used`, `You have already used an affiliate discount.` (limit 1) or `You have reached the limit for affiliate discounts.`. Changing it re-pushes affiliate coupons to GHL in the background (non-fatal).
- **GHL**: only the boolean `limitPerCustomer` exists. Limit 1 -> `true`; > 1 or unlimited -> `false`. Affiliate coupons use `true` only when the global setting is 1 (`couponNeedsUpdate` detects drift). For GHL-origin general coupons, editing the limit pushes `limitPerCustomer` to GHL only when the value actually changed (all other GHL fields preserved; failures never fail the save). Future GHL imports set 1 when GHL's `limitPerCustomer` is true, else unlimited.

## Per-checkout PayMongo TEST mode (Admin)

The site is always **live**. There is no global switch. An admin can run a single checkout in PayMongo **test mode** (PayMongo test cards / e-wallets) to test forms end to end.

### 1. Get a test token

**POST** `/api/admin/test-checkout-token` (admin auth: `Authorization: Bearer <admin token>` or `x-api-key`)

```json
{ "success": true, "token": "<signed token>", "expiresAt": "2026-01-01T12:00:00.000Z", "mode": "test" }
```

The token is HMAC-signed with `AUTH_TOKEN_SECRET`, expires after about 2 hours, carries the admin email and is a different token type from admin session tokens (a session token is rejected as a test token). Returns `503` if the `PAYMONGO_TEST_*` env vars are missing.

### 2. Use it on a checkout

Send the token as `testToken` (JSON body) or the `x-nx-test-token` header to:
- `POST /api/payments/create-payment-intent`
- `POST /api/embed/checkout` (body field `testToken`)
- `GET /api/payments/methods`, `GET /api/payments/capabilities` (header or `?testToken=`) - answered from the test account; `/methods` also returns `mode: "test"` and the test `publicKey`.

| Situation | Result |
|-----------|--------|
| No token | Live, exactly as before |
| Valid token | Test keys used; the checkout response includes `testMode: true` |
| Invalid / expired / wrong-type token, or revoked admin | `403` `{ "error": "Invalid or expired test checkout token" }` |
| Valid token but test env missing | `503` - never falls back to live |
| `POST /api/clockistry/create-payment-intent` with a token | `400` (Clockistry is live-only) |

### What a test checkout does

- The `digital_solutions_transactions` row has `is_test = true` (TEST badge in Solutions, excluded from dashboard revenue) and stores the PayMongo payment intent id (`paymongo_payment_intent_id`).
- **Status polling** (`GET /api/payments/status/:id`, `/retry/:id`) always uses the mode stored on that row, never the caller's input (the response has `testMode: true` for test intents).
- Coupon reservations and redemptions are created with `is_test = true`: they do not count toward the coupon's live limit, live pending holds, "already used" checks, payouts or totals, and never release a live hold.
- On payment, **no GHL contact upsert, invoice or invoice schedule** is created.
- The GHL student user (`ghl_practice_access`, `ghl_premium_plan`) is still created; `ghl_student_users.is_test = true`.
- The LeadConnector webhook is still sent (`payment_initiated`, `payment_successful`, `payment_failed`, student follow-up) with top-level `isTest: true` and `livemode: false`. Live payloads are unchanged.

### Admin UI and embeds

Admin > Products > select a product > **Test checkout** opens `/admin/test-checkout` in a new tab. The token travels in the URL fragment (never sent to a server) and is passed to `nx-embed.js` through the `data-nx-test` attribute. The form shows a **TEST MODE - no real charge** banner and the page lists PayMongo test cards. The token is never part of the public embed snippet.

To test a real funnel page, open it with `?nx_test=<token>` (the token is shown on the test checkout page). `nx-embed.js` (and the generated product-page snippet) read it from the URL only and send it as `testToken`; nothing is stored in cookies/localStorage.

### Test webhook verification

`Paymongo-Signature: t=<ts>,te=<test hmac>,li=<live hmac>`. Per PayMongo, live events populate `li` (te empty), test events populate `te` (li empty). `li` is verified only with `PAYMONGO_WEBHOOK_SECRET`, `te` only with `PAYMONGO_TEST_WEBHOOK_SECRET`. The verified mode must equal the payload's `data.attributes.livemode`, otherwise `400`. A test event only updates records created in test mode, and a live event only live records (mismatches are acknowledged with `200` and ignored). A missing live secret in production still fails closed (`500`).

**PayMongo test cards** (any future expiry, any 3-digit CVC; source: PayMongo "Testing" docs):

| Number | Result |
|--------|--------|
| `4343434343434345` | Visa, success |
| `4571736000000075` | Visa, success |
| `5123000000000002` | Mastercard, success |
| `4120000000000007` | Visa, success with 3DS (choose Authorize) |
| `4200000000000018` / `4300000000000017` / `5100000000000198` / `4111111111111111` | Declined: expired card / invalid CVC / insufficient funds / generic |

E-wallets (GCash, Maya, GrabPay, ShopeePay): open the redirect page and choose Authorize or Fail.

---

## Per-product coupon config (Admin)

All routes are under `/api/admin` and need the admin API key. A "product" is a local product
(`kind=local`, `ref` = products.id) or a GHL product in a tracked location (`kind=ghl`,
`location=global|main`, `ref` = GHL product id). Default is ALLOWED: one switch
(`affiliateCouponsEnabled`) covers all affiliate coupons and a block list
(`disabledCouponCodes`) covers general coupons, so new coupons work everywhere until switched
off. This applies in addition to a coupon's own eligible-products list (`coupon_products`).

- `GET /ghl-products` - `{ locations: [{ key, locationId, products: [{ id, name, price }], error? }] }`.
- `GET /product-coupon-config?kind=&ref=[&location=]` - `{ product, affiliateCouponsEnabled, coupons: [{ code, discountPercent, active, origin, enabled, eligible, ineligibleReason }] }` (the general coupons relevant to that product).
- `PUT /product-coupon-config` - body `{ kind, location?, ref, name?, affiliateCouponsEnabled, disabledCouponCodes }`; replaces the product's config (400 on a bad kind/location/ref or unknown coupon code) and returns the GET shape plus `ghlSync: { attempted, errors: [{ code, locationKey, error }] }`. GHL failures never fail the save.
- `POST /product-coupon-config/ghl-sync` - full re-sync now, `{ results, errors }`.
- `GET /products` includes `couponConfig: { affiliateCouponsEnabled, disabledCouponCount }` per product.

Local enforcement: quote and checkout reject a blocked coupon with `This coupon is not valid for
this product.` (reason `product_coupon_disabled`); a blocked `?ref=` code at checkout returns
400 with that error instead of being silently dropped.

GHL: for each coupon at each tracked location where it exists, `productIds` = the location's
products, limited to the coupon's original GHL restriction (snapshotted in `coupons.ghl_product_sync`),
minus blocked products. Nothing blocked restores the original; nothing allowed deactivates the
coupon there (reactivated when allowed again). A production job re-syncs every 10 minutes so new
GHL products are allowed by default.

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

#### Database (Required)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string, e.g. `postgres://user:password@host:5432/dbname`. All product, coupon, affiliate, and digital-solutions data lives in Postgres now (see `db/schema.sql`) — the old `data/*.json` files are only used as a one-time seed source by `db/migrate.js`. |

Run `npm run migrate` (i.e. `node db/migrate.js`) once against a fresh database to create the schema (`db/schema.sql`) and import any existing `data/*.json` content. Safe to re-run — inserts are `ON CONFLICT DO NOTHING`/idempotent.

#### PayMongo Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYMONGO_SECRET_KEY` | Yes | PayMongo API secret key (sk_...) |
| `PAYMONGO_PUBLIC_KEY` | No | PayMongo public key (pk_...) |
| `PAYMONGO_TEST_SECRET_KEY` | No | PayMongo **test** secret key (`sk_test_...`). With the two below, enables per-checkout test mode. If missing, test mode is unavailable (503), never a fallback to live. |
| `PAYMONGO_TEST_PUBLIC_KEY` | No | PayMongo test public key (`pk_test_...`) |
| `PAYMONGO_TEST_WEBHOOK_SECRET` | No | Signing secret (`whsk_...`) of the test-mode webhook (same URL as live) |
| `TAX_RATE` | Yes | Tax rate as decimal (e.g., `0.10` for 10%) |
| `PAYMONGO_FILTER_METHOD_TYPES` | No | Set to `true` to filter checkout methods using PayMongo merchant capabilities |
| `DIAGNOSTIC_TOKEN` | No | If set, requires `x-diagnostic-token` for `/api/payments/capabilities` |

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

Notes:
- You can override `success_url` / `cancel_url` per product via `data/products.json` using `defaults.successUrl` and `defaults.cancelUrl`.
- Precedence is: request body (`successUrl`/`cancelUrl`) > product catalog > env vars/defaults.
- For `source=nexistry_core_ph`, per-product/request overrides still apply; otherwise it falls back to `NX_CORE_FRONTEND_SUCCESS_URL` / the core default redirect URLs.

#### GHL Integration (Optional)

| Variable | Required | Description |
|----------|----------|-------------|
| `GHL_PRIVATE_KEY` | No | GoHighLevel API private key |
| `GHL_LOCATION_ID` | No | GoHighLevel location ID |
| `GHL_BUSINESS_NAME` | No | Business name for invoices (default: "Nexistry Academy") |
| `GHL_LOCATION_ID_NEXISTRY_ACADEMY_STUDENTS` | No | GHL sub-account "Nexistry Academy (Students)" (`v2W0eRHua65rErE7Jsw2`) where student users are created |
| `GHL_PRIVATE_KEY_NEXISTRY_ACADEMY_STUDENTS` | No | Private Integration token of that location (needs `users.readonly` + `users.write`) |
| `GHL_STUDENTS_COMPANY_ID` | No | GHL agency/company id required by Create User (default `hv6XwC1sqbvEgneGm5AY`) |
| `GHL_STUDENT_USER_PRODUCTS` | No | Comma-separated product ids that auto-create a GHL student user (default `ghl_practice_access,ghl_premium_plan`) |

**GHL student accounts.** When a `payment.paid` webhook arrives for a product in `GHL_STUDENT_USER_PRODUCTS`, `services/ghlStudentUsers.js` looks the buyer's email up in the Students location (`GET /users/?locationId=...`, case-insensitive match, then a best-effort `GET /users/search`), and if absent creates a GHL user (`POST /users/`, `type: account`, `role: admin`, template in `services/ghlStudentUserTemplate.js`) with a random 16-character password. The result is recorded in `ghl_student_users` (one row per payment reference; status `pending|created|existing|failed`, GHL user id, error, attempts; the password is never stored or logged) and the paid LeadConnector webhook gets an extra field:

```json
"ghlStudentAccount": { "email": "buyer@example.com", "password": "<only when status=created>", "loginUrl": "https://app.gohighlevel.com/", "status": "created" }
```

`status` is `created`, `existing` (user already in the location; nothing changed, no password) or `failed` (no password). Failed rows are retried every 10 minutes in production (up to 5 attempts); a successful retry sends a follow-up LeadConnector webhook `{ "event": "ghl_student_account_created", "paymentReference", "productId", "fullName", "email", "ghlStudentAccount": {...} }`. Admin: `GET /api/admin/ghl-student-users?status=&email=&limit=` lists the rows; the Solutions page Audit panel shows the status for these products. Manual create/retry: `node scripts/createGhlStudentUser.js --payment-ref REF | --email E --name N [--product ID] [--apply] [--print-password]` (dry run by default).

#### LeadConnector Webhook (Optional)

| Variable | Required | Description |
|----------|----------|-------------|
| `LEADCONNECTOR_WEBHOOK` | No | LeadConnector webhook URL for payment notifications |
| `DISABLE_LEADCONNECTOR_WEBHOOK` | No | Set to `true` to disable LeadConnector webhooks |

#### PayMongo Webhook Signature Verification (Strongly recommended)

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYMONGO_WEBHOOK_SECRET` | No (but see below) | Signing secret shown when the webhook is created in the PayMongo dashboard/API. Verifies the `Paymongo-Signature` header on incoming `/api/payments/webhook` requests. |

Until this is set, `/api/payments/webhook` accepts any request body with no authentication — anyone who finds the URL can POST fake `payment.paid` events and trigger GHL invoice creation/affiliate payouts. Set this in every environment as soon as the webhook is created in PayMongo.

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

# Database (required)
DATABASE_URL=postgres://user:password@host:5432/dbname

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

# PayMongo webhook signature verification (strongly recommended)
PAYMONGO_WEBHOOK_SECRET=whsk_xxxxxxxxxxxxxxxx
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

## Public Embed API (`/api/embed`)

Used by the embeddable checkout widget (`GET /public/nx-embed.js`, served cross-origin) pasted into GoHighLevel custom code. Open CORS (`Access-Control-Allow-Origin: *`, no credentials), JSON bodies up to 32kb, per-IP rate limits (429 `{ error }`): products 120/min, quote 60/min, checkout 15/15min. Prices are always computed server-side; tax precedence is `source === 'nexistry_core_ph'` override, then the product's own `taxRate` (0 allowed), then legacy env fallback (`TAX_RATE`).

### GET `/api/embed/products/:id`
Lookup by id only. 200 `{ product: { id, name, currency, amountPhp, taxRate, billing: { type, interval }, displaySuffix } }` (`taxRate` is a fraction, e.g. 0.1; `interval` is null for one_time). 404 `{ error: 'Product not found' }`.

### POST `/api/embed/quote`
Body `{ productId, promoCode?, email?, campaign? }`. Read-only (never reserves a coupon). 200:
`{ productId, name, currency, billing, displaySuffix, subtotal, discountPercent (fraction), discountAmount, taxRate (fraction), taxAmount, total, promo, renewal }`
- `promo` is `null` without a code, else `{ code, applied, message }`; an invalid/expired/out-of-scope/already-used code is `applied: false` (never a 400).
- `renewal` is `null` for one_time, else `{ amount, interval: 'monthly' }` (full taxed price, no discount).
- 400 if `productId` is missing, 404 for an unknown product.

### POST `/api/embed/checkout`
Body `{ productId, fullName, email, mobile, promoCode?, businessName?, notes?, campaign?, attributionRef?, referredBy? }`. Delegates to `create-payment-intent` (same response incl. `checkoutUrl`, same error shapes). Client `successUrl`/`cancelUrl`/`source`/`paymentMethod`/`amount` are ignored: redirect URLs come from the product/env defaults, `source` and `paymentMethod` from the product.

### Admin products
`POST /api/admin/products` creates (id slugged from `name`, or explicit `id`); 409 if the id exists. `PUT /api/admin/products/:id` updates the row with that URL id (id is frozen, never re-slugged on rename); 404 if missing.
