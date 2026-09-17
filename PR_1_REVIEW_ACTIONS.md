# PR #1 Review Actions

PR: https://github.com/Prince0643/p-backend/pull/1  
Branch: `feature/coupon-affiliate-validation`

## Summary

Please do not merge this PR yet. The feature direction is good, and the new `web/` Next.js app currently passes lint/build, but there are a few release-blocking items around coupon redemption correctness, webhook security configuration, and backend verification.

## Blockers

### 1. One-time affiliate coupons can be used by multiple unpaid checkouts

Affiliate coupons are created with `maxRedemptions: 1`, but the code only counts rows in `coupon_redemptions` when validating a coupon. Those rows are inserted only after a `payment.paid` webhook.

Current flow:

1. Customer A starts checkout with affiliate coupon.
2. No redemption row is created yet.
3. Customer B starts checkout with the same coupon before A pays.
4. Both checkouts can pass validation.
5. If both pay, the one-time coupon has effectively been used more than once.

Relevant files:

- `utils/couponStore.js`
- `controllers/paymentController.js`
- `db/schema.sql`

Required fix:

- Add a reservation or pending-redemption mechanism at checkout creation time, not only after payment.
- The `maxRedemptions` check must include pending/reserved redemptions.
- Webhooks should then update the existing redemption from pending/reserved to paid or failed/expired.
- Add a uniqueness guard around `payment_reference` so webhook retries cannot duplicate redemption records.

Suggested acceptance criteria:

- Two concurrent checkout creation requests using the same `maxRedemptions: 1` coupon cannot both succeed.
- A paid webhook updates the original reservation instead of inserting a duplicate redemption.
- Retried `payment.paid` webhooks are idempotent.
- Abandoned or failed payments eventually release or mark the reservation so the coupon does not get stuck forever.

### 2. PayMongo webhook verification still fails open unless env is configured

`PAYMONGO_WEBHOOK_SECRET` is currently optional. If it is missing, the webhook route continues processing requests without signature verification.

Relevant file:

- `middleware/paymongoWebhook.js`

Required fix or deployment gate:

- For production, set `PAYMONGO_WEBHOOK_SECRET` before deploying.
- Ideally fail closed in production when the secret is missing:

```js
if (!secret && process.env.NODE_ENV === 'production') {
  return res.status(500).json({ error: 'Webhook verification is not configured' });
}
```

Suggested acceptance criteria:

- In production, missing `PAYMONGO_WEBHOOK_SECRET` does not allow unsigned webhook processing.
- With the secret set, missing or forged signatures return `401`.
- A valid PayMongo signature is accepted.

### 3. Backend migration/runtime requires `DATABASE_URL`

The PR replaces JSON runtime stores with Postgres. Without `DATABASE_URL`, backend stores and migration fail.

Relevant files:

- `db/pool.js`
- `db/migrate.js`
- `API_DOCUMENTATION.md`

Required action:

- Confirm the production deployment has a Postgres database.
- Set `DATABASE_URL`.
- Run `npm run migrate` before routing production traffic to this version.
- Confirm products are correctly seeded from `data/products.json`.

Suggested acceptance criteria:

- Fresh database plus `npm run migrate` creates all tables and imports products/coupons.
- `/api/admin/products` returns seeded products after migration.
- Payment creation works with an existing seeded product.

## Important Follow-Ups

### 4. Backend dependency audit has high vulnerabilities

Running `npm audit --audit-level=high` reports high-severity advisories in backend dependencies, including `axios`, `form-data`, `path-to-regexp`, `brace-expansion`, `minimatch`, and `picomatch`.

Required action:

- Run `npm audit fix` where safe.
- Review any breaking upgrades separately.
- At minimum, update direct dependencies where available, especially `axios`.

### 5. Add automated backend tests for the money paths

The backend currently has no test script. This PR changes payment, coupon, affiliate, webhook, and database behavior, so it should have regression coverage before merge.

Recommended tests:

- Valid coupon discounts server-side price.
- Invalid/inactive/expired coupon is rejected.
- Product-ineligible coupon is rejected.
- `maxRedemptions: 1` blocks concurrent second checkout.
- `payment.paid` webhook is idempotent.
- Forged webhook signature is rejected when `PAYMONGO_WEBHOOK_SECRET` is set.
- Affiliate suspension deactivates linked coupon.
- Affiliate reactivation does not bypass redemption caps.

## Verified Locally

These checks passed locally:

```bash
cd web
npm run lint
npm run build
```

This check also passed locally, against a local Docker Postgres container with `DATABASE_URL` set in `.env`:

```bash
npm run migrate
```

Output: schema applied, 25 products / 1 coupon imported, migration completed without error.

Note: this only confirms `migrate.js` and the schema are correct against a fresh/dev database. It does **not** confirm `DATABASE_URL` is set, or that migration has been run, in the actual production/deployment environment — that is still open (see Blocker 3).

## Merge Recommendation

Merge only after:

1. One-time coupon reservation/idempotency is fixed.
2. Production webhook verification cannot fail open.
3. `DATABASE_URL` and migration are verified in the target environment.
4. Backend dependency audit is addressed or explicitly accepted.
5. Money-path regression tests are added or a manual verification log is attached.
