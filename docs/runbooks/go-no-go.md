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

None today. Future toggles (e.g. a per-section `--only=alerting`) will
land here when the checklist grows.

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
| `operator_alerts` rows tagged `drill: true` | `operator_alerts` | One per known alert source per run. Recognisable by `details.drill = true`. |
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
