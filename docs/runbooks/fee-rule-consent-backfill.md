# Fee-Rule Consent Backfill Runbook (Task #323)

> **Audience:** the on-call platform engineer with production DB credentials.
> **Time budget:** ~5 minutes (a few seconds of script time + verification).
> **What it does:** Populates `adviser_fee_rules.accountNumber` and
> `adviser_fee_rules.effectiveDate` on every pre-Task-#294 row, then
> collapses any accidental duplicate `(clientUserId, feeType, accountNumber)`
> tuples in the `{draft, active, paused}` set into a supersede chain. The
> point of the run is to leave the partial unique index
> `adviser_fee_rules_supersede_uniq` with a clean baseline so future
> `createFeeRule` inserts cannot be rejected by a leftover NULL-account
> duplicate.

---

## 1. When to run

Run this **once** against the production database, before treating the
nightly `fee-rules-consent-reconcile` cron as the source of truth for
fee-rule lifecycle. After the first clean apply the script's `WHERE`
clauses guarantee subsequent invocations are no-ops, so re-running it
in a future incident is also safe.

You don't need to run this against the dev DB — `scripts/post-merge.sh`
runs `npx tsx scripts/backfill-fee-rule-consent-state.ts --apply` on
every merge to keep the dev DB converged.

Symptoms that confirm the backfill is needed against a given DB:

* `SELECT count(*) FROM adviser_fee_rules WHERE account_number IS NULL;`
  returns > 0.
* `SELECT count(*) FROM adviser_fee_rules WHERE effective_date IS NULL;`
  returns > 0.
* A would-be duplicate group exists (see verification query in §4).

---

## 2. How to run

The script lives at `scripts/backfill-fee-rule-consent-state.ts` and
defaults to dry-run. Make sure `DATABASE_URL` in your shell points at
the **production** Neon database before running.

```bash
# 0. Confirm you're pointing at production. Don't skip this.
echo "$DATABASE_URL" | sed 's/:[^:@]*@/:***@/'   # masks the password

# 1. Dry-run. Prints the per-pass row counts and the exact tuple
#    survivors/losers it would supersede. Writes nothing.
npx tsx scripts/backfill-fee-rule-consent-state.ts 2>&1 | tee \
  /tmp/fee-rule-consent-backfill-dryrun-$(date -u +%Y%m%dT%H%M%SZ).log

# 2. Eyeball the output. The "tuple [client|feeType|account]" lines
#    show every duplicate group. If a survivor / loser pick looks
#    wrong (e.g. you wanted the OLDER row to win), STOP and bring it
#    to fee-engine ownership before applying — the script always picks
#    the most-recently-created row as survivor.

# 3. Apply.
npx tsx scripts/backfill-fee-rule-consent-state.ts --apply 2>&1 | tee \
  /tmp/fee-rule-consent-backfill-apply-$(date -u +%Y%m%dT%H%M%SZ).log
```

The two log files are the deploy-log capture this task asks for —
attach the apply log to the deploy ticket.

---

## 3. What it touches

* **Reads:** `adviser_fee_rules`, `fee_consents`.
* **Writes:**
  * `adviser_fee_rules.accountNumber` — copied from
    `fee_consents.accountNumber` (skipped with a warning when the
    consent or its accountNumber is itself NULL).
  * `adviser_fee_rules.effectiveDate` — copied from `createdAt`.
  * `adviser_fee_rules.{status, supersededByRuleId, supersededAt,
    supersededReason, updatedAt}` — for losers in a duplicate tuple.
  * `audit_logs` — one `fee_rule_superseded` row per superseded loser
    with `extra.backfill = true` so the supersede chain is auditable.
* **Does not touch:** wallet balances, ledger postings, transactions,
  accruals, deductions, fee consents themselves. No money moves.

The script is idempotent — running it twice in a row produces a
"copied=0, would be backfilled=0, 0 duplicate tuples" report.

---

## 4. After running — verify zero remaining mismatches

Run these read-only checks against the production DB. Each should
return `0`. If any is non-zero, do **not** treat the cron baseline as
clean — investigate before proceeding.

```sql
-- (a) No active-set rule should be missing accountNumber.
SELECT count(*) FROM adviser_fee_rules
 WHERE account_number IS NULL
   AND status IN ('draft','active','paused');

-- (b) No row should be missing effectiveDate.
SELECT count(*) FROM adviser_fee_rules
 WHERE effective_date IS NULL;

-- (c) No remaining duplicate tuples in the active set. The partial
--     unique index covers exactly this — a non-zero count here means
--     the index would reject a future insert.
SELECT client_user_id, fee_type, account_number, count(*)
  FROM adviser_fee_rules
 WHERE status IN ('draft','active','paused')
 GROUP BY 1, 2, 3
HAVING count(*) > 1;
```

For an audit-trail spot-check that the backfill wrote what it claimed:

```sql
SELECT id, entity_id, metadata->>'replacedByRuleId' AS replaced_by,
       metadata->>'backfill' AS backfill, created_at
  FROM audit_logs
 WHERE action = 'fee_rule_superseded'
   AND metadata->>'backfill' = 'true'
 ORDER BY created_at DESC
 LIMIT 20;
```

---

## 5. Confirm the reconcile cron is on

`server/index.ts` defaults `FEE_RULES_CONSENT_RECONCILE_CRON_ENABLED`
to `"true"` when the env var is unset, so on a fresh deploy the cron
is already engaged and runs ~210s after process start, then every
24 h. After the backfill, confirm:

```bash
# In the production deployment secrets:
#   FEE_RULES_CONSENT_RECONCILE_CRON_ENABLED   →   not set, OR set to "true"
# (any of "false" / "0" / "off" disables it — see server/index.ts ~L433)
```

If the cron was previously held off with an explicit
`FEE_RULES_CONSENT_RECONCILE_CRON_ENABLED=false`, remove the override
or flip it to `true` and restart the production process. The next
boot's `background_job_runs` row for `fee-rules-consent-reconcile`
should report something like:

```
checked=N, expired=0, paused_for_withdrawal=0, already_aligned=N,
consent_missing=0
```

`consent_missing > 0` is the only count worth paging on — it means a
rule is pointing at a feeConsent row that no longer exists, which the
backfill cannot fix on its own.

---

## 6. Rollback

The backfill writes are individually reversible:

* `accountNumber` / `effectiveDate` were filled from observable
  state (`feeConsents.accountNumber` and `adviser_fee_rules.createdAt`).
  To undo a single row: `UPDATE adviser_fee_rules SET account_number =
  NULL, effective_date = NULL WHERE id = …;`
* A superseded loser can be revived by clearing the supersede pointer
  and restoring the prior status from the matching audit_log `before`
  payload:
  ```sql
  UPDATE adviser_fee_rules
     SET status = (SELECT before->>'status' FROM audit_logs
                    WHERE action='fee_rule_superseded'
                      AND entity_id = '<rule_id>'
                    ORDER BY id DESC LIMIT 1),
         superseded_by_rule_id = NULL,
         superseded_at = NULL,
         superseded_reason = NULL
   WHERE id = <rule_id>;
  ```
  Reviving a loser will, of course, re-trigger the unique-index
  violation that the backfill was meant to clear. Reverse only as
  part of a deliberate fix-forward where you know which row should
  win the tuple.

For a wholesale rollback of the deploy that ran the backfill, prefer
restoring the most recent pre-deploy DB backup
(`docs/runbooks/rollback.md`) over un-doing the writes by hand.
