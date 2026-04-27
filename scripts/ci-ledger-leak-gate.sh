#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CI Ledger-Leak Gate wrapper (Task #197)
#
# Single PR-runner command that invokes scripts/ci-ledger-leak-gate.ts
# (Task #193) with the canonical --scripts list. Centralizing the list
# here means the GitHub workflow has one command to call, and the same
# command can be run locally in identical configuration:
#
#   bash scripts/ci-ledger-leak-gate.sh
#
# Excluded from the --scripts list:
#   - scripts/test-planner.ts:
#       Already gated by the dedicated `planner` job in
#       .github/workflows/planner.yml. It carries known compliance-
#       coverage assertion failures (Tasks #95 / #96 / #98) that
#       pre-date the leak gate but its body always completes cleanly
#       with NO ledger leak — conflating those failures with "leaked
#       ledger entries" would page the wrong owner. Re-include here
#       once #95/#96/#98 are fully adopted in the planner write paths.
#
# A failure exits non-zero with the gate's per-currency diff output
# pointing at the leaking script (see scripts/ci-ledger-leak-gate.ts
# for the diff format).
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPTS=(
  scripts/test-transaction-safety.ts
  scripts/test-fee-deduction-gate-b.ts
  scripts/test-wealth-planner-compliance.ts
  scripts/test-task-35-suppression.ts
  scripts/test-fee-insufficient-funds.ts
  scripts/test-no-synthetic-portfolio-data.ts
)

# Join the array with commas for the --scripts CSV arg.
IFS=,
SCRIPTS_CSV="${SCRIPTS[*]}"
unset IFS

exec npx tsx scripts/ci-ledger-leak-gate.ts --scripts "$SCRIPTS_CSV"
