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

-- Attributes a redemption to the campaign link that drove it (checkout auto-attribution).
-- Must come after the campaigns table is created (coupon_redemptions is created earlier in this file).
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_campaign_id ON coupon_redemptions(campaign_id);
