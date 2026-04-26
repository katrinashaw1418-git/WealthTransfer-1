# Deployment Runbook

Operational checklist for deploying schema changes to production. Keep this short; add a new section any time a deploy needs a one-shot manual step.

## Standard deploy

1. Merge the task branch into the main app.
2. Click **Publish**.
3. Replit's deploy build runs `npm run db:push` against the production database.
4. The new revision goes live.

## One-shot post-`db:push` steps

These steps must be run **once per database** the first time the listed schema lands. They are all idempotent (safe to re-run), so when in doubt, run them again. Run them from a shell with `DATABASE_URL` pointing at the target database.

### Task #37 — `ledger_postings` receipt backfill

**Why:** Task #37 introduced `ledger_postings`, a one-row-per-`transactionId` receipt table that the DB-level double-post guard in `postLedgerEntries()` (`server/services/ledger.ts`) relies on. Any historical transaction that already has rows in `ledger_entries` but no matching row in `ledger_postings` is unprotected — a future caller could silently post a second balanced pair against the same `transactionId`. The backfill writes the missing receipts so the guard covers pre-existing data too.

**When to run:** Once, on each database, the first time the `ledger_postings` table appears (i.e. the first deploy after Task #37 lands on that environment). Re-run any time you suspect the receipts are out of sync with `ledger_entries` — the script uses `ON CONFLICT DO NOTHING` and is safe to repeat.

**Command:**

```bash
npx tsx scripts/backfill-ledger-postings.ts
```

**Verify:**

```sql
SELECT
  (SELECT COUNT(DISTINCT transaction_id) FROM ledger_entries WHERE transaction_id IS NOT NULL) AS tx_with_entries,
  (SELECT COUNT(*) FROM ledger_postings) AS receipts;
```

The two counts must be equal. If they aren't, re-run the script and re-check.
