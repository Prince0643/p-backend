# Nexistry Backend — Frontend (Next.js)

This is the frontend for the `p-backend` Express API — the affiliate registration page
(`/register`) and the admin console (`/admin/products`, `/admin/coupons`, `/admin/affiliates`,
`/admin/solutions`). It's a **separate app from the Express backend on purpose**: the backend
(PayMongo, GHL, webhooks, Postgres) stays exactly as it is, and this only calls its existing
`/api/*` routes.

Everything here is a client-rendered React page (`"use client"`) that fetches from the API at
runtime with the same `x-api-key` header the old vanilla-JS admin pages used, stored in
`localStorage` — the auth model didn't change, only the implementation.

## Running locally

1. Make sure the Express backend (`../`) is running first — see the root `API_DOCUMENTATION.md`
   for its own setup (requires `DATABASE_URL`, `PAYMONGO_SECRET_KEY`, etc.). By default it runs
   on port 3000; this project assumes port 4123 in dev unless you set `EXPRESS_API_URL`.
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev` (defaults to port 3000 — if the Express backend is also
   using 3000, either run this on a different port with `PORT=3001 npm run dev`, or change the
   Express backend's `PORT`)

## How the API calls work

`next.config.ts` proxies `/api/:path*` to the Express backend (`EXPRESS_API_URL`, default
`http://localhost:4123`) using Next's `rewrites()`. This means every `fetch('/api/...')` call in
these pages works exactly like it did in the old vanilla-JS pages — no CORS configuration
needed, same relative paths, same headers.

```bash
EXPRESS_API_URL=https://your-real-backend.example.com npm run build
```

Set `EXPRESS_API_URL` to wherever the Express backend actually runs in each environment
(local dev, staging, production) before building/starting.

## Structure

- `app/register/` — public affiliate self-registration page
- `app/admin/{products,coupons,affiliates,solutions}/` — admin console pages
- `lib/api.ts` — shared fetch helper (attaches `x-api-key`, normalizes error handling)
- `lib/useApiKey.ts` — reads/writes the admin API key from `localStorage`
- `components/AdminTopbar.tsx` — shared nav bar across all four admin pages

## Note for AI agents

See `AGENTS.md` / `CLAUDE.md` in this directory — this project is on Next.js 16, which has
breaking changes from earlier versions. Read `node_modules/next/dist/docs/` before assuming
an API works the way it used to.
