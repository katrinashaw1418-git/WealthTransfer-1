// =============================================================================
// CANONICAL ORDER OF PRE-LAUNCH SAFETY GATES (Task #215)
// =============================================================================
// The canonical PASS/FAIL/SKIP gate names emitted by `scripts/pre-launch-
// safety.ts`'s reporter, in the order they are reported. Lives in its own
// tiny module — with no `server/db`, `server/routes`, or other heavy
// imports — so the post-merge drift check
// (`scripts/test-recheck-gate-count.ts`) can compare it against
// `EXPECTED_PASS_COUNT` / `EXPECTED_CANONICAL_GATE_NAMES` in
// `scripts/post-merge-safety-recheck.ts` without dragging in a Postgres
// pool or Express handlers just to read a string array.
//
// Why a self-policing constant matters (Task #215 history):
//   The post-merge recheck's hand-maintained `EXPECTED_PASS_COUNT`
//   silently drifted behind this list at least three times — Task #188
//   (idempotency-under-concurrency expansion), Task #193 (CI ledger-leak
//   gate roll-ups), and Tasks #202 + #210 (per-Stage-2 platform-leg
//   invariant + end-of-Stage-2 fixture-user contract). Each time, the
//   first clean run after the merge reported RED with a bogus
//   "expected=N" footnote. The Task #215 drift gate now imports BOTH
//   this list and the recheck's expected constants, asserting in both
//   directions, so a future task that forgets to bump the recheck's
//   expected fails CI here BEFORE it can mask a real verdict in
//   production.
//
// Rule for editing this list:
//   - Adding, removing, or renaming a gate here REQUIRES a matching edit
//     to `EXPECTED_PASS_COUNT` and `EXPECTED_CANONICAL_GATE_NAMES` in
//     `scripts/post-merge-safety-recheck.ts`. The drift gate
//     (`scripts/test-recheck-gate-count.ts`) will FAIL otherwise with
//     an actionable diff naming the missing/extra gates.
// =============================================================================

export const CANONICAL_ORDER: readonly string[] = [
  "existing: test-transaction-safety",
  // Task #193 — per-script ledger-leak gates. Each existing-script run is
  // wrapped in a snapshot of the platform user's per-currency ledger SUM
  // + COUNT before and after. A non-zero delta means the script regressed
  // back to the leak pattern fixed by tasks #158 and #187 (e.g. forgot to
  // wrap the test body in try/finally + cleanup at end-of-script).
  "ledger-leak: test-transaction-safety",
  "existing: test-fee-deduction-gate-b",
  "ledger-leak: test-fee-deduction-gate-b",
  "existing: test-wealth-planner-compliance",
  "ledger-leak: test-wealth-planner-compliance",
  "existing: test-task-35-suppression",
  "ledger-leak: test-task-35-suppression",
  "lifecycle: happy-path wallet matches ledger",
  // Task #202 — platform-leg invariant. Runs IMMEDIATELY after each
  // Stage 2 lifecycle scenario so a regression that contaminates the
  // platform user (PLATFORM_USER_ID) is localized to the exact scenario
  // that introduced it, instead of being unmasked much later in Stage 3
  // reconciliation. Each gate snapshots the platform user's per-currency
  // signed ledger sum BEFORE the scenario, runs the scenario, scrubs
  // the fixture user's transactions (which cascades to delete the
  // scenario's platform-side legs by tx_id), then asserts the AFTER sum
  // equals the BEFORE sum (within an explicit epsilon) for every
  // currency the scenario touched. A non-zero delta means the scenario
  // posted platform-user ledger entries via a transaction NOT owned by
  // the fixture user (or via a single-leg posting), which is the exact
  // regression pattern this gate catches.
  "platform-leg: lifecycle 1 (happy path)",
  "lifecycle: idempotency under concurrency",
  "platform-leg: lifecycle 2 (idempotency: deposit)",
  // Task #185 — same idempotency-under-concurrency invariant for the
  // OTHER money-movement routes. The deposit handler proved the pattern;
  // these gates prove the catch-block fix has been applied symmetrically.
  "lifecycle: idempotency under concurrency (withdraw)",
  "platform-leg: lifecycle 2b (idempotency: withdraw)",
  "lifecycle: idempotency under concurrency (fx-exchange)",
  "platform-leg: lifecycle 2c (idempotency: fx-exchange)",
  "lifecycle: idempotency under concurrency (wallets/transfer)",
  "platform-leg: lifecycle 2d (idempotency: wallets/transfer)",
  "lifecycle: idempotency under concurrency (investments)",
  "platform-leg: lifecycle 2e (idempotency: investments)",
  "lifecycle: reversal symmetry",
  "platform-leg: lifecycle 3 (reversal symmetry)",
  // Task #210 — end-of-Stage-2 contract gate. After every lifecycle
  // scenario has run AND scrubbed its own fixture user (Task #202's
  // per-scenario `runScenarioWithPlatformLegAssert` wrapper), assert
  // that EVERY `__prelaunch_%` fixture user owns zero transactions.
  // This locks in the self-clean contract: a future scenario added
  // outside the wrapper (or with a mismatched fixture username) will
  // FAIL this gate loudly with a per-user residue count, instead of
  // its leftover ledger entries silently leaking into Stage 3
  // reconciliation as a misleading critical wallet-vs-ledger alert.
  "lifecycle: end-of-Stage-2 fixture-user contract",
  "reconciliation: wallet-ledger clean-room",
  "reconciliation: ledger-vs-custodian clean-room",
  "reconciliation: posting-receipt invariant clean-room",
  // Task #193 — same self-policing leak gate, but for the test scripts
  // pre-launch does NOT run in Stage 1 (test-fee-insufficient-funds,
  // test-no-synthetic-portfolio-data, test-planner). Runs as a single
  // subprocess via scripts/ci-ledger-leak-gate.ts so the same harness
  // covers EVERY scripts/test-*.ts in pre-launch — without re-running
  // the four heavy Stage 1 scripts a second time.
  "ledger-leak: ci-gate (other test-*.ts)",
] as const;
