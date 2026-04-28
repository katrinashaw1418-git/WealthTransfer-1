#!/bin/bash
set -e
npm install
npm run db:push -- --force

# Task #285 — one-time backfill for users.kyc_updated_at.
#
# When the column was added it was created with a defaultNow() default,
# which means every existing row received the moment the schema push ran
# rather than the user's actual last KYC change. The cron uses this
# timestamp to anchor KYC follow-up due dates (kycUpdatedAt + 30d), so
# leaving every legacy row at "schema-push time" reintroduces the
# clustered-due-date artifact this task was designed to eliminate.
#
# The users table has no `updated_at` column and the audit log records no
# discrete KYC change action, so the most accurate per-row fallback is
# `created_at`. A small `_post_merge_state` tracking table keeps this
# strictly one-time so re-runs do not stomp on real KYC updates that
# happen later (those land in kyc_updated_at via storage.updateUser).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS _post_merge_state (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM _post_merge_state WHERE key = 'task_285_kyc_updated_at_backfill'
  ) THEN
    UPDATE users
       SET kyc_updated_at = created_at
     WHERE created_at IS NOT NULL;

    INSERT INTO _post_merge_state(key) VALUES ('task_285_kyc_updated_at_backfill');
  END IF;
END$$;
SQL

# Task #311 — extend the Task #285 backfill above so legacy clients whose
# KYC status was actually changed in the past (recorded in `audit_logs`)
# get their `kyc_updated_at` anchored on the real change instant rather
# than the cruder created_at fallback. The script walks `audit_logs` for
# any KYC-related entry per user (action ILIKE '%kyc%' OR metadata
# containing a `kycStatus` field) and uses GREATEST(created_at, latest
# audit timestamp). Monotonic-only: it never decreases an existing
# kyc_updated_at, so a real storage.updateUser() write that landed
# between deploys is preserved. Records its own `_post_merge_state` key
# (`task_311_kyc_updated_at_audit_walk_backfill`) for operator
# visibility, but the monotonic predicate is the real idempotency guard.
npx tsx scripts/backfill-kyc-updated-at.ts --apply

# Task #323 — one-time backfill for adviser_fee_rules.{accountNumber,
# effectiveDate} + supersede chain dedup (companion to Task #294).
#
# Task #294 added accountNumber, effectiveDate and the supersededBy*
# pointers, plus a partial unique index on
# (clientUserId, feeType, accountNumber) WHERE status IN
# ('draft','active','paused'). Pre-#294 rows have NULL accountNumber /
# effectiveDate and may include accidental duplicates that would block
# any future createFeeRule on the same tuple. The script's WHERE clauses
# guarantee a second invocation is a no-op once the data is converged,
# so wiring it into post-merge.sh keeps the active dev DB clean across
# merges without needing a `_post_merge_state` marker. The PRODUCTION
# DB is operator-driven — see docs/runbooks/fee-rule-consent-backfill.md
# for the prod runbook (dry-run → review → apply → verify zero
# remaining mismatches → confirm reconcile cron is on).
npx tsx scripts/backfill-fee-rule-consent-state.ts --apply

# Task #356 — auto-trigger the portfolio-snapshot re-anchor whenever the
# valuation code path or the inline FX seed has changed since the last
# successful run.
#
# Task #351 added `scripts/refresh-portfolio-snapshots-aud.ts` and a
# runbook describing when to invoke it (after any FX-routing or
# valuation-rule change). That left a human in the loop, and forgetting
# the step makes the dashboard's monthly P&L card and Performance by
# Period chart show a misleading ~30-day spike. The runner below hashes
# `server/services/portfolio-valuation.ts` plus the inline
# `const missingRates = [...]` FX seed in `server/routes.ts`, compares
# the fingerprint against `_post_merge_state`, and re-runs the refresh
# script with `--apply` only when the fingerprint changes. The summary
# line ("rewrote N snapshot row(s) across M user(s)") lands in the
# deploy log so the operator can see exactly how much data was rewritten
# without having to grep the script's per-user output.
npx tsx scripts/post-merge-portfolio-snapshot-reanchor.ts
