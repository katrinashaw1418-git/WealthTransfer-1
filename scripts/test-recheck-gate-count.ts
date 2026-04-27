// =============================================================================
// POST-MERGE GATE-COUNT DRIFT GATE — REGRESSION TEST (Task #215)
// =============================================================================
// Self-policing assertion that the post-merge recheck's hand-maintained
// `EXPECTED_PASS_COUNT` and `EXPECTED_CANONICAL_GATE_NAMES` constants
// (scripts/post-merge-safety-recheck.ts) stay in lockstep with the live
// canonical roll-up gate list (`CANONICAL_ORDER` in
// scripts/lib/pre-launch-canonical-order.ts, which is the same array
// scripts/pre-launch-safety.ts drives its reporter from).
//
// Why this exists:
//   The recheck constant has silently drifted behind the canonical
//   list at least three times — Task #188, Task #193, Tasks #202+#210
//   — and each time the first clean strict run after the merge reported
//   RED with a bogus "expected=N" footnote that masked any real
//   regression for as long as it took an operator to notice. Task #214
//   patched the immediate symptom (bumped the constant from 19 to 27);
//   this gate fixes the root cause by failing CI BEFORE the merge that
//   would have introduced the drift.
//
// What this script asserts:
//   1. `EXPECTED_PASS_COUNT === CANONICAL_ORDER.length`.
//      A mismatch usually means a new gate was added to
//      `scripts/lib/pre-launch-canonical-order.ts` without bumping
//      `EXPECTED_PASS_COUNT` in `scripts/post-merge-safety-recheck.ts`
//      (or vice versa).
//
//   2. `EXPECTED_CANONICAL_GATE_NAMES` is set-equal to the gate names
//      in `CANONICAL_ORDER` (no missing entries, no extras, no typos).
//      A diff here means a gate was added/removed/renamed on one side
//      without the matching edit on the other.
//
//   3. `CANONICAL_ORDER` itself contains no duplicate names. The
//      reporter in pre-launch-safety.ts iterates the array once and
//      looks each name up in a Map — a duplicate would silently
//      collapse one PASS line and corrupt the summary, exactly the
//      class of bug this gate is supposed to catch.
//
//   4. Every name in `CANONICAL_ORDER` matches one of the
//      `CANONICAL_GATE_NAME_PREFIXES` the recheck's parser uses to
//      identify roll-up lines. A new prefix that ships in
//      pre-launch-safety.ts without being added to the recheck would
//      cause those PASS lines to be silently filtered out, dropping
//      the live pass count below the expected number even though the
//      gates themselves passed.
//
// On failure: prints an actionable diff naming the offending gates AND
// the constant the operator must edit (with a file path), then exits 1.
// On success: prints a one-line summary of the locked-in gate count and
// exits 0.
//
// Wiring: this script is listed in `CI_LEAK_GATE_OTHER_SCRIPTS` in
// scripts/pre-launch-safety.ts, so it runs as part of the
// `ledger-leak: ci-gate (other test-*.ts)` Stage-1 roll-up gate. That
// means a drift introduced on a feature branch FAILS the existing
// pre-launch / pre-merge surface (the same surface the recheck
// itself relies on) before the bad merge can land on main. The script
// performs no DB writes, so the surrounding leak gate trivially
// records zero drift for it.
//
// Usage:
//   npx tsx scripts/test-recheck-gate-count.ts
//
// Exit code:
//   - 0 if all four invariants above hold.
//   - 1 on any mismatch, with a per-failure diff explaining what to fix.
// =============================================================================

import { CANONICAL_ORDER } from "./lib/pre-launch-canonical-order";
import {
  CANONICAL_GATE_NAME_PREFIXES,
  EXPECTED_CANONICAL_GATE_NAMES,
  EXPECTED_PASS_COUNT,
} from "./post-merge-safety-recheck";

const SOURCE_OF_TRUTH = "scripts/lib/pre-launch-canonical-order.ts";
const RECHECK_FILE = "scripts/post-merge-safety-recheck.ts";

function bullet(items: readonly string[]): string {
  return items.map((it) => `    - ${it}`).join("\n");
}

let failed = false;
function fail(header: string, body: string): void {
  failed = true;
  console.error(`FAIL ${header}`);
  console.error(body);
  console.error("");
}

// -----------------------------------------------------------------------------
// 1. CANONICAL_ORDER must contain no duplicates.
// -----------------------------------------------------------------------------
{
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const name of CANONICAL_ORDER) {
    const prev = seen.get(name) ?? 0;
    if (prev === 1) duplicates.push(name);
    seen.set(name, prev + 1);
  }
  if (duplicates.length > 0) {
    fail(
      "duplicate gate name(s) in CANONICAL_ORDER",
      `  Each gate name must be unique. Remove duplicates from\n` +
        `  ${SOURCE_OF_TRUTH}:\n` +
        bullet(duplicates),
    );
  }
}

// -----------------------------------------------------------------------------
// 2. EXPECTED_PASS_COUNT must equal CANONICAL_ORDER.length.
// -----------------------------------------------------------------------------
if (EXPECTED_PASS_COUNT !== CANONICAL_ORDER.length) {
  const diff = CANONICAL_ORDER.length - EXPECTED_PASS_COUNT;
  const direction = diff > 0 ? "added" : "removed";
  fail(
    `EXPECTED_PASS_COUNT (${EXPECTED_PASS_COUNT}) does not match ` +
      `CANONICAL_ORDER.length (${CANONICAL_ORDER.length})`,
    `  ${Math.abs(diff)} gate(s) were ${direction} in\n` +
      `  ${SOURCE_OF_TRUTH} without bumping EXPECTED_PASS_COUNT in\n` +
      `  ${RECHECK_FILE}.\n` +
      `  Action: set EXPECTED_PASS_COUNT to ${CANONICAL_ORDER.length} ` +
      `in ${RECHECK_FILE}, and add a comment recording which task ` +
      `introduced the change (matching the existing edit history above ` +
      `the constant).`,
  );
}

// -----------------------------------------------------------------------------
// 3. EXPECTED_CANONICAL_GATE_NAMES must be set-equal to CANONICAL_ORDER.
// -----------------------------------------------------------------------------
{
  const canonicalSet = new Set<string>(CANONICAL_ORDER);
  const missingFromExpected: string[] = [];
  const extraInExpected: string[] = [];

  for (const name of canonicalSet) {
    if (!EXPECTED_CANONICAL_GATE_NAMES.has(name)) {
      missingFromExpected.push(name);
    }
  }
  for (const name of EXPECTED_CANONICAL_GATE_NAMES) {
    if (!canonicalSet.has(name)) {
      extraInExpected.push(name);
    }
  }

  if (missingFromExpected.length > 0) {
    fail(
      `EXPECTED_CANONICAL_GATE_NAMES is missing ` +
        `${missingFromExpected.length} gate name(s) present in CANONICAL_ORDER`,
      `  These gates are emitted by pre-launch-safety.ts but are NOT in\n` +
        `  EXPECTED_CANONICAL_GATE_NAMES — the recheck would silently\n` +
        `  drop them from its parsed gate count and report RED.\n` +
        `  Action: add the names below to EXPECTED_CANONICAL_GATE_NAMES\n` +
        `  in ${RECHECK_FILE}:\n` +
        bullet(missingFromExpected),
    );
  }
  if (extraInExpected.length > 0) {
    fail(
      `EXPECTED_CANONICAL_GATE_NAMES has ` +
        `${extraInExpected.length} gate name(s) NOT in CANONICAL_ORDER`,
      `  These names are in EXPECTED_CANONICAL_GATE_NAMES but are NOT\n` +
        `  emitted by pre-launch-safety.ts — the recheck would expect a\n` +
        `  PASS line that never appears, and report RED.\n` +
        `  Action: either remove the names below from\n` +
        `  EXPECTED_CANONICAL_GATE_NAMES in ${RECHECK_FILE}, OR add them\n` +
        `  back to CANONICAL_ORDER in ${SOURCE_OF_TRUTH} if the gate was\n` +
        `  removed by mistake:\n` +
        bullet(extraInExpected),
    );
  }
}

// -----------------------------------------------------------------------------
// 4. Every CANONICAL_ORDER name must match a CANONICAL_GATE_NAME_PREFIXES
//    prefix the recheck parser uses.
// -----------------------------------------------------------------------------
{
  const prefixViolations: string[] = [];
  for (const name of CANONICAL_ORDER) {
    const matched = CANONICAL_GATE_NAME_PREFIXES.some((p) => name.startsWith(p));
    if (!matched) prefixViolations.push(name);
  }
  if (prefixViolations.length > 0) {
    fail(
      `${prefixViolations.length} gate name(s) in CANONICAL_ORDER use a ` +
        `prefix the recheck parser does not recognize`,
      `  The recheck restricts canonical gate parsing to names starting\n` +
        `  with one of: ${CANONICAL_GATE_NAME_PREFIXES.map((p) => `"${p}"`).join(", ")}.\n` +
        `  These gate names match no recognized prefix, so the recheck\n` +
        `  would silently filter their PASS lines out and report RED.\n` +
        `  Action: either rename the gate(s) below in ${SOURCE_OF_TRUTH}\n` +
        `  to use an existing prefix, OR add a new prefix to\n` +
        `  CANONICAL_GATE_NAME_PREFIXES in ${RECHECK_FILE}:\n` +
        bullet(prefixViolations),
    );
  }
}

// -----------------------------------------------------------------------------
// Verdict.
// -----------------------------------------------------------------------------
if (failed) {
  console.error(
    `recheck gate-count drift gate FAILED — see above for the actionable ` +
      `diff(s). Fix the constants in ${RECHECK_FILE} and/or ` +
      `${SOURCE_OF_TRUTH} so the two sides agree, then re-run.`,
  );
  process.exit(1);
}

console.log(
  `PASS recheck gate-count drift gate — ${CANONICAL_ORDER.length} canonical ` +
    `gate(s) locked in (EXPECTED_PASS_COUNT=${EXPECTED_PASS_COUNT}, ` +
    `EXPECTED_CANONICAL_GATE_NAMES.size=${EXPECTED_CANONICAL_GATE_NAMES.size}).`,
);
process.exit(0);
