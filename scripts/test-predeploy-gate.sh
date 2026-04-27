#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Smoke test for scripts/predeploy-build.sh exit semantics (Task #180).
#
# Pure-bash, no DB, no network. Stubs `npx` and `npm` on PATH so the
# wrapper exercises every branch without touching the live gate. Use
# this in CI to guard against regressions in the predeploy wrapper's
# block / pass / stale-report behaviour.
#
# Asserts:
#   1. NO-GO with a fresh report   → wrapper exits non-zero, prints the
#                                    NEW report (not the stale one),
#                                    does NOT produce dist/.
#   2. Crash before report         → wrapper exits non-zero, explicitly
#                                    refuses to print the stale report,
#                                    does NOT produce dist/.
#   3. GO with a fresh report      → wrapper exits 0, runs npm run build,
#                                    attaches the NEW report (not the
#                                    stale one) to dist/go-no-go-report.md.
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

run_case() {
  local name="$1" gate_status="$2" produce_report="$3" verdict_label="$4"
  local case_dir="$WORK/$name"
  local report_dir="$case_dir/docs/golive"
  local stale_report="$report_dir/go-no-go-STALE-PREVIOUS-RUN.md"
  local bindir="$case_dir/bin"

  mkdir -p "$report_dir" "$bindir"
  echo "STALE: from a previous run, MUST NOT be surfaced as current" \
    > "$stale_report"

  cat > "$bindir/npx" << EOF
#!/usr/bin/env bash
if [ "$produce_report" = "yes" ]; then
  sleep 0.05
  cat > "$report_dir/go-no-go-CURRENT-RUN.md" << 'REPORT'
# Pre-launch GO/NO-GO report
**Verdict:** $verdict_label
* synthetic report from this run
REPORT
fi
exit $gate_status
EOF
  chmod +x "$bindir/npx"

  cat > "$bindir/npm" << EOF
#!/usr/bin/env bash
mkdir -p "$case_dir/dist"
echo "fake build output" > "$case_dir/dist/index.js"
exit 0
EOF
  chmod +x "$bindir/npm"

  # Symlink the wrapper into the case dir so it resolves $REPORT_DIR
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

  assert "$name: exit code" "$5" "$exit_code"
  if [ -n "${6:-}" ]; then
    if echo "$out" | grep -qF -- "$6"; then
      :
    else
      echo "FAIL [$name]: expected stdout to contain: $6" >&2
      failures=$((failures + 1))
    fi
  fi
  if [ -n "${7:-}" ]; then
    if echo "$out" | grep -qF -- "$7"; then
      echo "FAIL [$name]: stdout MUST NOT contain: $7" >&2
      failures=$((failures + 1))
    fi
  fi
  # Dist artefact assertion
  case "$8" in
    artefact_present)
      if [ ! -f "$case_dir/dist/go-no-go-report.md" ]; then
        echo "FAIL [$name]: expected dist/go-no-go-report.md to exist" >&2
        failures=$((failures + 1))
      else
        # Confirm it's the CURRENT run report, not the stale one
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

# Case 1: NO-GO with fresh report
run_case "no_go_with_report" 1 yes "NO-GO" 1 \
  "synthetic report from this run" \
  "STALE: from a previous run" \
  artefact_absent

# Case 2: orchestrator crash before any report write
run_case "crash_no_report" 2 no "(none)" 2 \
  "No current-run report produced" \
  "STALE: from a previous run" \
  artefact_absent

# Case 3: GO with fresh report
run_case "go_with_report" 0 yes "GO" 0 \
  "Pre-deploy gate + build complete" \
  "STALE: from a previous run" \
  artefact_present

if [ "$failures" -eq 0 ]; then
  echo "[smoke] all 3 cases passed"
  exit 0
else
  echo "[smoke] $failures assertion(s) failed" >&2
  exit 1
fi
