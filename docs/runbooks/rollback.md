# Rollback Runbook

> **Audience:** the on-call operator. **Time budget:** target < 30 minutes from
> "we need to rollback" to "production is healthy on the previous version with
> a verified database state".

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

## 1. Engage the kill switches (30 seconds)

Before anything else, halt new state changes so the rollback target is a
moving averaged minimum, not a moving target.

  * Set `WALLET_DEPOSITS_ENABLED=false`, `WALLET_WITHDRAWALS_ENABLED=false`,
    and `INVESTMENT_INSTRUCTIONS_ENABLED=false` (or the project's equivalent
    deployment-time env vars). This is the standard halt-the-world configuration.
  * Confirm in the application logs that the next inbound write returns
    "feature disabled".

Leave kill switches engaged until **after** Step 6's verification passes.

---

## 2. Identify the bad deploy (2 minutes)

  * Open the deployment history. Note the SHA / version of the **last known
    good** deploy AND the SHA of the deploy currently running.
  * Cross-reference with the operator-alerts log
    (`/admin/operator-alerts/log`). The first alert that fired after the bad
    deploy is your "T0".
  * Cross-reference with the background-jobs page
    (`/admin/background-jobs`) — a divergence row from
    `wallet-ledger-reconciliation` or `posting-receipt-invariant` after T0
    is the strongest "Path B" signal.

Record both SHAs in the incident channel before proceeding.

---

## 3. Path A — Redeploy the previous version

If the decision tree said Path A:

  1. Trigger a redeploy of the last-known-good SHA via the platform
     deployment UI.
  2. Wait for the new deploy to come up healthy (`/api/health` 200 +
     workflow logs settle).
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

### 4b. Redeploy the previous code FIRST

This is intentional. Restore-then-redeploy can briefly expose the bad code
to the rolled-back data and re-corrupt it. The order is:

  1. Trigger a redeploy of the last-known-good SHA.
  2. Wait for the new deploy to come up.
  3. Confirm kill switches are still engaged (Step 1).

### 4c. Restore the dump

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

## 6. Verify (5 minutes)

  * Spot-check 3 user accounts: wallet cache balance ==
    `SUM(ledger_entries)` for that user/currency.
  * Spot-check 1 recent transaction: ledger entries for that
    `transactionId` SUM to zero (no torn journal).
  * Spot-check the operator-alerts log for any new entries since the
    rollback started; investigate each.

Only when all three pass should you proceed to Step 7.

---

## 7. Disengage kill switches

  * Restore `WALLET_DEPOSITS_ENABLED`, `WALLET_WITHDRAWALS_ENABLED`,
    `INVESTMENT_INSTRUCTIONS_ENABLED` to `true`.
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

## Reference: production storage & offsite shipping (Task #170)

The in-process backup cron only runs when `DB_BACKUP_DIR` is set on the
production deployment. As of Task #170 these values are **set in the
production environment** of the deployment secrets pane (NOT in `shared`,
so dev environments still skip the cron):

| Variable                            | Production value                            | Why |
| ----------------------------------- | ------------------------------------------- | --- |
| `DB_BACKUP_DIR`                     | `/var/backups/amax-db`                      | Where the daily `pg_dump` writes. Must be a persistent mount (see deployment-target prerequisite below). |
| `DB_BACKUP_RETENTION`               | `14`                                        | 14 daily local dumps. Older dumps live offsite in S3 only. |
| `DB_BACKUP_OFFSITE_BUCKET`          | `amax-db-backups-prod`                      | S3 bucket the offsite-sync cron pushes dumps to. |
| `DB_BACKUP_OFFSITE_PREFIX`          | `dumps`                                     | Path inside the bucket. Final keys look like `s3://amax-db-backups-prod/dumps/amax-db-backup-…dump`. |
| `DB_BACKUP_OFFSITE_REGION`          | _operator-set_ — region the bucket lives in | Passed to the aws CLI as `--region`. Set on the host that runs the offsite cron. |
| `DB_BACKUP_OFFSITE_SSE`             | `AES256`                                    | Server-side encryption header on every uploaded object. |

> **Deployment-target prerequisite.** The current `.replit` deployment
> target is `autoscale`, which spins containers up and down on demand.
> Local-disk paths and the in-process `setInterval` cron in
> `server/index.ts` are not guaranteed to survive between scaling events
> on autoscale. For the daily backup to actually fire and for
> `/var/backups/amax-db` to retain dumps across restarts, production
> must run as ONE of:
>   1. a **Reserved VM** deployment with a persistent volume mounted at
>      `/var/backups/amax-db`, OR
>   2. an external scheduler (Replit Scheduled Deployment, host cron,
>      AWS EventBridge) that invokes `npx tsx scripts/db-backup.ts`
>      against a host that mounts the persistent volume.
>
> The env vars above are already set so that as soon as the
> deployment-target migration lands, the daily backup, weekly restore
> drill, and freshness watchdog all activate on the next deploy with no
> further config change. Until then the in-process cron is best-effort
> on autoscale (a container that happens to live > 7 minutes will
> attempt the first backup); the watchdog will page if no successful
> backup row appears within 48 hours, which is exactly the visibility
> we want into the gap.

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
