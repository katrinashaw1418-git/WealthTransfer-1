# Go/No-Go Runbook

> **Audience:** the launch operator. **Time budget:** ~15 minutes from
> "we are about to launch" to "we have a written GO or NO-GO verdict".

This is the final automated gate before a production launch. It runs the
entire pre-launch safety rollup AND a per-section verification of the
operational checklist (infrastructure, monitoring, alerting, kill switches,
rollback, security, compliance), and writes a structured report you can
attach to the launch ticket.

The verification does **not** decide whether to launch — that's still a
human call. It produces the evidence the human needs.

---

## 1. When to run

* Immediately before promoting a release to production.
* After any change to the pre-launch checklist itself.
* As a post-incident sanity check that the platform is healthy enough to
  resume normal operations.

You can re-run as often as you like. The script is idempotent: kill
switches are restored to their starting state, test alerts are tagged
`drill: true`, and the audit-log probe row is well-formed and tagged so
operators can recognise it later. (The probe row stays forever because
`audit_logs` is append-only by design — that's the whole point of the
compliance check.)

---

## 2. How to run

### Automatic (every deploy — Task #180)

The gate runs automatically as a pre-deploy step on every `Publish`. It
is wired into `.replit` `[deployment].build` via
`scripts/predeploy-build.sh`, which:

1. Runs `npx tsx scripts/go-no-go.ts --deploy-gate` against the
   production-equivalent environment (the same secrets the deploy will
   boot under).
2. **A NO-GO verdict (non-zero exit) blocks the deploy.** Replit's
   build aborts and the new revision is never promoted. The full
   report is pasted into the deploy log so you can see which check
   failed without re-running the script.
3. On GO, runs `npm run build` and copies the report into
   `dist/go-no-go-report.md` — it ships as part of the deploy
   artefact and is inspectable post-deploy at the same path inside
   the running container.

#### `--deploy-gate` mode (Task #218)

The deploy wrapper passes `--deploy-gate` (equivalent to setting
`GO_NO_GO_DEPLOY_GATE=1`) so the on-call channel sees **one** drill
alert per Publish instead of one per known alert source:

* Per-source drills (`wallet-ledger-reconciliation`,
  `posting-receipt-invariant`, `database-restore-drill`,
  `database-backup-watchdog`, `kill-switch`,
  `stuck-pending-transactions`, `audit-log-write-failure`,
  `db-connection-failure`, `operator-alerts-prune-watchdog`) are
  dispatched to the **log channel and `operator_alerts` table only** —
  the webhook is suppressed for them. Their `details.scheduledBy`
  reads `scripts/go-no-go.ts (--deploy-gate)` so they are recognisable.
* A single rolled-up alert with `source: "launch-readiness-gate"` and
  `details.rolledUp: true` is dispatched through the full pipeline
  after the loop. This is the only alert that reaches the on-call
  webhook; its title is `Pre-launch alerting drill complete — N/N
  sources OK`.

A real (non-drill) alert is unaffected — it is dispatched directly by
the originating job through `notifyOperator()` and goes straight to the
on-call webhook with its real severity, exactly as before.

See `docs/DEPLOYMENT_RUNBOOK.md` for the full deploy procedure and the
list of deployment secrets the gate needs.

### Scheduled (nightly — Task #217)

The gate ALSO runs unattended once per day from inside the running
server. Several of its checks (latest backup freshness, restore-drill
freshness, audit-log triggers) decay quietly between deploys; if a week
passes with no `Publish`, the first time you'd notice a broken backup
cron is in the deploy log on hotfix day — exactly when you don't want
to be debugging it. The nightly run surfaces that drift the morning
after it happens.

How it's wired:

* `server/services/nightly-go-no-go.ts` spawns
  `npx tsx scripts/go-no-go.ts --deploy-gate` as a child process. The
  `--deploy-gate` flag is the same one `scripts/predeploy-build.sh`
  passes — it keeps the gate's per-source drill alerts log+DB only and
  collapses them into a single info-severity rollup, so the on-call
  webhook is hit at most once per night for routine "drill complete"
  confirmation, and only fired with `severity="alert"` when the verdict
  itself is NO-GO. Spawning as a child also keeps the gate's
  kill-switch toggles and route registration from conflicting with the
  live server.
* The cron is registered in `server/index.ts` and runs ~10 minutes after
  process boot, then every 24h. Each tick is wrapped in
  `withBackgroundJobRunRecord("nightly-go-no-go", …)` so the admin
  Background Jobs page shows when it last ran (and whether it is overdue).
* **NO-GO verdict** → `notifyOperator(severity="alert")` fires. The
  on-call channel is paged via `OPERATOR_ALERT_WEBHOOK_URL` with a
  `nightly-go-no-go` source tag. The alert `details` payload carries
  the full markdown report under `details.report` (truncated at 200KB
  if absurdly long) plus `details.reportPath` for the on-disk copy.
* **GO verdict** → an info-level row is inserted directly into
  `operator_alerts` WITHOUT firing the webhook (a daily "all good" page
  would train operators to ignore the channel and defeat the point of
  paging on real NO-GO). The dashboard still carries today's report so
  the latest verdict is always retrievable from a durable store.

How to inspect the latest nightly run:

* **Background Jobs page** (admin) — shows the most recent
  `nightly-go-no-go` run, its summary line, and `isOverdue` if the
  scheduler hasn't ticked in > 36 hours.
* **Operator Alerts page** (admin) — filter on
  source = `nightly-go-no-go` to see every recorded run. The full
  markdown report is in `details.report` on each row; copy-paste it
  into a viewer to read it like the deploy-time report.
* **Runner filesystem** — every run also writes a fresh
  `docs/golive/go-no-go-<timestamp>.md` file. This is the same path
  used by the manual + auto-deploy runs and is the source of truth that
  feeds `details.report` above.

To disable the nightly cron in dev shells, set
`NIGHTLY_GO_NO_GO_DISABLED=1` in the environment before booting the
server. The override is intentionally explicit — production deploys
should never set it.

The script is idempotent (kill switches restored, drill alerts tagged
`drill: true`, audit-log probe rows tagged `runId`), so a daily
schedule does not pollute the system. See section 5 for the full list
of artefacts each run leaves behind.

### Manual (interactive)

```sh
# From project root, with DATABASE_URL pointed at the env you want to
# validate AND the same secrets the deploy will boot with.
npx tsx scripts/go-no-go.ts
echo "exit code: $?"
```

A green run prints `Verdict: GO ✅` on the last line and exits 0. Any
failure prints `Verdict: NO-GO ❌` and exits 1.

The full report is written to:

```
docs/golive/go-no-go-<ISO-timestamp>.md
```

The script prints the path on the first line of its summary block.

The auto-deploy wiring is just a no-human-required call of the same
script — there is no separate code path, so an interactive run and an
auto-deploy run produce identical reports.

### Required environment

The script needs the same configuration the deploy will run under:

* `DATABASE_URL` — pointed at the production-equivalent database.
* `JWT_SECRET` — must be set; the auth layer refuses to boot without it.
* `OPERATOR_ALERT_WEBHOOK_URL` — required for the alerting drill to PASS.
  Without it, alerts only reach stdout, which is invisible to off-hours
  operators; the orchestrator marks this NO-GO.
* `DB_BACKUP_DIR` — required for the infrastructure & rollback sections
  to PASS. Without it, no backup or restore drill has ever recorded a
  successful run.
* `LOG_DIR` — required so 5xx errors are persisted across restarts. The
  app falls back to `./logs` when unset, but that's ephemeral inside a
  container and post-incident forensics become impossible.

Required-env presence is validated against a snapshot taken **before**
`scripts/_bootstrap-test-env.ts` injects its dev-time defaults — a
missing real production secret cannot be masked by the bootstrap.

### Optional flags / env

* `--deploy-gate` (or `GO_NO_GO_DEPLOY_GATE=1`) — switches the alerting
  section into rollup mode. Per-source drills go log+DB only and a
  single rolled-up "drill complete" alert is dispatched through the
  webhook. Used by `scripts/predeploy-build.sh` so every Publish pages
  the on-call channel exactly once. Leave it OFF when running the script
  by hand to debug a specific source's webhook reachability.

---

## 3. How to interpret the report

The report's first block is the verdict and the per-section pass/fail
summary table:

```
**Verdict:** **GO**

| Section | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Pre-launch safety rollup | 1 | 0 | 0 |
| Infrastructure | 3 | 0 | 0 |
| Monitoring | 3 | 0 | 0 |
...
```

Then one section per checklist area, with one block per check:

```
### PASS — Test alert: kill-switch
…
### FAIL — Latest successful backup is fresh
> **What to do:** Investigate the daily backup cron …
```

### Verdict rules

* **GO** — every check passed. Safe to proceed (the human still calls go).
* **NO-GO** — any check is `FAIL` or `SKIP`. A SKIP is "we did not
  actually verify this", which is *not* the same as a real PASS. Treat
  it as a NO-GO and either fix the underlying gap (preferred) or
  document the conscious deferral on the launch ticket before
  overriding.

### Mapping FAILs to action

Each FAIL has a `> **What to do:** …` hint pointing at the relevant
runbook or task. Common categories:

| FAIL | Action |
| --- | --- |
| `Pre-launch safety rollup` | See `docs/PRE_LAUNCH_CHECKLIST.md` and re-run `npx tsx scripts/pre-launch-safety.ts --strict` for full output. |
| `Latest successful backup is fresh` | Run `npx tsx scripts/db-backup.ts`; check the `database_backup_runs` table. |
| `Last successful restore drill is fresh` | Run `npx tsx scripts/db-restore-drill.ts`; see `docs/runbooks/rollback.md`. |
| `Test alert: <source>` | Verify `OPERATOR_ALERT_WEBHOOK_URL` and the receiver. The drill payload is tagged `drill: true` so the receiver can be filtered. |
| `Kill switch toggle drill` | Inspect `kill_switches` and `audit_logs` for that key; ensure the corresponding `DISABLE_*` env var is unset (env-forced switches cannot be drilled). |
| `Upload rejection (disallowed mime)` | Re-run `server/services/upload-security.test.ts` to localise the regression. |
| `Admin routes registered + guarded` | Check `registerAdminRoutes()` is invoked in `registerRoutes()`. |
| `audit_logs UPDATE/DELETE blocked at the DB layer` | Re-run `installAuditLogsImmutabilityTriggers()` at boot; see `server/services/audit-immutability-migration.ts`. |
| `No synthetic portfolio data in client views` | Replace inline numeric arrays with real data sources; see header of `scripts/test-no-synthetic-portfolio-data.ts`. |

---

## 4. What the script does NOT prove

These are deliberately out of scope for the orchestrator and need their
own validation track:

* **The business decision to launch.** The orchestrator produces the
  verdict and report; the human still calls go.
* **Load testing.** The script asserts correctness under low concurrency
  only. Sustained burst behaviour belongs to a dedicated load-test rig.
* **Real custodian / bank SDK connectivity.** The ledger-vs-custodian
  reconciliation in the safety rollup runs against a deterministic stub.
* **Frontend / UX.** No claims are made about the React client.

See `docs/PRE_LAUNCH_CHECKLIST.md` for the full list of out-of-scope
gates that must pass on their own track before launch.

---

## 5. Drill artefacts left behind

| Artefact | Where | Why it's safe |
| --- | --- | --- |
| `__golive_drill_admin` user | `users` | Used to mint admin JWTs for the metrics + admin-route checks. Reused across re-runs. |
| `[drill <runId>] …` audit rows | `audit_logs` | Kill-switch ON/OFF/restore transitions. Tagged with the runId so they're recognisable. Audit_logs is append-only by design — you cannot delete them. |
| `go-no-go-immutability-probe-<runId>` audit row | `audit_logs` | One row per run from the immutability check. Same append-only constraint. |
| `operator_alerts` rows tagged `drill: true` | `operator_alerts` | One per known alert source per run, plus (in `--deploy-gate` mode) one rolled-up `source: "launch-readiness-gate"` row tagged `details.rolledUp = true`. Recognisable by `details.drill = true`. |
| Drill kill-switch transitions | `kill_switches` | The state itself is restored to its starting value. Only the row's `lastToggledAt` / `reason` reflect the most recent drill. |

---

## 6. Failure modes of the orchestrator itself

* The script prints `[go-no-go] orchestrator crashed: <error>` and exits 1
  if it can't even produce the report. This is itself a NO-GO — debug
  the crash before treating any earlier output as authoritative.
* If `pre-launch-safety.ts` cannot spawn (e.g. `npx`/`tsx` missing), the
  rollup section reports SKIP rather than PASS. SKIP is a NO-GO.

---

## 7. Cross-references

* `docs/PRE_LAUNCH_CHECKLIST.md` — the underlying rollup script and what
  it proves.
* `docs/runbooks/rollback.md` — the safety net for a bad deploy; the
  rollback section verifies this is fresh.
* `docs/DEPLOYMENT_RUNBOOK.md` — the deploy procedure itself.
