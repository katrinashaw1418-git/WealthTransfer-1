// =============================================================================
// CLEAN-ROOM GATE EVALUATION (Task #200)
// =============================================================================
// Pure decision helpers used by the Stage 3 reconciliation clean-room gates
// in scripts/pre-launch-safety.ts AND by the Task #200 dedupe-suppression
// regression test in scripts/test-task-200-recon-gate.ts.
//
// Pure on purpose: no DB / network / process side-effects. The pre-launch
// gate calls the recon function, captures (newRowsCount, summary), then
// asks the helper for a verdict. The test does the same with a fixture
// scenario, so the test exercises the EXACT decision logic the live gate
// runs — no inlined copy that can drift out of sync.
//
// Why a separate file (not inline in pre-launch-safety.ts):
//   pre-launch-safety.ts unconditionally invokes `main()` at the bottom of
//   the module. Importing helpers from it would side-effect-trigger the
//   whole pre-launch run. Splitting out the pure helpers avoids that and
//   keeps the test cheap.
// =============================================================================

/**
 * Verdict shape for the recon-summary-driven gates (wallet-ledger,
 * ledger-vs-custodian). Matches the three branches each gate emits.
 */
export type CleanRoomReconGateVerdict =
  | { outcome: "pass" }
  | { outcome: "fail"; reason: "new_alert_rows" }
  | { outcome: "fail"; reason: "dedupe_suppressed_drift" };

/**
 * Inputs to evaluateReconCleanRoomGate. Counters are taken straight from
 * the recon summary so the helper has no implicit knowledge of which
 * recon function was run.
 */
export interface CleanRoomReconGateInputs {
  /**
   * Number of new operator_alerts rows with severity in ('alert','critical')
   * inserted since the gate's pre-run baselineMaxId.
   */
  newCriticalOrAlertRowCount: number;
  /** summary.alerts from the recon function (count of pairs classified 'alert'). */
  summaryAlerts: number;
  /** summary.criticals from the recon function (count of pairs classified 'critical'). */
  summaryCriticals: number;
}

/**
 * Decide pass/fail for the wallet-ledger and ledger-vs-custodian clean-room
 * gates.
 *
 * Decision table:
 *   - newRows = 0 AND alerts+criticals = 0  → pass (clean run)
 *   - newRows = 0 AND alerts+criticals > 0  → fail (notifyOperator dedupe
 *                                              masked a persistent drift)
 *   - newRows > 0 (any summary state)        → fail (fresh alert appeared
 *                                              since baseline)
 *
 * The dedupe-suppressed branch is the Task #200 fix: a critical drift that
 * re-fires inside the dedupe window will leave baselineMaxId untouched,
 * but the recon function itself still classifies the pair as alert/critical,
 * so we can detect it directly from the return value.
 */
export function evaluateReconCleanRoomGate(
  inputs: CleanRoomReconGateInputs,
): CleanRoomReconGateVerdict {
  const reconAlertCount = inputs.summaryAlerts + inputs.summaryCriticals;
  if (inputs.newCriticalOrAlertRowCount === 0 && reconAlertCount === 0) {
    return { outcome: "pass" };
  }
  if (inputs.newCriticalOrAlertRowCount === 0 && reconAlertCount > 0) {
    return { outcome: "fail", reason: "dedupe_suppressed_drift" };
  }
  return { outcome: "fail", reason: "new_alert_rows" };
}

/**
 * Verdict shape for the posting-receipt invariant gate. Same three
 * branches, parameterised over the invariant's "divergent" signal
 * (missingCount !== 0) instead of the recon summary counters.
 */
export type CleanRoomInvariantGateVerdict =
  | { outcome: "pass" }
  | { outcome: "fail"; reason: "new_alert_rows" }
  | { outcome: "fail"; reason: "dedupe_suppressed_divergence" };

export interface CleanRoomInvariantGateInputs {
  newCriticalOrAlertRowCount: number;
  /** True when the invariant check observed a missing or orphan receipt. */
  divergent: boolean;
}

/**
 * Decide pass/fail for the posting-receipt invariant clean-room gate.
 *
 * Same shape as evaluateReconCleanRoomGate but parameterised over a
 * boolean "divergent" rather than alert/critical counters: the invariant
 * function reports its own divergence directly via missingCount, and
 * notifyOperator's dedupe can mask repeat firings the same way it can for
 * the recon gates.
 */
export function evaluateInvariantCleanRoomGate(
  inputs: CleanRoomInvariantGateInputs,
): CleanRoomInvariantGateVerdict {
  if (inputs.newCriticalOrAlertRowCount === 0 && !inputs.divergent) {
    return { outcome: "pass" };
  }
  if (inputs.newCriticalOrAlertRowCount === 0 && inputs.divergent) {
    return { outcome: "fail", reason: "dedupe_suppressed_divergence" };
  }
  return { outcome: "fail", reason: "new_alert_rows" };
}
