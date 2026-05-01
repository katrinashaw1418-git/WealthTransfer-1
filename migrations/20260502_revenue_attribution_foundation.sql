-- Manual incremental SQL only (no baseline generation).
-- Session 29 foundation: adviser revenue split config + attribution ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS adviser_revenue_splits (
  id serial PRIMARY KEY,
  adviser_user_id integer NOT NULL REFERENCES users(id),
  split_model text NOT NULL,
  revenue_share_bps integer,
  flat_annual_amount numeric(14, 4),
  hybrid_base_amount numeric(14, 4),
  hybrid_revenue_bps integer,
  effective_from timestamp NOT NULL DEFAULT now(),
  effective_to timestamp,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'adviser_revenue_splits_split_model_check'
  ) THEN
    ALTER TABLE adviser_revenue_splits
      ADD CONSTRAINT adviser_revenue_splits_split_model_check
      CHECK (split_model IN ('flat_annual', 'revenue_pct', 'hybrid'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'adviser_revenue_splits_revenue_bps_bounds'
  ) THEN
    ALTER TABLE adviser_revenue_splits
      ADD CONSTRAINT adviser_revenue_splits_revenue_bps_bounds
      CHECK (revenue_share_bps IS NULL OR (revenue_share_bps >= 0 AND revenue_share_bps <= 10000));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS adviser_revenue_splits_adviser_active_idx
  ON adviser_revenue_splits (adviser_user_id, is_active, effective_from);

CREATE TABLE IF NOT EXISTS revenue_ledger (
  id serial PRIMARY KEY,
  deduction_id integer NOT NULL REFERENCES adviser_fee_deductions(id),
  settled_transaction_id integer REFERENCES transactions(id),
  adviser_user_id integer NOT NULL REFERENCES users(id),
  client_user_id integer NOT NULL REFERENCES users(id),
  split_model text NOT NULL,
  gross_amount numeric(14, 4) NOT NULL,
  adviser_amount numeric(14, 4) NOT NULL,
  licensee_amount numeric(14, 4) NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_ledger_deduction_id_uidx
  ON revenue_ledger (deduction_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revenue_ledger_split_model_check'
  ) THEN
    ALTER TABLE revenue_ledger
      ADD CONSTRAINT revenue_ledger_split_model_check
      CHECK (split_model IN ('flat_annual', 'revenue_pct', 'hybrid'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revenue_ledger_non_negative_amounts'
  ) THEN
    ALTER TABLE revenue_ledger
      ADD CONSTRAINT revenue_ledger_non_negative_amounts
      CHECK (gross_amount >= 0 AND adviser_amount >= 0 AND licensee_amount >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revenue_ledger_amount_balance_check'
  ) THEN
    ALTER TABLE revenue_ledger
      ADD CONSTRAINT revenue_ledger_amount_balance_check
      CHECK (adviser_amount + licensee_amount = gross_amount);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS revenue_ledger_adviser_created_idx
  ON revenue_ledger (adviser_user_id, created_at);

COMMIT;
