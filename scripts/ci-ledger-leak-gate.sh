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
  # Task #378 — pure unit tests for the rebalancing-benchmark resolver
  # functions (resolveBenchmarkForRiskTolerance,
  # resolveBenchmarkForRiskProfileRow, computeRebalancingGap). The script
  # makes no DB writes so the surrounding leak-gate snapshot trivially
  # records zero drift; wiring it here keeps the rebalancing-gap math
  # gated at PR time alongside the other static safety scripts.
  scripts/test-rebalancing-benchmark.ts
  # Task #406 — end-to-end regression for /api/portfolio/allocation that
  # seeds two clients with distinct risk_profiles rows and a third with
  # none, then asserts each client gets the right per-user `benchmark.targets`
  # payload from the route handler (not just the resolver in isolation,
  # which the script above already covers). The script seeds + cleans up
  # its own `__alloc406_<run>__` users, fact_find_snapshots, and
  # risk_profiles rows on every run via try/finally — no platform-user
  # writes, no ledger entries, so the surrounding leak-gate snapshot
  # records zero drift.
  scripts/test-portfolio-allocation-per-client.ts
  # Task #216 — newer safety tests, audited and added to the gate so any
  # future regression into the same try/finally-cleanup leak pattern
  # fixed by Tasks #158 and #187 is caught at PR time.
  #   - test-platform-leg-gate.ts:
  #       posts a platform-suspense leg under a `__pgate209_contam`
  #       transaction; cleanup drops both legs by transactionId in
  #       try/finally so the platform user's per-currency snapshot
  #       returns to baseline.
  #   - test-prelaunch-fixture-contract.ts:
  #       only seeds rows on its own per-run `__pftest213*_*` fixture
  #       users (no platform-user writes); each case has try/finally
  #       cleanup plus a final global sweep bounded by RUN_SUFFIX.
  #   - test-task-200-recon-gate.ts:
  #       only seeds rows on `__task200_recon_gate_test__` (no
  #       platform-user writes); end-of-main cleanup wipes the seeded
  #       wallet/ledger/recon/operator_alerts rows.
  scripts/test-platform-leg-gate.ts
  scripts/test-prelaunch-fixture-contract.ts
  scripts/test-task-200-recon-gate.ts
)

# Join the array with commas for the --scripts CSV arg.
IFS=,
SCRIPTS_CSV="${SCRIPTS[*]}"
unset IFS

exec npx tsx scripts/ci-ledger-leak-gate.ts --scripts "$SCRIPTS_CSV"
