#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-deploy launch readiness gate + production build (Task #180).
#
# Wired into Replit's [deployment].build in `.replit`. Replaces the bare
# `npm run build` so EVERY deploy is gated on TWO hard checks against
# the same secrets the deploy itself will boot under:
#
#   STAGE 1 (Task #151):
#     `npx tsx scripts/pre-launch-safety.ts --strict`
#     Strict mode treats a SKIP as a real failure — i.e. a launch is
#     blocked even when a real-money safety gate quietly self-skipped
#     (sub-script crashed at boot, route wasn't registered, recon
#     service had no data to actually verify, etc). Output is streamed
#     live so the per-gate PASS/FAIL/SKIP lines are visible at the TOP
#     of the deploy log — operators can see exactly which gate(s) need
#     remediation without having to scroll through the broader go-no-go
#     report. A non-zero exit here exits this wrapper immediately and
#     blocks the deploy.
#
#   STAGE 2 (Task #150 + #218):
#     `npx tsx scripts/go-no-go.ts --deploy-gate --skip-pre-launch-safety`
#     Broader launch readiness checks (infrastructure, monitoring,
#     alerting drills, kill switches, rollback, security, compliance).
#     `--skip-pre-launch-safety` short-circuits the orchestrator's
#     own pre-launch-safety section to a single "delegated" PASS so
#     the multi-minute strict rollup does not run a second time —
#     Stage 1 already proved it green. A NO-GO verdict here also
#     blocks the deploy.
#
# Exit semantics (drives Replit's "block the deploy" behaviour):
#   * Stage 1 fail (non-zero) → wrapper exits non-zero immediately;
#                               the strict-gate output (visible above)
#                               is the operator's remediation surface.
#                               Replit's deploy build aborts and the
#                               new revision is NOT promoted.
#   * Stage 2 fail (NO-GO)    → print the go-no-go report to stdout
#                               (so it lives in the deploy log even
#                               when the dist/ artefact is never
#                               produced), then exit non-zero. Replit's
#                               deploy build aborts and the new
#                               revision is NOT promoted.
#   * Both stages green       → run the production build, copy the
#                               latest go-no-go report into dist/ as
#                               part of the deploy artefact, exit 0.
#
# Pre-deploy env required (configure these as Replit deployment
# secrets — dev fallbacks from scripts/_bootstrap-test-env.ts do NOT
# count towards the gate; see scripts/_raw-env-snapshot.ts):
#   * DATABASE_URL                — pointed at the production DB
#   * JWT_SECRET                  — boot secret
#   * NODE_ENV                    — usually "production"
#   * LOG_DIR                     — persistent volume for errors.log
#   * OPERATOR_ALERT_WEBHOOK_URL  — on-call Slack/PagerDuty webhook
#   * DB_BACKUP_DIR               — backup pipeline target dir
#
# See `docs/runbooks/go-no-go.md` for what each section verifies and
# `docs/DEPLOYMENT_RUNBOOK.md` for how this slots into the launch
# procedure.
# ---------------------------------------------------------------------------
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Build-time NODE_ENV. The launch gates (Stages 1 + 2 below) insert fixture
# rows to drive their drills; server/services/fixture-data-guard.ts hard-
# refuses inserts when NODE_ENV=production with no override possible. The
# raw-env snapshot the gates check (scripts/_raw-env-snapshot.ts) just
# requires NODE_ENV to be SET, not to equal "production". So we force
# "test" here for the build container only — the runtime entrypoint
# (`npm run start` → `NODE_ENV=production node dist/index.js`) sets
# NODE_ENV=production inline for the actual deployed app, so production
# behaviour is preserved at runtime regardless of what we set here.
export NODE_ENV="${NODE_ENV:-test}"

REPORT_DIR="docs/golive"
ARTEFACT_NAME="go-no-go-report.md"

# Task #231 — per-invocation strict-gate verdict file. Stage 1 below writes
# its per-gate PASS/FAIL/SKIP outcome here as JSON via `--json-verdict`, so
# `scripts/record-strict-gate-verdict.ts` can append a deploy-trend line to
# `docs/PRE_LAUNCH_CHECKLIST.md` AND insert an `operator_alerts` info row.
# Both surfaces let an operator spot SKIP trends across deploys without
# having to scroll through individual ephemeral deploy logs. Filename is
# timestamped + matches the `docs/golive/strict-gate-*.json` glob.
PREDEPLOY_TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)"
STRICT_GATE_VERDICT_PATH="$REPORT_DIR/strict-gate-${PREDEPLOY_TIMESTAMP}.json"
mkdir -p "$REPORT_DIR"

echo "[predeploy] ============================================================"
echo "[predeploy] Launch readiness gates (Stages 1 + 2)"
echo "[predeploy] Started:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[predeploy] NODE_ENV: ${NODE_ENV:-(unset)}"
echo "[predeploy] Verdict:  ${STRICT_GATE_VERDICT_PATH}"
echo "[predeploy] ============================================================"

# Task #231 — best-effort recorder. Reads the strict-gate verdict JSON and
# appends a deploy-trend line to `docs/PRE_LAUNCH_CHECKLIST.md` plus an
# `operator_alerts` info row. Wrapped in `set +e` so a recorder failure
# (read-only filesystem, schema drift, missing DATABASE_URL) NEVER blocks
# the deploy — the deploy's pass/fail is owned by the gates themselves.
record_strict_gate_verdict() {
  set +e
  npx tsx scripts/record-strict-gate-verdict.ts "$STRICT_GATE_VERDICT_PATH"
  local rec_status=$?
  set -e
  if [ "$rec_status" -ne 0 ]; then
    echo "[predeploy] [verdict-recorder] WARNING: recorder exited $rec_status —" \
         "trend line may not have been persisted. This is non-fatal."
  fi
}

# ---------------------------------------------------------------------------
# STAGE 1 — pre-launch safety (strict). Task #151.
#
# Stream output live (no -o pipefail capture, no buffering) so the per-
# gate PASS/FAIL/SKIP lines from scripts/pre-launch-safety.ts are
# visible at the top of the deploy log as they happen. Operators
# triaging a blocked deploy should not have to scroll past the broader
# go-no-go output to find the actual SKIP/FAIL gate name — that's the
# whole point of running the strict gate as Stage 1.
# ---------------------------------------------------------------------------
echo ""
echo "[predeploy] [strict-gate] ----------------------------------------------"
echo "[predeploy] [strict-gate] STAGE 1: pre-launch-safety.ts --strict"
echo "[predeploy] [strict-gate] (SKIP is treated as a real failure — Task #151)"
echo "[predeploy] [strict-gate] ----------------------------------------------"

set +e
# Task #231 — `--json-verdict` writes a structured per-gate outcome JSON to
# the path computed at the top of this script. The recorder below reads it
# and persists a one-line trend entry to the pre-launch checklist + an
# `operator_alerts` info row, so SKIP regressions are spottable across
# deploys without scrolling through individual deploy logs.
npx tsx scripts/pre-launch-safety.ts --strict \
  --json-verdict "$STRICT_GATE_VERDICT_PATH"
STRICT_STATUS=$?
set -e

# Task #231 — record the verdict BEFORE we exit (on FAIL) or proceed to
# Stage 2 (on PASS). Persistence happens regardless of outcome — capturing
# every FAIL / SKIP is the whole point of the trend artefact.
record_strict_gate_verdict

if [ "$STRICT_STATUS" -ne 0 ]; then
  echo ""
  echo "[predeploy] ============================================================"
  echo "[predeploy] NO-GO — Stage 1 (pre-launch-safety --strict) failed"
  echo "[predeploy]         exit=$STRICT_STATUS"
  echo "[predeploy] ============================================================"
  echo "[predeploy] One or more pre-launch safety gates either FAILED outright"
  echo "[predeploy] or SKIPPED (which under --strict is also a real failure)."
  echo "[predeploy] The per-gate PASS/FAIL/SKIP lines are above — search the"
  echo "[predeploy] deploy log for 'FAIL' and 'SKIP' to find the gate name."
  echo "[predeploy]"
  echo "[predeploy] Structured verdict (per-gate JSON, Task #231):"
  echo "[predeploy]   $STRICT_GATE_VERDICT_PATH"
  echo "[predeploy]"
  echo "[predeploy] To reproduce locally against the same DB:"
  echo "[predeploy]   npx tsx scripts/pre-launch-safety.ts --strict"
  echo "[predeploy]"
  echo "[predeploy] See docs/PRE_LAUNCH_CHECKLIST.md for what each gate proves"
  echo "[predeploy] and the 'Deploy strict-gate verdicts' section for SKIP"
  echo "[predeploy] trends across recent deploys."
  echo "[predeploy] Deploy is BLOCKED. Fix the failing/skipped gate(s) and"
  echo "[predeploy] re-publish."
  exit "$STRICT_STATUS"
fi

echo ""
echo "[predeploy] [strict-gate] STAGE 1 PASS — pre-launch-safety strict run"
echo "[predeploy] [strict-gate] is green (zero FAIL, zero SKIP). Proceeding"
echo "[predeploy] [strict-gate] to Stage 2 (broader go-no-go checks)."
echo ""

# ---------------------------------------------------------------------------
# STAGE 2 — broader launch readiness orchestrator. Task #150 + #218.
# ---------------------------------------------------------------------------
echo "[predeploy] ------------------------------------------------------------"
echo "[predeploy] STAGE 2: scripts/go-no-go.ts --deploy-gate"
echo "[predeploy] (--skip-pre-launch-safety: Stage 1 already covered it)"
echo "[predeploy] ------------------------------------------------------------"

# Snapshot existing reports BEFORE the gate runs so we can isolate the
# file produced by THIS invocation. Without this, a crashed orchestrator
# that never wrote a fresh report would cause us to surface a stale
# report from a previous run and mislead the operator.
mkdir -p "$REPORT_DIR"
PRE_RUN_LIST="$(mktemp)"
POST_RUN_LIST="$(mktemp)"
trap 'rm -f "$PRE_RUN_LIST" "$POST_RUN_LIST"' EXIT
ls -1 "$REPORT_DIR"/go-no-go-*.md 2>/dev/null | sort > "$PRE_RUN_LIST" || true

set +e
# --deploy-gate (Task #218): per-source drill alerts skip the webhook
# channel and a single rolled-up "drill complete: N/N sources OK" alert
# is dispatched at the end. Without this flag every Publish would page
# the on-call channel nine times. Manual interactive runs of
# `npx tsx scripts/go-no-go.ts` keep the per-source webhook behaviour
# for debugging.
#
# --skip-pre-launch-safety (Task #151): Stage 1 above already ran the
# multi-minute strict rollup as the first hard deploy gate, with its
# per-gate PASS/FAIL/SKIP lines streamed live to the deploy log.
# Without this flag the orchestrator's preLaunchSafetySection would
# spawn the same script a second time, doubling deploy time. With the
# flag the section short-circuits to a single "delegated" PASS that
# points an operator back at the Stage 1 output above.
npx tsx scripts/go-no-go.ts --deploy-gate --skip-pre-launch-safety
GATE_STATUS=$?
set -e

# Resolve the report THIS run wrote: a file present after the gate that
# was not present before. If the orchestrator crashed before writing
# anything, this is empty — and we explicitly say so rather than
# attaching a previous run's report.
ls -1 "$REPORT_DIR"/go-no-go-*.md 2>/dev/null | sort > "$POST_RUN_LIST" || true
CURRENT_RUN_REPORT="$(comm -13 "$PRE_RUN_LIST" "$POST_RUN_LIST" | tail -n 1 || true)"

if [ "$GATE_STATUS" -ne 0 ]; then
  echo ""
  echo "[predeploy] ============================================================"
  echo "[predeploy] NO-GO — Stage 2 (go-no-go orchestrator) failed"
  echo "[predeploy]         exit=$GATE_STATUS"
  echo "[predeploy] ============================================================"
  if [ -n "$CURRENT_RUN_REPORT" ] && [ -f "$CURRENT_RUN_REPORT" ]; then
    echo "[predeploy] Report: $CURRENT_RUN_REPORT"
    echo "[predeploy] --- BEGIN go-no-go report ---"
    cat "$CURRENT_RUN_REPORT"
    echo "[predeploy] --- END go-no-go report ---"
  else
    echo "[predeploy] No current-run report produced — orchestrator crashed"
    echo "[predeploy] before writing docs/golive/go-no-go-*.md. See the stack"
    echo "[predeploy] trace above for the root cause. Prior reports in"
    echo "[predeploy] $REPORT_DIR are deliberately NOT surfaced here so an"
    echo "[predeploy] operator does not mistake a stale GO/NO-GO for this run."
  fi
  echo "[predeploy] Deploy is BLOCKED. Fix the failures and re-publish."
  exit "$GATE_STATUS"
fi

echo ""
echo "[predeploy] GO — launch readiness gate passed."
if [ -n "$CURRENT_RUN_REPORT" ] && [ -f "$CURRENT_RUN_REPORT" ]; then
  echo "[predeploy] Report: $CURRENT_RUN_REPORT"
else
  # Defensive: a GO with no fresh report means the gate exited 0 without
  # producing the artefact it promises. Fail closed — refusing to ship a
  # deploy without an attached report is safer than shipping one with
  # nothing to point at later.
  echo "[predeploy] FAIL: gate exited 0 but no current-run report was written"
  echo "[predeploy]       to $REPORT_DIR. Refusing to build the deploy"
  echo "[predeploy]       artefact without an attachable report."
  exit 1
fi

echo "[predeploy] ------------------------------------------------------------"
echo "[predeploy] Running production build (npm run build)..."
echo "[predeploy] ------------------------------------------------------------"
npm run build

# Stage the report inside the deploy artefact so it ships with the
# revision and is inspectable post-deploy.
mkdir -p dist
cp "$CURRENT_RUN_REPORT" "dist/$ARTEFACT_NAME"
echo "[predeploy] Attached go-no-go report to deploy artefact: dist/$ARTEFACT_NAME"

echo "[predeploy] ============================================================"
echo "[predeploy] Pre-deploy gate + build complete. Promoting revision."
echo "[predeploy] ============================================================"
