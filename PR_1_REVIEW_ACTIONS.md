# PR #1 Review Actions

PR: https://github.com/Prince0643/p-backend/pull/1  
Branch: `feature/coupon-affiliate-validation`

## Summary

Please do not merge this PR yet. The feature direction is good, and the new `web/` Next.js app currently passes lint/build, but there are a few release-blocking items around coupon redemption correctness, webhook security configuration, and backend verification.

## Status (updated 2026-09-18)

| # | Item | Status |
|---|------|--------|
| 1 | One-time coupon reservation/idempotency | **RESOLVED** — `d23fc81` |
| 2 | Webhook fails open when secret missing | **RESOLVED** — `4ace1a9` |
| 3 | Required prod env vars set + migration run (`DATABASE_URL`, `PAYMONGO_WEBHOOK_SECRET`, `AUTH_TOKEN_SECRET`, `ADMIN_API_KEY`) | **Still open** — needs whoever has deployment access, not fixable from a dev machine |
| 4 | Dependency audit | **RESOLVED** — `c5e21af` (0 vulnerabilities) |
| 5 | Money-path regression tests | **RESOLVED** — `cd24fbe` (`npm test`, 13/13 passing) |

Only item 3 remains before merge, and it's an infrastructure/access question rather than a code change.

## Blockers

### 1. One-time affiliate coupons can be used by multiple unpaid checkouts

**RESOLVED (`d23fc81`).** Coupons are now reserved atomically at checkout creation (`couponStore.beginCouponReservation`/`finalizeCouponReservation`, using `SELECT ... FOR UPDATE` to lock the coupon row), not only recorded after payment. The webhook confirms the existing reservation (`markReservationPaid`) instead of inserting a new row, making retries idempotent; `payment.failed` releases the hold via `releaseReservation`. Verified live: two concurrent checkouts on the same `maxRedemptions: 1` coupon — one succeeds, one is correctly rejected; a resent `payment.paid` webhook doesn't create a duplicate row; a failed payment frees the coupon back up. Covered by `tests/coupons.test.js` and `tests/webhook.test.js`.

<details>
<summary>Original finding</summary>

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

</details>

### 2. PayMongo webhook verification still fails open unless env is configured

**RESOLVED (`4ace1a9`).** `middleware/paymongoWebhook.js` now returns `500` and never processes the request when `PAYMONGO_WEBHOOK_SECRET` is unset and `NODE_ENV === 'production'`. Non-production environments keep the fail-open-with-warning behavior so local dev isn't blocked. Verified live in all 3 states: prod + no secret → `500`; prod + secret + forged signature → `401`; prod + secret + valid signature → `200`. Covered by `tests/webhook.test.js`.

<details>
<summary>Original finding</summary>

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

</details>

### 3. Backend migration/runtime requires `DATABASE_URL` (and other required env vars)

**Still open.** This is an infrastructure/access question, not something fixable from a dev machine — see Status table above. Godwin has confirmed he does not have production/Hostinger server access; this is blocked on whoever does.

The PR replaces JSON runtime stores with Postgres. Without `DATABASE_URL`, backend stores and migration fail.

Relevant files:

- `db/pool.js`
- `db/migrate.js`
- `utils/authToken.js`
- `API_DOCUMENTATION.md`

Required action — every one of these must be set in the actual production environment before this branch is safe to route real traffic to (none of them are set anywhere except this dev machine's local `.env`):

- `DATABASE_URL` — confirm the production deployment has a Postgres database, set this, then run `npm run migrate` before routing traffic. Confirm products are correctly seeded from `data/products.json`.
- `PAYMONGO_WEBHOOK_SECRET` — see Blocker 2. Without it, production now fails closed (500) rather than silently accepting unsigned webhooks, so this isn't optional to skip anymore.
- `AUTH_TOKEN_SECRET` — **new as of the 2026-09-18 admin/affiliate login work** (`a955287`). Signs every admin and affiliate session token (`utils/authToken.js`). If unset, `POST /api/admin/auth/login` and `POST /api/affiliates/login` will throw ("AUTH_TOKEN_SECRET is not configured") - nobody can log into either console without it. Generate a fresh random value for production; don't reuse the local dev one.
- `ADMIN_API_KEY` (or `API_KEY`) — still works as the permanent master/bootstrap admin credential (`middleware/adminAuth.js`), needed to create the first real admin account in production via `POST /api/admin/admins`.

Suggested acceptance criteria:

- Fresh database plus `npm run migrate` creates all tables and imports products/coupons.
- `/api/admin/products` returns seeded products after migration.
- Payment creation works with an existing seeded product.
- `POST /api/admin/auth/login` and `POST /api/affiliates/login` work (not a 500 about missing `AUTH_TOKEN_SECRET`).
- The master key can create a first real admin account via `POST /api/admin/admins`.

## Important Follow-Ups

### 4. Backend dependency audit has high vulnerabilities

**RESOLVED (`c5e21af`).** `npm audit fix` resolved everything except `qs` (stuck on express's pinned `~6.14.0` range — fixed via an `overrides` entry forcing `^6.16.0`) and `uuid` (only a breaking-change fix existed, but it turned out to be unused in the codebase — removed instead of force-upgrading). `npm audit` now reports 0 vulnerabilities.

<details>
<summary>Original finding</summary>

Running `npm audit --audit-level=high` reports high-severity advisories in backend dependencies, including `axios`, `form-data`, `path-to-regexp`, `brace-expansion`, `minimatch`, and `picomatch`.

Required action:

- Run `npm audit fix` where safe.
- Review any breaking upgrades separately.
- At minimum, update direct dependencies where available, especially `axios`.

</details>

### 5. Add automated backend tests for the money paths

**RESOLVED (`cd24fbe`).** Added a suite using Node's built-in `node:test` runner + `supertest` (`npm test`, 13/13 passing) covering every item on the recommended list below, plus `payment.failed` release behavior and the production fail-closed case from item 2. Tests run against a dedicated `pbackend_test` database (never the real dev/prod DB) and clean up after themselves.

<details>
<summary>Original finding</summary>

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

</details>

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

Also now passing locally:

```bash
npm test        # 13/13 passing (tests/, against a dedicated pbackend_test database)
npm audit       # 0 vulnerabilities
```

## Merge Recommendation

1. ~~One-time coupon reservation/idempotency is fixed.~~ ✅ `d23fc81`
2. ~~Production webhook verification cannot fail open.~~ ✅ `4ace1a9`
3. `DATABASE_URL`, `PAYMONGO_WEBHOOK_SECRET`, `AUTH_TOKEN_SECRET`, and `ADMIN_API_KEY` are all set in production, and migration has been run. **← only remaining blocker, needs deployment access**
4. ~~Backend dependency audit is addressed or explicitly accepted.~~ ✅ `c5e21af`
5. ~~Money-path regression tests are added or a manual verification log is attached.~~ ✅ `cd24fbe`
