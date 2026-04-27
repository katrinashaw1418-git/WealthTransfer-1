#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Smoke test for scripts/predeploy-build.sh exit semantics
# (Task #180; extended in Task #151 for the Stage 1 strict gate).
#
# Pure-bash, no DB, no network. Stubs `npx` and `npm` on PATH so the
# wrapper exercises every branch without touching the live gate. Use
# this in CI to guard against regressions in the predeploy wrapper's
# block / pass / stale-report behaviour.
#
# The wrapper now runs in two stages:
#   STAGE 1 — `npx tsx scripts/pre-launch-safety.ts --strict`
#             SKIP-as-fail strict gate. Non-zero blocks the deploy
#             immediately, before Stage 2 ever runs (Task #151).
#   STAGE 2 — `npx tsx scripts/go-no-go.ts --deploy-gate
#                                          --skip-pre-launch-safety`
#             Broader launch readiness orchestrator. Non-zero NO-GO
#             also blocks the deploy.
#
# Asserts:
#   1. Stage 1 FAIL (strict gate non-zero)  → wrapper exits non-zero
#                                             with "Stage 1" NO-GO
#                                             banner; Stage 2 never
#                                             runs; no dist/.
#   2. Stage 1 PASS, Stage 2 NO-GO + report → wrapper exits non-zero
#                                             with "Stage 2" banner,
#                                             prints the NEW report
#                                             (not the stale one); no
#                                             dist/.
#   3. Stage 1 PASS, Stage 2 crash before
#      report                                → wrapper exits non-zero,
#                                             explicitly refuses to
#                                             print the stale report;
#                                             no dist/.
#   4. Stage 1 PASS, Stage 2 GO with fresh
#      report                                → wrapper exits 0, runs
#                                             npm run build, attaches
#                                             the NEW report (not the
#                                             stale one) to
#                                             dist/go-no-go-report.md.
#
# Run: bash scripts/test-predeploy-gate.sh
# Exit 0 = all assertions pass; non-zero on any mismatch.
# ---------------------------------------------------------------------------
set -u
set -o pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$PROJECT_ROOT/scripts/predeploy-build.sh"

if [ ! -f "$WRAPPER" ]; then
  echo "[smoke] missing wrapper: $WRAPPER" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

# run_case args:
#   $1  name
#   $2  stage1_status  — exit code of `pre-launch-safety.ts --strict`
#   $3  stage2_status  — exit code of `go-no-go.ts ...`
#                        (irrelevant when stage1_status != 0)
#   $4  produce_report — yes|no — whether the go-no-go stub writes a
#                        fresh report (irrelevant when stage1 fails)
#   $5  verdict_label  — GO|NO-GO|(none) — written into the fresh report
#   $6  expected_exit  — wrapper exit code
#   $7  expect_in_out  — substring that MUST appear in stdout (or "")
#   $8  forbid_in_out  — substring that MUST NOT appear in stdout (or "")
#   $9  artefact       — artefact_present|artefact_absent
run_case() {
  local name="$1"
  local stage1_status="$2"
  local stage2_status="$3"
  local produce_report="$4"
  local verdict_label="$5"
  local expected_exit="$6"
  local expect_in_out="$7"
  local forbid_in_out="$8"
  local artefact="$9"

  local case_dir="$WORK/$name"
  local report_dir="$case_dir/docs/golive"
  local stale_report="$report_dir/go-no-go-STALE-PREVIOUS-RUN.md"
  local bindir="$case_dir/bin"

  mkdir -p "$report_dir" "$bindir"
  echo "STALE: from a previous run, MUST NOT be surfaced as current" \
    > "$stale_report"

  # `npx` stub dispatches on the second arg (the script path) so the
  # wrapper's two stages get distinct exit codes. Anything we don't
  # recognise exits 0 so we don't accidentally mask a regression.
  cat > "$bindir/npx" << EOF
#!/usr/bin/env bash
# args: tsx <script> [--flags...]
script="\${2:-}"
case "\$script" in
  scripts/pre-launch-safety.ts)
    echo "[strict-stub] simulated pre-launch-safety.ts --strict"
    if [ "$stage1_status" -ne 0 ]; then
      echo "[strict-stub] FAIL existing: test-transaction-safety — synthetic"
      echo "[strict-stub] SKIP lifecycle: 1 — synthetic skip reason"
    else
      echo "[strict-stub] PASS — all gates green"
    fi
    exit $stage1_status
    ;;
  scripts/go-no-go.ts)
    if [ "$produce_report" = "yes" ]; then
      sleep 0.05
      cat > "$report_dir/go-no-go-CURRENT-RUN.md" << 'REPORT'
# Pre-launch GO/NO-GO report
**Verdict:** $verdict_label
* synthetic report from this run
REPORT
    fi
    exit $stage2_status
    ;;
  *)
    echo "[npx-stub] unexpected invocation: \$@" >&2
    exit 0
    ;;
esac
EOF
  chmod +x "$bindir/npx"

  cat > "$bindir/npm" << EOF
#!/usr/bin/env bash
mkdir -p "$case_dir/dist"
echo "fake build output" > "$case_dir/dist/index.js"
exit 0
EOF
  chmod +x "$bindir/npm"

  # Copy the wrapper into the case dir so it resolves \$REPORT_DIR
  # (relative path) under the case-specific working directory.
  mkdir -p "$case_dir/scripts"
  cp "$WRAPPER" "$case_dir/scripts/predeploy-build.sh"

  local out exit_code
  out="$(cd "$case_dir" && PATH="$bindir:$PATH" bash scripts/predeploy-build.sh 2>&1)"
  exit_code=$?

  echo "----- $name -----"
  echo "$out" | sed 's/^/  /'
  echo "  wrapper_exit=$exit_code"
  echo

  assert "$name: exit code" "$expected_exit" "$exit_code"
  if [ -n "$expect_in_out" ]; then
    if echo "$out" | grep -qF -- "$expect_in_out"; then
      :
    else
      echo "FAIL [$name]: expected stdout to contain: $expect_in_out" >&2
      failures=$((failures + 1))
    fi
  fi
  if [ -n "$forbid_in_out" ]; then
    if echo "$out" | grep -qF -- "$forbid_in_out"; then
      echo "FAIL [$name]: stdout MUST NOT contain: $forbid_in_out" >&2
      failures=$((failures + 1))
    fi
  fi
  case "$artefact" in
    artefact_present)
      if [ ! -f "$case_dir/dist/go-no-go-report.md" ]; then
        echo "FAIL [$name]: expected dist/go-no-go-report.md to exist" >&2
        failures=$((failures + 1))
      else
        if grep -q "STALE" "$case_dir/dist/go-no-go-report.md"; then
          echo "FAIL [$name]: dist/go-no-go-report.md is the STALE report" >&2
          failures=$((failures + 1))
        fi
      fi
      ;;
    artefact_absent)
      if [ -f "$case_dir/dist/go-no-go-report.md" ]; then
        echo "FAIL [$name]: dist/go-no-go-report.md MUST NOT exist on a blocked deploy" >&2
        failures=$((failures + 1))
      fi
      ;;
  esac
}

assert() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL [$label]: expected=$expected actual=$actual" >&2
    failures=$((failures + 1))
  fi
}

# --- Case 1: Stage 1 strict gate fails — Task #151 -------------------------
# Wrapper must exit immediately with the Stage 1 banner and NEVER reach
# Stage 2. The fact that there is no STAGE 2 banner in the output proves
# the early-exit semantics held.
run_case "stage1_strict_fail" 3 0 no "(none)" 3 \
  "Stage 1 (pre-launch-safety --strict) failed" \
  "STAGE 2:" \
  artefact_absent

# --- Case 2: Stage 1 PASS, Stage 2 NO-GO with fresh report -----------------
# Stage 1 must run AND pass; Stage 2 then runs and fails with a fresh
# report. The wrapper surfaces the fresh report (not the stale one).
run_case "stage1_pass_stage2_no_go" 0 1 yes "NO-GO" 1 \
  "synthetic report from this run" \
  "STALE: from a previous run" \
  artefact_absent

# --- Case 3: Stage 1 PASS, Stage 2 crash before report ---------------------
run_case "stage1_pass_stage2_crash" 0 2 no "(none)" 2 \
  "No current-run report produced" \
  "STALE: from a previous run" \
  artefact_absent

# --- Case 4: Both stages green --------------------------------------------
run_case "stage1_pass_stage2_go" 0 0 yes "GO" 0 \
  "Pre-deploy gate + build complete" \
  "STALE: from a previous run" \
  artefact_present

if [ "$failures" -eq 0 ]; then
  echo "[smoke] all 4 cases passed"
  exit 0
else
  echo "[smoke] $failures assertion(s) failed" >&2
  exit 1
fi
