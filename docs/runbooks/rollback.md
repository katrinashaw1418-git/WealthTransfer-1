# Rollback Runbook

> **Audience:** the on-call operator. **Time budget:** target < 30 minutes from
> "we need to rollback" to "production is healthy on the previous version with
> a verified database state".

## Wall-clock pacing (from the Task #169 rehearsal, 2026-04-27)

These are the times one operator measured walking through every step
end-to-end against a real scratch DB. The "tech wall-clock" column is the
raw command time; the "operator budget" column adds the human-judgment
overhead (reading dashboards, picking SHAs, typing reasons into the
admin UI). Use the budget column to know whether you are on or off pace
in a real incident.

| Step                                          | Tech wall-clock | Operator budget |
| --------------------------------------------- | --------------- | --------------- |
| 0. Decision tree                              | n/a             | ~1 min          |
| 1. Engage kill switches (admin UI, 4 toggles) | <30 s           | ~90 s           |
| 1*. Engage kill switches (env-var path)       | wait for redeploy | +3–6 min on autoscale |
| 2. Identify the bad deploy                    | n/a             | ~2 min          |
| 3. Path A — redeploy previous version         | wait for redeploy | ~3–6 min on autoscale |
| 4a. Find the dump to restore                  | <10 s           | ~30 s           |
| 4b. Redeploy previous code FIRST              | same as step 3  | ~3–6 min        |
| 4c. Restore the dump (CLI, ~0.4 MiB dev DB)   | ~5 s            | ~1 min          |
| 4c. Restore the dump (extrapolated, scale linearly with dump size) | ~10–15 s per 1 MiB | + dump-size-dependent |
| 4d. Optional pre-flight drill                 | ~6 s            | ~30 s           |
| 5. Re-run reconciliation (3 jobs)             | seconds each    | ~3 min          |
| 6. Verify (3 spot-checks)                     | <1 s of SQL     | ~1 min          |
| 7. Disengage kill switches                    | <30 s           | ~30 s           |
| **Total Path A** (no DB restore)              |                 | **~10–14 min**  |
| **Total Path B** (with restore)               |                 | **~14–20 min**  |

Both totals fit inside the 30-minute budget with margin. If you blow
through any single step's budget by more than 2x, that is the signal
to ask the channel for a second pair of eyes — do NOT silently keep
going.

This runbook covers the two scenarios where Task #147's backup/restore
infrastructure is the safety net:

  1. **Bad deploy, no DB damage** — application code is broken; database is
     fine. We just need to redeploy the previous version and clear kill
     switches once it is healthy.
  2. **Bad deploy with DB damage** — application code wrote bad rows or a
     migration ran that we need to undo. We must redeploy AND restore the
     database from the most recent verified pg_dump.

The decision tree below tells you which path to take.

---

## 0. Decision tree (1 minute)

| Symptom                                         | Path                              |
| ----------------------------------------------- | --------------------------------- |
| Errors / 5xx but ledger / wallet rows look sane | **Path A — Code-only rollback**   |
| Wallet/ledger drift, missing rows, bad amounts  | **Path B — Code + DB restore**    |
| Unsure                                          | Treat as **Path B** (safer)       |

Open the admin dashboard at `/admin/dashboard`. The **Backup health** card
shows the most recent successful backup and the most recent successful
restore drill. **Both must be green** before you proceed with Path B —
restoring a never-verified dump is itself a destructive operation. If either
tile is red, page the database owner before doing anything else.

---

## 1. Engage the kill switches (~90 seconds)

Before anything else, halt new state changes so the rollback target is a
fixed point, not a moving target.

There are TWO kill-switch surfaces; in an incident you almost always want
the **admin UI path** because it does not require a redeploy:

### 1a. Primary path — admin UI (preferred, no redeploy)

  1. Open `/admin/kill-switches` (granular per-class switches).
  2. Toggle ON, in this order, with a short reason like
     `"Rollback in progress — Task #169 rehearsal"`:
     - `transactions` (the master — covers FX, transfers, investment buys)
     - `deposits`
     - `withdrawals`
     - `fee_deductions`
  3. The dialog will not enable the confirm button until the reason is
     filled in. This is by design — the audit log row needs the "why".
  4. Optional global hammer: scroll to the **Write kill switch**
     panel on `/admin/dashboard` (not its own route — it lives inside
     the dashboard page) and flip it ON. That engages the server-side
     `WriteKillSwitch` middleware, which 503s every non-GET request
     from non-admins regardless of which class it would have hit. Use
     this when even the granular switches feel too narrow (e.g.
     unknown-shape data damage).

### 1b. Emergency path — env vars (only if the admin UI is itself broken)

If the database is too sick to load `/admin/kill-switches`, force the
switches ON at boot by setting any combination of the following env vars
in the production deployment secrets and triggering a redeploy. **Truthy
values** are `1` / `true` / `yes` / `on` (case-insensitive); anything
else (or unset) leaves the DB row in charge.

| Switch          | Env var                  |
| --------------- | ------------------------ |
| transactions    | `DISABLE_TRANSACTIONS`   |
| deposits        | `DISABLE_DEPOSITS`       |
| withdrawals     | `DISABLE_WITHDRAWALS`    |
| fee_deductions  | `DISABLE_FEE_DEDUCTIONS` |
| Global writes   | `WRITE_KILL_SWITCH=on`   |

> Env-forced switches **cannot be cleared from the admin UI** — the UI
> renders them with a locked badge and disables the toggle. To clear an
> env-forced switch you MUST remove the env var and redeploy. That is
> exactly why the admin UI is the preferred path during an incident.

### 1c. Confirm

After flipping, confirm one of:

  * Server logs show the granular `KillSwitchActiveError` (HTTP 503,
    body `{ error: "operation_disabled", switch: <key> }`) on the next
    inbound write to the disabled class, OR
  * Server logs show `WriteKillSwitchError` (HTTP 503, body
    `{ code: "WRITE_KILL_SWITCH_ENABLED", reason: "..." }`) for the
    global path.

Leave kill switches engaged until **after** Step 6's verification passes.

---

## 2. Identify the bad deploy (~2 minutes)

  * Open the deployment history in the Replit Deployments tab
    (`https://replit.com/@<owner>/<repl>/deployments` or via the
    workspace **Deploy** sidebar). Note the deploy ID / commit SHA of
    the **last known good** deploy AND the deploy ID of the deploy
    currently running.
  * Cross-reference with the operator-alerts log
    (`/admin/operator-alerts`). The first alert that fired after the bad
    deploy is your "T0".
  * Cross-reference with the background-jobs page
    (`/admin/background-jobs`) — a divergence row from
    `wallet-ledger-reconciliation` or `posting-receipt-invariant` after T0
    is the strongest "Path B" signal.

Record both deploy IDs in the incident channel before proceeding.

---

## 3. Path A — Redeploy the previous version (~3–6 minutes)

If the decision tree said Path A:

  1. In the Replit Deployments tab, locate the previous successful
     deploy and click **Promote** / **Rollback** (depending on
     deployment target). On `autoscale` this drains the current
     containers and brings up new ones at the chosen version; expect
     a 3–6 minute spin-up before health stabilises.
  2. Wait for the new deploy to come up healthy (`/api/health` 200 +
     workflow logs settle). The Deployments tab's status pill goes
     from "Deploying" to "Ready".
  3. Skip to **Step 6 — Verify** below.

---

## 4. Path B — Code + DB restore

If the decision tree said Path B:

### 4a. Find the dump to restore

```sh
# On the server (or anywhere DB_BACKUP_DIR is mounted):
ls -lt "$DB_BACKUP_DIR"/amax-db-backup-*.dump | head -5
```

The dashboard's **Backup health** card already names the most recent
verified dump. If you know the bad deploy went out at, say, 03:00 UTC and
the most recent successful drill was against the 02:00 UTC dump, restore
the 02:00 UTC dump. **Never restore a dump newer than the start of the
incident** — it likely contains the bad data.

### 4b. Redeploy the previous code FIRST (~3–6 minutes)

This is intentional. Restore-then-redeploy can briefly expose the bad code
to the rolled-back data and re-corrupt it. The order is:

  1. Trigger a redeploy of the last-known-good deploy ID via the
     Replit Deployments tab (same procedure as Step 3.1).
  2. Wait for the new deploy to come up healthy.
  3. Confirm kill switches are still engaged (Step 1).

### 4c. Restore the dump (~5 s of pg_restore per ~0.5 MiB; scales linearly)

The restore script refuses to write to the live database unless you
explicitly opt in. This is by design — the restore drill never accidentally
wipes production. To intentionally restore over production:

```sh
DATABASE_URL=postgres://... \
  npx tsx scripts/db-restore.ts \
  --dump=/var/backups/amax-db/amax-db-backup-2026-04-27T02-00-00Z.dump \
  --target=$DATABASE_URL \
  --i-know-what-im-doing
```

If you OMIT `--i-know-what-im-doing` and `--target` parses to the same
host:port/database as `DATABASE_URL`, the script exits with:

```
FAIL: Refusing to operate on the live database (host:port/dbname).
Set --i-know-what-im-doing on the CLI to override, or point at a scratch URL.
```

(Verified end-to-end during the Task #169 rehearsal — the guard is
structural, so `postgres://` vs `postgresql://`, presence/absence of
`?sslmode=...`, and an explicit `:5432` all still trip it.)

The script invokes `pg_restore --clean --if-exists --exit-on-error`. Existing
rows in tables present in the dump are dropped before being recreated.

If the restore fails partway through, **do not** retry blindly. Capture the
error, page the DB owner, and consider whether a partial restore needs a
manual reconciliation.

### 4d. (Optional) Verify with a fresh restore drill

If time permits, run a manual drill against the same dump first to a scratch
DB to catch a corrupt-dump scenario before pointing it at production:

```sh
DATABASE_URL=postgres://... DB_BACKUP_DIR=/var/backups/amax-db \
  npx tsx scripts/db-restore-drill.ts \
  --dump=/var/backups/amax-db/amax-db-backup-2026-04-27T02-00-00Z.dump
```

---

## 5. Re-run reconciliation (3 minutes)

After the restore (or immediately after a Path A redeploy) the cron-driven
reconciliations will not have re-run. Force them to record the post-rollback
state:

  * `wallet-ledger-reconciliation` — fire from `/admin/background-jobs`,
    confirm divergence count is 0.
  * `ledger-reconciliation` — same.
  * `posting-receipt-invariant` — same.

Each should produce one new row in the background-jobs table with status
`success` and a non-divergent summary. If any divergence count is non-zero,
**STOP** and page the DB owner before disengaging kill switches.

---

## 6. Verify (~1 minute)

The exact SQL queries below were exercised against the restored scratch
DB during the Task #169 rehearsal — they ran in <100 ms total. Run them
straight against `$DATABASE_URL` after the restore (or after the Path A
redeploy):

```sql
-- Spot-check 1: 3 user wallet caches vs SUM(ledger_entries).
-- For PRODUCTION, expect drift = 0.00000000 on every row. Any non-zero
-- drift means the wallet-ledger reconciliation was wrong even before the
-- rollback OR the restore did not include all relevant ledger rows.
SELECT
  w.user_id,
  w.currency,
  w.balance::numeric                          AS cache_balance,
  COALESCE(SUM(le.amount), 0)::numeric        AS ledger_sum,
  (w.balance::numeric - COALESCE(SUM(le.amount), 0)::numeric) AS drift
FROM wallets w
LEFT JOIN ledger_entries le
  ON le.user_id = w.user_id
 AND le.currency = w.currency
GROUP BY w.user_id, w.currency, w.balance
ORDER BY w.user_id
LIMIT 3;

-- Spot-check 2: torn-journal check on a recent transaction.
-- Every transaction_id must SUM to zero across its ledger_entries rows.
-- Any non-zero `net` is a torn journal and must be investigated before
-- writes resume.
SELECT
  transaction_id,
  COUNT(*)         AS entries,
  SUM(amount)::numeric AS net
FROM ledger_entries
WHERE transaction_id IS NOT NULL
GROUP BY transaction_id
ORDER BY transaction_id DESC
LIMIT 3;
```

  * Spot-check 3: open `/admin/operator-alerts` and visually scan for
    any new entries since the rollback started; investigate each.

> **Dev/staging caveat surfaced by the rehearsal.** Dev fixture data
> seeds wallet rows with non-zero balances but does NOT seed the
> matching `ledger_entries` rows, so spot-check 1 will return non-zero
> `drift` against a dev or freshly-seeded staging DB. That is expected
> and is NOT a restore failure. To distinguish "expected dev drift"
> from "restore actually lost rows", run the same spot-check against
> the PRE-rollback live DB; identical drift on both sides = the restore
> faithfully preserved state. (Verified during Task #169 rehearsal.)

Only when all three pass should you proceed to Step 7.

---

## 7. Disengage kill switches (~30 seconds)

  * If you used the admin UI in Step 1a: open `/admin/kill-switches`,
    toggle each of `transactions`, `deposits`, `withdrawals`,
    `fee_deductions` back OFF (and the **Write kill switch** panel on
    `/admin/dashboard` if you used the global hammer). Each toggle
    requires a reason — use something like `"Rollback complete,
    verified clean"`.
  * If you used the env-var path in Step 1b: REMOVE the
    `DISABLE_TRANSACTIONS` / `DISABLE_DEPOSITS` / `DISABLE_WITHDRAWALS` /
    `DISABLE_FEE_DEDUCTIONS` / `WRITE_KILL_SWITCH` env vars from the
    deployment secrets and trigger one more redeploy. (Reminder from
    Step 1b: env-forced switches CANNOT be cleared from the admin UI;
    the toggle is locked until the env var is gone.)
  * Watch the operator-alerts log and the background-jobs page for the next
    15 minutes. If anything fires, re-engage kill switches and re-open the
    incident.

---

## 8. Post-incident

  * Write up the timeline (T0 alert → kill switches → identify bad deploy
    → redeploy → restore → reconcile → verify → kill switches off).
  * Note which dump was restored and which integrity checks ran on it.
  * If a Path B restore happened, schedule a follow-up audit of any
    user-visible state changes that occurred between the dump's
    `startedAt` timestamp and T0 — those changes are gone.

---

## Rehearsal log

| Date         | Operator notes |
| ------------ | -------------- |
| 2026-04-27   | Task #169 — full Path B walked end-to-end against a real scratch DB on the dev environment. `scripts/db-backup.ts` produced a 0.41 MiB dump in 477 ms; `scripts/db-restore-drill.ts` restored that dump into a fresh scratch DB and passed both integrity checks (`users_table_present`, `ledger_journals_balanced`) in 3.3 s. `scripts/db-restore.ts` against a real scratch URL completed pg_restore in ~5 s; the same script with `--target=$DATABASE_URL` and no `--i-know-what-im-doing` correctly refused with the structural-key error message documented in Step 4c. Step 6 spot-check 1 surfaced expected dev-fixture drift (wallet caches non-zero, ledger sums zero) — captured as the dev/staging caveat in Step 6. Step 6 spot-check 2 returned 0 rows on dev because there are no journaled transactions yet — in production this returns 3 rows. The runbook's pre-rehearsal Step 1 referenced env vars that do not exist in this codebase (`WALLET_DEPOSITS_ENABLED`, `WALLET_WITHDRAWALS_ENABLED`, `INVESTMENT_INSTRUCTIONS_ENABLED`); replaced with the real `DISABLE_*` env vars and the admin-UI primary path. Deploy step previously said "platform deployment UI" generically; replaced with the Replit Deployments tab specifics and the autoscale spin-up budget. |

---

## Reference: backup pipeline

The pieces this runbook depends on are all visible at
`/admin/background-jobs`:

| Job                          | Schedule    | Purpose                                   |
| ---------------------------- | ----------- | ----------------------------------------- |
| `database-backup`            | daily       | `pg_dump` → `DB_BACKUP_DIR` + retention   |
| `database-restore-drill`     | weekly      | Restore latest dump → scratch DB → check  |
| `database-backup-watchdog`   | daily       | Pages an operator if either is stale      |

Stale thresholds (defaults):

  * Backup: 48 h since last `success` row in `database_backup_runs`.
  * Drill: 14 d since last `success` row in `database_restore_drill_runs`.

Operator-page firing means **the rollback safety net is degraded** — fix it
before the next deploy.

## Reference: production storage & offsite shipping (Task #170, #259)

The in-process backup cron only runs when `DB_BACKUP_DIR` is set on the
production deployment. As of Task #170 these values are **set in the
production environment** of `.replit` (`[userenv.production]`, NOT in
`shared`, so dev environments still skip the cron):

| Variable                            | Production value                            | Why |
| ----------------------------------- | ------------------------------------------- | --- |
| `DB_BACKUP_DIR`                     | `/var/backups/amax-db`                      | Where the daily `pg_dump` writes. Persists across restarts on the Reserved VM (see deployment-target note below). |
| `DB_BACKUP_RETENTION`               | `14`                                        | 14 daily local dumps. Older dumps live offsite in S3 only. |
| `DB_BACKUP_OFFSITE_BUCKET`          | `amax-db-backups-prod`                      | S3 bucket the offsite-sync cron pushes dumps to. |
| `DB_BACKUP_OFFSITE_PREFIX`          | `dumps`                                     | Path inside the bucket. Final keys look like `s3://amax-db-backups-prod/dumps/amax-db-backup-…dump`. |
| `DB_BACKUP_OFFSITE_REGION`          | _operator-set_ — region the bucket lives in | Passed to the aws CLI as `--region`. Set on the host that runs the offsite cron. |
| `DB_BACKUP_OFFSITE_SSE`             | `AES256`                                    | Server-side encryption header on every uploaded object. |

> **Deployment-target note (Task #259).** Production runs on a
> **Reserved VM** (`.replit` → `[deployment].deploymentTarget = "vm"`).
> A Reserved VM is always running and keeps its local filesystem across
> restarts, which is what makes the in-process `setInterval` crons in
> `server/index.ts` (the daily `database-backup`, weekly
> `database-restore-drill`, and daily `database-backup-watchdog`) and
> the local `/var/backups/amax-db` directory reliable. Do not switch
> the web tier back to `autoscale` without first moving the backup,
> restore-drill, and watchdog jobs onto a separate scheduler — on
> autoscale containers spin up and down on demand and neither the
> in-process cron nor the local dump directory is guaranteed to
> survive between scaling events.
>
> If a future migration ever does keep autoscale for the web tier, the
> equivalent shape is a Replit Scheduled Deployment (or external cron)
> that invokes `npx tsx scripts/db-backup.ts` daily against a host
> that mounts the same persistent volume. In that world the gated
> block in `server/index.ts` should be wired NOT to register the
> in-process cron on the web tier, otherwise two schedulers race for
> the same dump directory.

### Offsite-sync cron

`scripts/db-backup-offsite.sh` is the offsite shipping half. It uses
`aws s3 sync` to mirror every `amax-db-backup-*.dump` from
`$DB_BACKUP_DIR` up to `s3://$DB_BACKUP_OFFSITE_BUCKET/$DB_BACKUP_OFFSITE_PREFIX/`.
It does **not** pass `--delete`, so dumps live in S3 until the bucket's
lifecycle policy expires them — that gives offsite a longer retention
window than the local 14-day prune.

Install on the production host as a daily cron, scheduled ~30 minutes
after the in-process backup so the latest dump has finished writing:

```cron
# /etc/cron.d/amax-db-backup-offsite
DB_BACKUP_DIR=/var/backups/amax-db
DB_BACKUP_OFFSITE_BUCKET=amax-db-backups-prod
DB_BACKUP_OFFSITE_PREFIX=dumps
DB_BACKUP_OFFSITE_REGION=eu-west-1
DB_BACKUP_OFFSITE_SSE=AES256
AWS_PROFILE=amax-db-backups
15 2 * * * runner /opt/amax/scripts/db-backup-offsite.sh >> /var/log/amax-db-backup-offsite.log 2>&1
```

The IAM principal behind `AWS_PROFILE=amax-db-backups` only needs
`s3:PutObject`, `s3:GetObject`, and `s3:ListBucket` on the bucket — no
delete (lifecycle handles expiry, and we want offsite dumps to be
write-only from the production host's perspective so a host compromise
cannot wipe them).

### Bucket lifecycle policy

Configure once on `amax-db-backups-prod` (Terraform / AWS console). The
policy is what gives offsite dumps their longer retention:

| Rule                  | Action                                         |
| --------------------- | ---------------------------------------------- |
| `expire-old-dumps`    | After **90 days**, delete current versions.    |
| `abort-multipart`     | Abort incomplete multipart uploads after 7 d.  |

Versioning + MFA-delete on the bucket is recommended so an accidental
`aws s3 rm` cannot unrecoverably destroy the offsite copies.

### Restoring from an offsite dump

If `$DB_BACKUP_DIR` is gone (host failure), pull the dump back down
before running the restore in step 4c:

```sh
aws s3 cp \
  s3://amax-db-backups-prod/dumps/amax-db-backup-2026-04-27T02-00-00Z.dump \
  /tmp/amax-db-backup-2026-04-27T02-00-00Z.dump
DATABASE_URL=postgres://... \
  npx tsx scripts/db-restore.ts \
  --dump=/tmp/amax-db-backup-2026-04-27T02-00-00Z.dump \
  --target=$DATABASE_URL \
  --i-know-what-im-doing
```

`aws s3 ls s3://amax-db-backups-prod/dumps/ --recursive | sort | tail -10`
is the offsite equivalent of the `ls -lt $DB_BACKUP_DIR` listing in step 4a.

## Reference: integrity checks

Each weekly drill runs the following on the restored copy:

  * `users_table_present` — `SELECT COUNT(*) FROM users` succeeds and
    returns a finite number.
  * `ledger_journals_balanced` — every `transaction_id` in `ledger_entries`
    SUMs to zero across its rows. A non-zero group is a torn journal and
    fails the drill.

A FAIL on any check marks the drill as `error` and triggers the watchdog
on the next tick. Do not approve a deploy with an `error` drill on record
until the failure is understood.
