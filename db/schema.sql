-- db/schema.sql
-- Relational schema replacing the data/*.json flat-file stores.
-- Applied idempotently by db/migrate.js (CREATE TABLE/INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS products (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    amount_php              NUMERIC(12, 2) NOT NULL CHECK (amount_php > 0),
    currency                TEXT NOT NULL DEFAULT 'PHP',
    billing_type            TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_type IN ('one_time', 'recurring')),
    billing_interval        TEXT,
    default_payment_method  TEXT,
    default_source          TEXT,
    default_tax_rate        NUMERIC(5, 4),
    display_suffix          TEXT,
    success_url             TEXT,
    cancel_url              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
    code                    TEXT PRIMARY KEY,
    discount_percent        NUMERIC(5, 4) NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 1),
    affiliate_fee_percent   NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (affiliate_fee_percent >= 0 AND affiliate_fee_percent <= 1),
    affiliate_email         TEXT,
    active                  BOOLEAN NOT NULL DEFAULT true,
    expires_at              TIMESTAMPTZ,
    max_redemptions         INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two coupon types: 'affiliate' (each affiliate's personal code, created at registration,
-- carries the affiliate fee, no total usage limit) and 'general' (admin-managed promo
-- codes, no affiliate/fee, optionally capped by max_redemptions). Backward-compatible
-- migration for databases created before this distinction existed.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_type_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_type_check CHECK (type IN ('affiliate', 'general'));
-- Which GHL locations a GENERAL coupon should sync to. NULL = all configured locations.
-- Not used for affiliate coupons (those always sync to every configured location).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS ghl_location_ids TEXT[];
-- Whether this coupon can be applied on Local (PayMongo) checkout. Coupons imported from
-- GHL default to false (they were never meant for the Local funnel).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS local_enabled BOOLEAN NOT NULL DEFAULT true;
-- Optional bookkeeping for coupons imported from GHL: original GHL product/price/variant
-- restrictions, per-location GHL coupon ids, etc. Not used by application logic.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS ghl_coupon_meta JSONB;
CREATE INDEX IF NOT EXISTS idx_coupons_type ON coupons(type);

-- Junction table: which products a coupon is eligible for. No rows = eligible for all products.
CREATE TABLE IF NOT EXISTS coupon_products (
    coupon_code             TEXT NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
    product_id              TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (coupon_code, product_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_products_product_id ON coupon_products(product_id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id                      TEXT PRIMARY KEY,
    code                    TEXT NOT NULL REFERENCES coupons(code),
    payment_reference       TEXT NOT NULL,
    product_id              TEXT REFERENCES products(id),
    email                   TEXT,
    full_name               TEXT,
    base_amount             NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discount_amount         NUMERIC(12, 2) NOT NULL DEFAULT 0,
    affiliate_fee_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    affiliate_email         TEXT,
    currency                TEXT NOT NULL DEFAULT 'PHP',
    -- 'pending' = reserved at checkout creation, before payment - counts toward
    -- max_redemptions so a concurrent checkout can't reuse a one-time coupon before
    -- this one is confirmed. 'paid' = confirmed by a payment.paid webhook. 'released' =
    -- payment failed/was cancelled, freeing the coupon use back up.
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'released')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                 TIMESTAMPTZ,
    released_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_product_id ON coupon_redemptions(product_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_status ON coupon_redemptions(status);
-- payment_reference is generated fresh per checkout, so this should never collide in
-- practice - it's a defense-in-depth guard against webhook retries or double-submits
-- inserting a duplicate redemption row for the same checkout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_payment_reference ON coupon_redemptions(payment_reference);

-- Backward-compatible migration for databases created before pending reservations
-- existed (the CREATE TABLE above is a no-op once the table already exists).
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_status_check;
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_status_check CHECK (status IN ('pending', 'paid', 'released'));

CREATE TABLE IF NOT EXISTS affiliates (
    id                      TEXT PRIMARY KEY,
    first_name              TEXT NOT NULL,
    last_name               TEXT NOT NULL,
    email                   TEXT NOT NULL UNIQUE,
    contact_number          TEXT NOT NULL,
    socials                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    payment_region          TEXT NOT NULL CHECK (payment_region IN ('PH', 'GLOBAL')),
    preferred_bank          TEXT NOT NULL,
    payout_details          JSONB NOT NULL DEFAULT '{}'::jsonb,
    terms_accepted          BOOLEAN NOT NULL DEFAULT false,
    terms_version           TEXT,
    coupon_code             TEXT REFERENCES coupons(code),
    status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'terminated')),
    status_updated_at       TIMESTAMPTZ,
    -- Login for the affiliate self-service portal. Nullable because affiliates that
    -- registered before this existed have no password yet - they're simply unable to
    -- log in until an admin sets one for them (no email/reset-link infra exists here).
    password_hash           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_affiliates_coupon_code ON affiliates(coupon_code);

-- Idempotent backfill (must run after the affiliates table exists): safe to run on every
-- migrate since it only ever promotes a coupon to 'affiliate' (never demotes), so
-- re-running never undoes an admin's own 'general' classification of an unrelated coupon.
UPDATE coupons SET type = 'affiliate'
WHERE type <> 'affiliate'
  AND (affiliate_email IS NOT NULL OR code IN (SELECT coupon_code FROM affiliates WHERE coupon_code IS NOT NULL));

-- Admin accounts for the console login. The env-configured ADMIN_API_KEY/API_KEY
-- (see middleware/auth.js) keeps working as a permanent master/bootstrap credential
-- on top of whatever admin accounts exist here. Any logged-in admin can create
-- another; all admins have identical full access, no permission tiers.
CREATE TABLE IF NOT EXISTS admins (
    id                      TEXT PRIMARY KEY,
    email                   TEXT NOT NULL UNIQUE,
    password_hash           TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at              TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS digital_solutions_transactions (
    id                      TEXT PRIMARY KEY,
    type                    TEXT NOT NULL CHECK (type IN ('academy_product', 'clockistry_subscription')),
    transaction_id          TEXT NOT NULL UNIQUE,
    customer_email          TEXT,
    customer_name           TEXT,
    company_id              TEXT,
    user_id                 TEXT,
    product_id              TEXT REFERENCES products(id),
    product_name            TEXT,
    plan                    TEXT,
    user_count              INTEGER,
    amount                  NUMERIC(12, 2),
    currency                TEXT NOT NULL DEFAULT 'PHP',
    promo_code              TEXT REFERENCES coupons(code),
    source                  TEXT,
    status                  TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'paid', 'failed')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dst_type ON digital_solutions_transactions(type);
CREATE INDEX IF NOT EXISTS idx_dst_status ON digital_solutions_transactions(status);
CREATE INDEX IF NOT EXISTS idx_dst_company_id ON digital_solutions_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_dst_customer_email ON digital_solutions_transactions(customer_email);
CREATE INDEX IF NOT EXISTS idx_dst_product_id ON digital_solutions_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_dst_promo_code ON digital_solutions_transactions(promo_code);

-- Native GHL checkout orders (live AND test-mode, with or without a coupon) are mirrored here
-- by services/ghlOrderImport.js as type 'ghl_order', transaction_id 'ghl:<orderId>' (already
-- UNIQUE above, so upserts are idempotent per order). Their statuses (paid, refunded,
-- partially_refunded, failed, pending, ...) go beyond the original PayMongo set, GHL product ids
-- are not rows in `products`, and a GHL coupon code is not necessarily a row in `coupons`
-- (test orders never auto-create coupons) - so the type CHECK is widened and the status CHECK and
-- promo_code FK are dropped. is_test rows are excluded from revenue totals.
ALTER TABLE digital_solutions_transactions DROP CONSTRAINT IF EXISTS digital_solutions_transactions_type_check;
ALTER TABLE digital_solutions_transactions ADD CONSTRAINT digital_solutions_transactions_type_check CHECK (type IN ('academy_product', 'clockistry_subscription', 'ghl_order'));
ALTER TABLE digital_solutions_transactions DROP CONSTRAINT IF EXISTS digital_solutions_transactions_status_check;
ALTER TABLE digital_solutions_transactions DROP CONSTRAINT IF EXISTS digital_solutions_transactions_promo_code_fkey;
ALTER TABLE digital_solutions_transactions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE digital_solutions_transactions ADD COLUMN IF NOT EXISTS ghl_location_id TEXT;
ALTER TABLE digital_solutions_transactions ADD COLUMN IF NOT EXISTS ghl_product_ids TEXT[];
ALTER TABLE digital_solutions_transactions ADD COLUMN IF NOT EXISTS ghl_payment_status TEXT;
-- Small snapshot of the GHL order detail (totals, items, mode) so admins can audit what GHL returned.
ALTER TABLE digital_solutions_transactions ADD COLUMN IF NOT EXISTS raw JSONB;
CREATE INDEX IF NOT EXISTS idx_dst_is_test ON digital_solutions_transactions(is_test);

CREATE TABLE IF NOT EXISTS ghl_invoice_schedules (
    location_id             TEXT NOT NULL,
    contact_id              TEXT NOT NULL,
    product_id              TEXT NOT NULL,
    schedule_id             TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, contact_id, product_id)
);

-- Admin-created, named custom links attributing traffic/sales to one affiliate via
-- their coupon code. Link = destination_url + ?ref=<coupon_code>&campaign=<slug>,
-- computed on read (see utils/campaignStore.js) rather than stored, so it always
-- reflects the current destination_url.
CREATE TABLE IF NOT EXISTS campaigns (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    slug                    TEXT NOT NULL UNIQUE,
    coupon_code             TEXT NOT NULL REFERENCES coupons(code),
    destination_url         TEXT NOT NULL,
    notes                   TEXT,
    active                  BOOLEAN NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_coupon_code ON campaigns(coupon_code);

-- One campaign now applies to ALL affiliates (each gets a personal ref link automatically)
-- instead of being tied to a single coupon, so coupon_code is no longer required for new
-- campaigns. Column kept (nullable) for legacy campaigns/reporting; app code no longer
-- reads or writes it for new campaigns.
ALTER TABLE campaigns ALTER COLUMN coupon_code DROP NOT NULL;

-- Attributes a redemption to the campaign link that drove it (checkout auto-attribution).
-- Must come after the campaigns table is created (coupon_redemptions is created earlier in this file).
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_campaign_id ON coupon_redemptions(campaign_id);

-- Campaign sites: the distinct storefronts/funnels campaigns can point traffic at. Each
-- site is either 'local' (our PayMongo checkout flow) or 'global' (native GHL checkout
-- in the Nexistry Core Global GHL location). url is a normalized https origin
-- (scheme+host, no path/trailing slash) used both for CORS allowlisting and for
-- validating a campaign's destinationUrl host.
CREATE TABLE IF NOT EXISTS campaign_sites (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    url                     TEXT NOT NULL UNIQUE,
    channel                 TEXT NOT NULL CHECK (channel IN ('local', 'global')),
    active                  BOOLEAN NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which products a site sells. kind 'local' ref = products.id (validated against the
-- products table in app code, not a DB FK, since the reference is polymorphic by kind).
-- kind 'ghl' ref = a GHL product _id in the Global location, which we don't mirror locally.
CREATE TABLE IF NOT EXISTS campaign_site_products (
    site_id                 TEXT NOT NULL REFERENCES campaign_sites(id) ON DELETE CASCADE,
    kind                    TEXT NOT NULL CHECK (kind IN ('local', 'ghl')),
    ref                     TEXT NOT NULL,
    name                    TEXT,
    PRIMARY KEY (site_id, kind, ref)
);

-- Nullable: legacy campaigns created before campaign sites existed have no site. New
-- campaigns require one (enforced in app code, not a NOT NULL constraint).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS site_id TEXT REFERENCES campaign_sites(id);
CREATE INDEX IF NOT EXISTS idx_campaigns_site_id ON campaigns(site_id);

-- Distinguishes a LOCAL (PayMongo) redemption from a GLOBAL (native GHL checkout)
-- redemption imported by services/ghlOrderImport.js.
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'paymongo';
ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_source_check;
ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_source_check CHECK (source IN ('paymongo', 'ghl'));
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS ghl_location_id TEXT;
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS ghl_product_ids TEXT[];
-- Affiliate payout confirmation, distinct from `status` (customer payment state). Nullable
-- until an admin actually pays the affiliate out - see markRedemptionsPaid in couponStore.js.
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS affiliate_paid_at TIMESTAMPTZ;
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

-- Speeds up the per-customer-once affiliate/general coupon lookups in
-- couponStore.beginCouponReservation (matched by normalized/lowercased email).
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_email_lower ON coupon_redemptions (lower(email));

-- Coupon origin: 'local' = created by us (registration/admin) and pushed to GHL as needed;
-- 'ghl' = discovered from a native GHL order (never pushed/updated back to GHL).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_origin_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_origin_check CHECK (origin IN ('local', 'ghl'));
-- Per-location GHL push state for local affiliate coupons, keyed by location key
-- ('global' | 'main'): { status: 'synced'|'pending'|'error', locationId, ghlCouponId, error, at }.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS ghl_sync JSONB;

-- The amount the affiliate fee was actually computed on (pre-tax, post-discount).
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS commission_base NUMERIC(12, 2);
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS ghl_order_id TEXT;
UPDATE coupon_redemptions SET ghl_order_id = substring(payment_reference from 5)
WHERE source = 'ghl' AND ghl_order_id IS NULL AND payment_reference LIKE 'ghl:%';

-- GHL test-mode (liveMode:false / markAsTest) coupon orders are recorded as redemptions too, so the
-- whole affiliate flow can be verified without real money. is_test rows are NEVER counted in
-- totals, payouts, usage limits or holds - they are only listed (with a TEST badge).
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- GHL student accounts: one row per paid Practice Access / Premium payment (payment_reference is
-- the idempotency key, so a repeated PayMongo webhook never creates a second GHL user). The
-- generated password is NEVER stored here - it only travels in the LeadConnector webhook.
-- 'pending' = attempt in flight; failed rows are retried by the production scheduler.
CREATE TABLE IF NOT EXISTS ghl_student_users (
    id                 BIGSERIAL PRIMARY KEY,
    payment_reference  TEXT NOT NULL UNIQUE,
    email              TEXT NOT NULL,
    full_name          TEXT,
    product_id         TEXT,
    ghl_user_id        TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    error              TEXT,
    attempts           INTEGER NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ghl_student_users DROP CONSTRAINT IF EXISTS ghl_student_users_status_check;
ALTER TABLE ghl_student_users ADD CONSTRAINT ghl_student_users_status_check CHECK (status IN ('pending', 'created', 'existing', 'failed'));
CREATE INDEX IF NOT EXISTS idx_ghl_student_users_status ON ghl_student_users(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ghl_student_users_email_lower ON ghl_student_users (lower(email));
