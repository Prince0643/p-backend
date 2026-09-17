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
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code ON coupon_redemptions(code);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_status ON coupon_redemptions(status);

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
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS ghl_invoice_schedules (
    location_id             TEXT NOT NULL,
    contact_id              TEXT NOT NULL,
    product_id              TEXT NOT NULL,
    schedule_id             TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, contact_id, product_id)
);
