#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-deploy launch readiness gate + production build (Task #180).
#
# Wired into Replit's [deployment].build in `.replit`. Replaces the bare
# `npm run build` so EVERY deploy is gated on `scripts/go-no-go.ts`
# returning a GO verdict, against the same secrets the deploy itself
# will boot under.
#
# Exit semantics (drives Replit's "block the deploy" behaviour):
#   * Gate exit 0 (GO)   → run the production build, copy the latest
#                          go-no-go report into dist/ as part of the
#                          deploy artefact, exit 0.
#   * Gate exit non-zero → print the full report to stdout (so it lives
#                          in the deploy log even when the dist/
#                          artefact is never produced), then exit
#                          non-zero. Replit's deploy build aborts and
#                          the new revision is NOT promoted.
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

REPORT_DIR="docs/golive"
ARTEFACT_NAME="go-no-go-report.md"

echo "[predeploy] ============================================================"
echo "[predeploy] Launch readiness gate (scripts/go-no-go.ts)"
echo "[predeploy] Started:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[predeploy] NODE_ENV: ${NODE_ENV:-(unset)}"
echo "[predeploy] ============================================================"

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
npx tsx scripts/go-no-go.ts
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
  echo "[predeploy] NO-GO — launch readiness gate failed (exit $GATE_STATUS)"
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
