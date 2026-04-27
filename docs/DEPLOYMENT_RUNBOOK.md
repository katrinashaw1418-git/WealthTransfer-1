# Deployment Runbook

Operational checklist for deploying schema changes to production. Keep this short; add a new section any time a deploy needs a one-shot manual step.

## Standard deploy

1. Merge the task branch into the main app.
2. Click **Publish**.
3. Replit's deploy build runs `bash scripts/predeploy-build.sh`, which:
   - Runs `npx tsx scripts/go-no-go.ts` against the production-equivalent environment as a pre-deploy launch readiness gate.
   - Aborts the deploy on a NO-GO verdict (non-zero exit) and pastes the full report into the deploy log so you can see which check failed.
   - On GO, runs `npm run build` and copies the latest report into `dist/go-no-go-report.md` so it ships as part of the deploy artefact.
4. Replit's deploy build runs `npm run db:push` against the production database.
5. The new revision goes live.

### Required deployment secrets for the launch readiness gate (Task #180)

These must be set in the Replit deployment secrets pane (not just the workspace `.env`) — the gate validates them against a snapshot taken **before** any dev-time fallback runs (`scripts/_raw-env-snapshot.ts`), so a missing prod secret produces a NO-GO and blocks the deploy:

| Secret | Why |
| --- | --- |
| `DATABASE_URL` | Production DB the deploy will boot against. |
| `JWT_SECRET` | Auth layer refuses to boot without it. |
| `NODE_ENV` | Should be `production`; tags observability and gates env separation. |
| `LOG_DIR` | Persistent volume for `errors.log`; fallback `./logs` is ephemeral inside the container. |
| `OPERATOR_ALERT_WEBHOOK_URL` | The alerting drill in the gate dispatches one drill alert per known source; without a webhook configured the gate is NO-GO. |
| `DB_BACKUP_DIR` | The infrastructure & rollback sections check the latest successful backup and restore drill freshness against this dir. |

If any are missing the deploy log will show the failing check and a `> **What to do:** …` hint pointing at the fix. See `docs/runbooks/go-no-go.md` for what each section verifies and what `drill: true` artefacts the gate leaves behind on every deploy.

### Manually re-running the gate

The gate can also be invoked by hand against any environment with `npx tsx scripts/go-no-go.ts`. The deploy wiring described above is just a no-human-required call of the same script — there is no separate code path.

## One-shot post-`db:push` steps

These steps must be run **once per database** the first time the listed schema lands. They are all idempotent (safe to re-run), so when in doubt, run them again. Run them from a shell with `DATABASE_URL` pointing at the target database.

### Task #37 — `ledger_postings` receipt backfill

**Why:** Task #37 introduced `ledger_postings`, a one-row-per-`transactionId` receipt table that the DB-level double-post guard in `postLedgerEntries()` (`server/services/ledger.ts`) relies on. Any historical transaction that already has rows in `ledger_entries` but no matching row in `ledger_postings` is unprotected — a future caller could silently post a second balanced pair against the same `transactionId`. The backfill writes the missing receipts so the guard covers pre-existing data too.

**When to run:** Once, on each database, the first time the `ledger_postings` table appears (i.e. the first deploy after Task #37 lands on that environment). Re-run any time you suspect the receipts are out of sync with `ledger_entries` — the script uses `ON CONFLICT DO NOTHING` and is safe to repeat.

**Self-healing safety net (Task #63):** `server/services/posting-receipt-invariant.ts` runs once shortly after every boot and again every 24 hours. It compares `COUNT(DISTINCT transaction_id)` in `ledger_entries` against `COUNT(*)` in `ledger_postings` and pages an operator (via the same `notifyOperator()` plumbing as the wallet/ledger reconciliation crons) if they diverge. The alert names a sample of the missing transaction ids and points back at the backfill script below. In practice the manual step here is now a fallback — if you forget it on a new environment or after a snapshot restore, the cron will surface the gap within seconds (boot tick) or at most 24h (daily tick).

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

The two counts must be equal. If they aren't, re-run the script and re-check. If the invariant cron has already fired, you will also see an `operator_alerts` row with `source = 'posting-receipt-invariant'` recording the divergence.
