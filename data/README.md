# data/*.json — legacy seed files, not live storage

As of the PostgreSQL migration, the app no longer reads or writes these JSON files at
runtime. All product, coupon, affiliate, and digital-solutions data lives in Postgres
(see `../db/schema.sql`).

These files are kept only as the one-time seed source for `../db/migrate.js`, which
imports their contents into Postgres the first time it's run against a fresh database.
Editing them after that point has no effect — use the admin UIs (`/admin/products`,
`/admin/coupons`, `/admin/affiliates`) or direct SQL instead.

`ghl_invoice_schedules.json` and `coupon_redemptions.json` may not exist here since they
were only ever created at runtime by the old file-based stores — that's expected.
