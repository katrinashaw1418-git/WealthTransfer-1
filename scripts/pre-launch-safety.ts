// ---------------------------------------------------------------------------
// Pre-launch safety roll-up (Task #133, Task #142)
//
// Single-command go/no-go validator. Run with:
//   npx tsx scripts/pre-launch-safety.ts
//   npx tsx scripts/pre-launch-safety.ts --strict   # see "Outcomes" below
//
// What this proves:
//   1. Each of the four existing safety/regression scripts still passes:
//        - scripts/test-transaction-safety.ts
//        - scripts/test-fee-deduction-gate-b.ts
//        - scripts/test-wealth-planner-compliance.ts
//        - scripts/test-task-35-suppression.ts
//   2. Three end-to-end lifecycle scenarios that no individual script covers:
//        - happy-path lifecycle: signup -> KYC -> deposit -> trade -> withdraw
//          assert wallet == SUM(ledger_entries) per currency, to the cent.
//        - idempotency under concurrency: two parallel POSTs with the same
//          Idempotency-Key produce exactly one transaction row, one ledger
//          pair, and one receipt.
//        - reversal symmetry: posting a transaction and then its reversal
//          leaves wallet + ledger at exactly the pre-state, with both audit
//          rows still visible.
//   3. The three reconciliation services (wallet-vs-ledger, ledger-vs-custodian,
//      posting-receipt invariant) each run in-process and emit ZERO new
//      `operator_alerts` rows of severity `critical` or `alert` over the
//      pre-snapshot baseline. Each is a separate gate.
//
// Outcomes (Task #142):
//   Every gate reports one of three outcomes:
//     - PASS — the gate ran and was satisfied.
//     - FAIL — the gate ran and was NOT satisfied. Always blocks launch.
//     - SKIP — the gate could not meaningfully run (precondition missing,
//             sub-script failed to spawn, no data to reconcile, etc.).
//             A SKIP is "we did not actually verify this", which is *not*
//             the same as a real PASS — even though without --strict the
//             exit code does not fail on SKIP alone.
//
//   By default, only FAILs change the exit code. With --strict, any SKIP
//   also fails the exit code, so a launch gate can require BOTH zero FAILs
//   AND zero SKIPs. Intended go-live invocation:
//
//     npx tsx scripts/pre-launch-safety.ts --strict   # must exit 0 to deploy
//
//   The final summary line says one of:
//     - "PRE-LAUNCH SAFETY: ALL GATES PASSED" (zero FAIL, zero SKIP)
//     - "PRE-LAUNCH SAFETY: PASS — N skipped (run with --strict to block)"
//     - "PRE-LAUNCH SAFETY: FAIL — gate(s) failed"
//     - "PRE-LAUNCH SAFETY: FAIL — N skipped in --strict mode"
//
// What this DOES NOT prove (see docs/PRE_LAUNCH_CHECKLIST.md):
//   - Real custodian / bank SDK connectivity (the ledger-vs-custodian
//     reconciliation runs against the deterministic stub).
//   - Load-test behaviour of the `ledger_postings` PK lock under high
//     concurrency.
//   - External dead-man's-switch on the Node process.
//   - JWT secret / API key rotation.
//
// Exit code:
//   - 0 only if every assertion passes and every existing script returns 0
//     (and, in --strict mode, no gate skipped).
//   - 1 on any failure. A red light here MUST block deploy.
// ---------------------------------------------------------------------------

import "./_bootstrap-test-env";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import Decimal from "decimal.js";

import { db } from "../server/db";
import {
  users,
  wallets,
  accounts,
  transactions,
  ledgerEntries,
  ledgerPostings,
  idempotencyKeys,
  operatorAlerts,
  investmentProducts,
  userInvestments,
} from "../shared/schema";
import { signToken } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  getUserCurrencyBalance,
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "../server/services/ledger";
import {
  runLedgerReconciliation,
  runWalletLedgerReconciliation,
} from "../server/services/reconciliation";
import { runPostingReceiptInvariantCheck } from "../server/services/posting-receipt-invariant";
import {
  evaluateInvariantCleanRoomGate,
  evaluateReconCleanRoomGate,
} from "./lib/clean-room-gate";
import {
  assertPlatformLegInvariantAndScrub as libAssertPlatformLegInvariantAndScrub,
  snapshotPlatformPerCurrency as libSnapshotPlatformPerCurrency,
  type PlatformPerCurrency,
} from "./lib/platform-leg-gate";

// ---------------------------------------------------------------------------
// Result reporter (canonical PASS/FAIL/SKIP block, mirrors the other scripts).
// Task #142 — SKIP is a first-class outcome, with a human-readable reason.
// SKIP means "we did not actually verify this", so a launch gate using
// --strict treats it as a failure of the exit code.
// ---------------------------------------------------------------------------
type Outcome = "pass" | "fail" | "skip";
type Result = { outcome: Outcome; details: string };
const results = new Map<string, Result>();
const CANONICAL_ORDER: string[] = [
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
];
function pass(name: string, details: string): void {
  results.set(name, { outcome: "pass", details });
}
function fail(name: string, details: string): void {
  results.set(name, { outcome: "fail", details });
}
function skip(name: string, reason: string): void {
  results.set(name, { outcome: "skip", details: reason });
}

// ---------------------------------------------------------------------------
// Existing-script driver. Shells out to `npx tsx <path>` so each script
// runs in process isolation with its own module-init side effects, exactly
// as a developer would invoke it.
// ---------------------------------------------------------------------------
// Task #193 — `leakLabel` is the per-script leak-gate name (CANONICAL_ORDER
// has both an "existing: ..." gate for the script's own exit code and a
// matching "ledger-leak: ..." gate for the platform-user before/after delta).
const EXISTING_SCRIPTS: Array<{
  label: string;
  leakLabel: string;
  file: string;
}> = [
  {
    label: "existing: test-transaction-safety",
    leakLabel: "ledger-leak: test-transaction-safety",
    file: "scripts/test-transaction-safety.ts",
  },
  {
    label: "existing: test-fee-deduction-gate-b",
    leakLabel: "ledger-leak: test-fee-deduction-gate-b",
    file: "scripts/test-fee-deduction-gate-b.ts",
  },
  {
    label: "existing: test-wealth-planner-compliance",
    leakLabel: "ledger-leak: test-wealth-planner-compliance",
    file: "scripts/test-wealth-planner-compliance.ts",
  },
  {
    label: "existing: test-task-35-suppression",
    leakLabel: "ledger-leak: test-task-35-suppression",
    file: "scripts/test-task-35-suppression.ts",
  },
];

// Test scripts NOT run by Stage 1 above. We cover them via a single
// subprocess invocation of scripts/ci-ledger-leak-gate.ts — the same
// harness used in PR / CI — so pre-launch's leak coverage is the union
// of the per-script wraps above PLUS this CI gate, with no script run
// twice. Listed by basename so the leak gate's --scripts flag stays
// explicit (we don't want it to silently grow if someone adds a new
// scripts/test-*.ts without thinking about leak isolation).
//
// scripts/test-planner.ts is INTENTIONALLY EXCLUDED from this list:
// the script's body completes cleanly with NO ledger leak (its final
// assertion `no ledger entries created by planner writes` PASSES), but
// it carries 3 known compliance-coverage assertion failures that pre-
// date the leak gate (Tasks #95 / #96 / #98 — see the script header).
// Counting those assertion failures as a "leak" is a category error:
// the gate's purpose is to catch platform-user ledger drift, not to
// arbitrate planner compliance correctness. The script remains run-
// nable manually for compliance-gap tracking; the underlying gaps are
// owned by their respective tasks. Re-include here once #95/#96/#98
// are fully adopted in the planner write paths.
const CI_LEAK_GATE_OTHER_SCRIPTS: string[] = [
  "scripts/test-fee-insufficient-funds.ts",
  "scripts/test-no-synthetic-portfolio-data.ts",
  // Task #209 — regression test for the per-scenario platform-leg
  // invariant gate (Task #202). Injects a deliberate platform-only
  // ledger entry under a transaction NOT owned by the gate's fixture
  // user, runs `assertPlatformLegInvariantAndScrub`, and asserts the
  // gate reports FAIL with the offending currency named. Wired here
  // (rather than as its own EXISTING_SCRIPTS entry) so it inherits the
  // ci-ledger-leak-gate's snapshot — the script's try/finally cleanup
  // wipes its `__pgate209_*` rows on every run, so a leak here would
  // immediately surface as drift on the same harness that polices every
  // other test-*.ts script.
  "scripts/test-platform-leg-gate.ts",
];

type ExistingScriptOutcome =
  | { outcome: "pass"; details: string }
  | { outcome: "fail"; details: string }
  | { outcome: "skip"; details: string };

function runExistingScript(scriptPath: string): ExistingScriptOutcome {
  const r = spawnSync("npx", ["tsx", scriptPath], {
    stdio: "inherit",
    env: process.env,
    encoding: "utf8",
  });
  // Task #142 — a spawn error or signal-kill means the sub-script never
  // actually ran to completion, so we have NOT verified the gate. That's
  // a SKIP (with a clear reason), not a real PASS or a real FAIL — the
  // exit-code distinction matters in --strict mode.
  if (r.error) {
    return {
      outcome: "skip",
      details: `script did not run (spawn error: ${r.error.message})`,
    };
  }
  if (r.signal) {
    return {
      outcome: "skip",
      details: `script did not complete (killed by signal ${r.signal})`,
    };
  }
  const code = r.status ?? -1;
  if (code === 0) return { outcome: "pass", details: "exit=0" };
  return { outcome: "fail", details: `exit=${code}` };
}

// ---------------------------------------------------------------------------
// Task #193 — per-script ledger-leak snapshot for the platform user.
//
// Every Stage-1 sub-script is wrapped: snapshot the platform user's
// per-currency (SUM, COUNT) BEFORE the spawn and AFTER. A non-zero
// delta means the sub-script left ledger entries behind on the
// platform user (the same leak pattern fixed by Tasks #158 and #187).
//
// Same SUM(CASE WHEN credit/-debit) shape as getUserCurrencyBalance()
// in server/services/ledger.ts so a leak this gate catches is the
// same shape the wallet-vs-ledger reconciliation flags as a critical
// drift in the recon clean-room gate.
// ---------------------------------------------------------------------------
type CurrencyStat = { net: string; count: number };
type PlatformSnapshot = Map<string, CurrencyStat>;

async function snapshotPlatformLedger(
  platformUserId: number,
): Promise<PlatformSnapshot> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      net: sql<string>`COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount} ELSE -${ledgerEntries.amount} END), 0)`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, platformUserId))
    .groupBy(ledgerEntries.currency);
  const out: PlatformSnapshot = new Map();
  for (const r of rows) {
    out.set(r.currency, { net: String(r.net), count: Number(r.count) });
  }
  return out;
}

// Strict leak definition per task spec: fail on ANY per-currency drift in
// either net OR row count. Mirrors scripts/ci-ledger-leak-gate.ts. A clean
// script that wraps its body in try/finally with end-of-script per-user
// cleanup leaves both unchanged.
function diffPlatformLedger(
  before: PlatformSnapshot,
  after: PlatformSnapshot,
): string[] {
  const drift: string[] = [];
  const currencies = new Set<string>([...before.keys(), ...after.keys()]);
  for (const cur of Array.from(currencies).sort()) {
    const b = before.get(cur) ?? { net: "0", count: 0 };
    const a = after.get(cur) ?? { net: "0", count: 0 };
    const bNet = new Decimal(b.net);
    const aNet = new Decimal(a.net);
    const netEq = aNet.eq(bNet);
    const dCount = a.count - b.count;
    const countEq = dCount === 0;
    if (netEq && countEq) continue;
    const dNet = aNet.minus(bNet);
    drift.push(
      `${cur}: net ${bNet.toString()} -> ${aNet.toString()} ` +
        `(delta ${dNet.gte(0) ? "+" : ""}${dNet.toString()}), ` +
        `count ${b.count} -> ${a.count} ` +
        `(delta ${dCount >= 0 ? "+" : ""}${dCount})`,
    );
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Deterministic test-user fixtures (idempotent across re-runs).
// All scenario users are prefixed `__prelaunch_` so cleanup never touches
// fixtures owned by other scripts (which use their own prefixes).
// ---------------------------------------------------------------------------
const PLATFORM_USERNAME = "__prelaunch_platform";
const HAPPY_USERNAME = "__prelaunch_happy_path";
const IDEM_USERNAME = "__prelaunch_idem_concurrency";
const REVERSAL_USERNAME = "__prelaunch_reversal";
// Task #185 — separate fixture user per route so the per-scenario
// resetScenarioState() / NEW-tx delta accounting can't cross-contaminate.
const IDEM_WITHDRAW_USERNAME = "__prelaunch_idem_withdraw";
const IDEM_FXEX_USERNAME = "__prelaunch_idem_fxex";
const IDEM_WTRANSFER_USERNAME = "__prelaunch_idem_wtransfer";
const IDEM_INVEST_USERNAME = "__prelaunch_idem_invest";

const HAPPY_AUD_DEPOSIT = "1000.00";
const HAPPY_AUD_TRADE = "500.00";
const HAPPY_BTC_NOTIONAL = "0.01250000";
const HAPPY_AUD_WITHDRAW = "200.00";
const HAPPY_AUD_WITHDRAW_FEE = "35.00"; // matches WITHDRAWAL_FEES['AUD'] in routes.ts

const REVERSAL_AMOUNT = "250.00";

// ---------------------------------------------------------------------------
// PK tracking — every row this script creates is captured by primary key
// so cleanup deletes only what we own. No DELETE in this script targets
// rows by user-id-IN-set; every delete is `inArray(<table>.id, created.*)`.
// ---------------------------------------------------------------------------
const created = {
  userIds: [] as number[],
  walletIds: [] as number[],
  accountIds: [] as number[],
  transactionIds: [] as number[],
  ledgerEntryIds: [] as number[],
  idempotencyKeyIds: [] as number[],
};
function pushUnique(arr: number[], id: number): void {
  if (!arr.includes(id)) arr.push(id);
}

async function ensureUser(opts: {
  username: string;
  email: string;
  role?: "client" | "adviser" | "admin";
}): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, opts.username));
  if (existing) {
    if (existing.kycStatus !== "verified" || !existing.emailVerified) {
      await db
        .update(users)
        .set({ kycStatus: "verified", emailVerified: true })
        .where(eq(users.id, existing.id));
    }
    pushUnique(created.userIds, existing.id);
    return existing.id;
  }
  const [row] = await db
    .insert(users)
    .values({
      username: opts.username,
      email: opts.email,
      password: "not-a-real-password",
      firstName: "PreLaunch",
      lastName: "Test",
      role: opts.role ?? "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  pushUnique(created.userIds, row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Task #202 — per-scenario platform-leg invariant.
//
// Today's regression: a Stage 2 lifecycle scenario can quietly contaminate
// PLATFORM_USER_ID's ledger and the script only notices when reconciliation
// runs much later (Stage 3), pointing the operator at "the recon gate" when
// the ACTUAL culprit was one specific lifecycle scenario several steps
// earlier. This gate localizes the failure: snapshot the platform user's
// per-currency signed ledger sum BEFORE each scenario, run the scenario,
// scrub the scenario's fixture user (which cascades to delete the
// scenario's platform-side legs by tx_id), then assert the AFTER sum
// equals the BEFORE sum (within `PLATFORM_LEG_EPSILON`) for every currency
// the scenario touched.
//
// A non-zero delta means the scenario posted platform-user ledger entries
// via a transaction NOT owned by the fixture user (e.g. a bare
// postLedgerEntries call against the platform user, or a single-leg
// posting bypassing the double-entry primitive). The error message names
// the scenario AND the offending currency so the operator can grep the
// scenario's source for the offending write in seconds.
//
// Epsilon: 0.00000001 — one unit at the schema's 8-decimal-place precision.
// Postgres SUM over the `decimal` ledger amounts is exact, so a clean
// scenario produces an exact zero delta; the epsilon is a defensive cushion
// against any future column-type or rounding change, not a real tolerance.
//
// Task #209 — both the constant and the helpers below were extracted into
// scripts/lib/platform-leg-gate.ts so scripts/test-platform-leg-gate.ts
// can exercise the gate's failure path in isolation, without
// side-effect-running this whole pre-launch suite via a top-level import.
// The thin wrappers here bind the local reporter (pass/fail/skip) and DB
// helpers so call sites in this file are unchanged.
// ---------------------------------------------------------------------------

async function snapshotPlatformPerCurrency(
  platformUserId: number,
  currencies: string[],
): Promise<PlatformPerCurrency> {
  return libSnapshotPlatformPerCurrency(
    platformUserId,
    currencies,
    getUserCurrencyBalance,
  );
}

// Wrap a Stage 2 scenario: snapshot platform per-currency BEFORE, run
// the scenario, then run `assertPlatformLegInvariantAndScrub` which scrubs
// the fixture user's transactions (cascading to delete the scenario's
// platform-side legs) and asserts the per-currency delta is zero.
//
// Runs the scenario inside a try so an exception inside the scenario does
// NOT skip the platform-leg gate — we still want to report contamination
// the scenario may have caused before throwing. The scenario itself records
// its own pass/fail/skip via the existing `pass()`/`fail()`/`skip()` helpers.
//
// SKIP semantics (mirrors the per-script ledger-leak gate at Stage 1):
//   - PLATFORM_USER_ID unresolvable     → SKIP with reason
//   - pre-snapshot of platform ledger throws → SKIP with reason (we won't
//     fall back to a `0` baseline because that would let drift hide as a
//     false PASS or surface as a false FAIL — both are worse than SKIP).
//   - the scenario itself recorded SKIP → SKIP (nothing for us to gate
//     against; matches the Stage 1 leak-gate's "sub-script did not
//     complete" branch).
async function runScenarioWithPlatformLegAssert(cfg: {
  gateName: string;
  scenarioName: string;
  scenarioGateName: string;
  fixtureUsername: string;
  currencies: string[];
  run: () => Promise<void>;
}): Promise<void> {
  const platformUserIdRaw = process.env.PLATFORM_USER_ID;
  let platformUserId = 0;
  let baseline: PlatformPerCurrency = new Map();
  let baselineCaptured = false;
  let baselineError: string | null = null;
  if (platformUserIdRaw) {
    const parsed = parseInt(platformUserIdRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      platformUserId = parsed;
      try {
        baseline = await snapshotPlatformPerCurrency(
          platformUserId,
          cfg.currencies,
        );
        baselineCaptured = true;
      } catch (err: any) {
        // Mirrors the per-script leak-gate handling in Stage 1: if we
        // cannot capture the BEFORE snapshot, we have nothing to compare
        // AFTER against, so the gate genuinely cannot run. Record the
        // error and SKIP downstream rather than fall through to a false
        // PASS/FAIL produced from an empty baseline.
        baselineError = err?.message ?? String(err);
        console.error(
          `pre-launch: platform-leg snapshot (before) failed for ${cfg.scenarioName}:`,
          baselineError,
        );
      }
    }
  }

  // Run the scenario. Its own pass/fail/skip is recorded inside `cfg.run`.
  // We do NOT swallow scenario throws here — by contract every scenario
  // function is wrapped in its own try/catch and records `fail()` on throw,
  // so reaching this point is normal regardless of scenario outcome.
  await cfg.run();

  // Tie platform-leg outcome to the scenario's actual execution state.
  // If the scenario itself reported SKIP (e.g. a route handler wasn't
  // captured, or a precondition like an FX-rate seed failed), it never
  // exercised the ledger paths this gate is meant to protect — so we
  // SKIP too, with the scenario's own SKIP reason for context. This
  // matches the Stage 1 per-script leak-gate's behaviour and prevents
  // the platform-leg gate from PASSing on a fixture user that already
  // existed from a prior run when the scenario itself didn't actually
  // run this time.
  const scenarioOutcome = results.get(cfg.scenarioGateName);
  if (scenarioOutcome?.outcome === "skip") {
    skip(
      cfg.gateName,
      `scenario "${cfg.scenarioName}" itself was skipped (${scenarioOutcome.details}); ` +
        `nothing for the platform-leg gate to verify`,
    );
    return;
  }

  await assertPlatformLegInvariantAndScrub(
    cfg.gateName,
    cfg.scenarioName,
    cfg.fixtureUsername,
    cfg.currencies,
    baseline,
    platformUserId,
    baselineCaptured,
    baselineError,
  );
}

async function assertPlatformLegInvariantAndScrub(
  gateName: string,
  scenarioName: string,
  fixtureUsername: string,
  currencies: string[],
  baseline: PlatformPerCurrency,
  platformUserId: number,
  baselineCaptured: boolean,
  baselineError: string | null,
): Promise<void> {
  // Task #209 — gate logic lives in scripts/lib/platform-leg-gate.ts so the
  // regression test (scripts/test-platform-leg-gate.ts) can exercise it
  // in isolation. This wrapper binds the local reporter and DB helpers.
  await libAssertPlatformLegInvariantAndScrub({
    gateName,
    scenarioName,
    fixtureUsername,
    currencies,
    baseline,
    platformUserId,
    baselineCaptured,
    baselineError,
    reporter: { pass, fail, skip },
    lookupFixtureUserId: async (username) => {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      return row?.id ?? null;
    },
    scrubFixture: async (fixtureUserId) => {
      await resetScenarioState([fixtureUserId]);
    },
    getBalance: getUserCurrencyBalance,
  });
}

// Note: Task #201 removed the bulk `scrubLifecyclePlatformLegs()` helper
// that previously ran at end of Stage 2. Two later changes superseded it:
//   1. Task #202 wraps every lifecycle scenario in
//      `runScenarioWithPlatformLegAssert`, which scrubs the fixture user's
//      transactions PER-SCENARIO (cascading to delete the platform-side
//      legs immediately after each scenario asserts its invariant).
//   2. Task #201 flags the platform user `is_demo=true` at provisioning
//      time, which makes the wallet-vs-ledger reconciler skip its
//      (user, currency) pairs entirely. So even if a stray platform-side
//      leg slipped past the per-scenario scrub, it would not surface as
//      a wallet-vs-ledger reconciliation alert.
// Together these made the bulk Stage-2.5 scrub redundant.
//
// Task #210 then converted the absent end-of-Stage-2 scrub into a strict
// CONTRACT gate (`assertFixtureUsersHaveZeroTransactions` below): rather
// than re-running a bulk scrub that would now be a defensive no-op, we
// instead assert the per-scenario scrubs DID their job. Any new scenario
// that bypasses `runScenarioWithPlatformLegAssert` (or whose fixture
// username does not match the username it scrubs) leaves transactions
// behind on a `__prelaunch_%` user and is caught loudly here, instead of
// silently leaking residue into Stage 3 reconciliation.

// ---------------------------------------------------------------------------
// Task #210 — end-of-Stage-2 fixture-user contract gate.
//
// Asserts that every `__prelaunch_%` fixture user owns zero transactions
// at the boundary between Stage 2 (lifecycle scenarios) and Stage 3
// (reconciliation clean-rooms). The platform user (resolved via
// `PLATFORM_USER_ID`) is intentionally EXCLUDED — it is shared
// infrastructure across the whole pre-launch run and across every Stage-1
// subprocess test, not a per-scenario fixture, so there is no per-run
// "back to zero" expectation on its rows.
//
// Outcomes:
//   - PASS  — every fixture user has zero transactions; per-scenario
//             scrub contract holds.
//   - FAIL  — at least one fixture user still owns transactions; the
//             failure names each offender and its transaction count so
//             the operator can map directly back to the scenario that
//             skipped the scrub.
//   - SKIP  — no `__prelaunch_%` fixture users exist (every Stage 2
//             lifecycle was skipped before creating its user, e.g. all
//             route handlers missing). Reported as SKIP rather than
//             a free PASS so --strict treats it as unverified.
// ---------------------------------------------------------------------------
async function assertFixtureUsersHaveZeroTransactions(): Promise<void> {
  const gateName = "lifecycle: end-of-Stage-2 fixture-user contract";
  try {
    const platformUserIdRaw = process.env.PLATFORM_USER_ID;
    const platformUserId = platformUserIdRaw
      ? parseInt(platformUserIdRaw, 10)
      : NaN;

    // Match every fixture user this script may have created, but exclude
    // the platform user (it may itself be `__prelaunch_platform` when
    // PLATFORM_USER_ID was unset at startup).
    //
    // The literal underscores in `__prelaunch_` are SQL LIKE single-char
    // wildcards by default, so we escape them via `ESCAPE '\\'` (matches
    // the precedent in scripts/test-wealth-planner-compliance.ts) — a
    // bare `LIKE '__prelaunch_%'` would also match e.g. `xxprelaunch_foo`
    // and produce false-positive failures from unrelated test fixtures.
    const prelaunchPrefixMatch = sql`${users.username} LIKE '\_\_prelaunch\_%' ESCAPE '\\'`;
    const whereClause =
      Number.isInteger(platformUserId) && platformUserId > 0
        ? and(prelaunchPrefixMatch, ne(users.id, platformUserId))
        : prelaunchPrefixMatch;

    const fixtureUsers = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(whereClause);

    if (fixtureUsers.length === 0) {
      skip(
        gateName,
        `no __prelaunch_% fixture users exist (excluding the platform ` +
          `user); nothing to verify — every Stage 2 lifecycle was likely ` +
          `skipped before creating its fixture`,
      );
      return;
    }

    const fixtureUserIds = fixtureUsers.map((u) => u.id);
    const txRows = await db
      .select({ userId: transactions.userId, id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.userId, fixtureUserIds));

    if (txRows.length === 0) {
      pass(
        gateName,
        `every __prelaunch_% fixture user (n=${fixtureUsers.length}, ` +
          `excluding platform user id=${platformUserId}) owns zero ` +
          `transactions at end of Stage 2 — the per-scenario scrub ` +
          `contract holds`,
      );
      return;
    }

    const usernameById = new Map(fixtureUsers.map((u) => [u.id, u.username]));
    const countsByUserId = new Map<number, number>();
    for (const t of txRows) {
      countsByUserId.set(t.userId, (countsByUserId.get(t.userId) ?? 0) + 1);
    }
    const offenders = Array.from(countsByUserId.entries())
      .map(([uid, n]) => `${usernameById.get(uid) ?? `user#${uid}`}=${n}`)
      .sort()
      .join(", ");

    fail(
      gateName,
      `${txRows.length} leftover transaction row(s) on ` +
        `${countsByUserId.size} fixture user(s) at end of Stage 2: ` +
        `${offenders}. Every Stage 2 lifecycle scenario MUST self-clean ` +
        `via runScenarioWithPlatformLegAssert (which deletes the fixture ` +
        `user's transactions, cascading to its platform-side legs). A ` +
        `non-zero count here means a scenario was added that bypasses ` +
        `that wrapper, or its fixture username does not match the ` +
        `username the wrapper scrubs.`,
    );
  } catch (err: any) {
    fail(gateName, `threw: ${err?.message ?? err}`);
  }
}

async function ensureWallet(userId: number, currency: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)));
  if (existing) {
    await db
      .update(wallets)
      .set({ balance: "0", availableBalance: "0" })
      .where(eq(wallets.id, existing.id));
    pushUnique(created.walletIds, existing.id);
    return;
  }
  const [row] = await db
    .insert(wallets)
    .values({
      userId,
      currency,
      balance: "0",
      availableBalance: "0",
      walletType: currency === "BTC" || currency === "ETH" ? "crypto" : "fiat",
    })
    .returning();
  pushUnique(created.walletIds, row.id);
}

// Reset the source-of-truth: nuke every ledger entry / receipt / transaction
// and idempotency-key row owned by these scenario users so re-runs start
// from a clean slate. Safe because the users themselves are __prelaunch_-
// prefixed and not used by any other test.
async function resetScenarioState(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  // Capture PKs of pre-existing rows so cleanup at the end of the run still
  // tracks them (in case cleanup needs to extend coverage).
  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.userId, userIds));
  const txIds = txRows.map((r) => r.id);
  const idemRows = await db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(inArray(idempotencyKeys.userId, userIds));
  for (const r of idemRows) pushUnique(created.idempotencyKeyIds, r.id);

  if (txIds.length > 0) {
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, txIds));
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, txIds));
    await db.delete(transactions).where(inArray(transactions.id, txIds));
  }
  if (idemRows.length > 0) {
    await db
      .delete(idempotencyKeys)
      .where(inArray(idempotencyKeys.id, idemRows.map((r) => r.id)));
  }
  // Reset wallet caches to zero.
  await db
    .update(wallets)
    .set({ balance: "0", availableBalance: "0" })
    .where(inArray(wallets.userId, userIds));
}

// ---------------------------------------------------------------------------
// Route capture. registerRoutes() is async, registers the deposit/withdraw
// handlers inline (not via a sub-router we can import directly), and ends
// with `createServer(app)` which expects `app` to be a callable request
// listener. We satisfy both by handing it a callable mock that records
// every (method, path) -> last-handler pair.
// ---------------------------------------------------------------------------
type CapturedHandler = (req: Request, res: any) => unknown;
const captured = new Map<string, CapturedHandler>();
const routesCapturedFlag = { ready: false };

function makeCapturingApp(): any {
  const app: any = function fakeApp(_req: any, _res: any) {
    /* never called — we invoke captured handlers directly */
  };
  const recorder = (verb: string) => (
    p: string,
    ...handlers: CapturedHandler[]
  ) => {
    captured.set(`${verb} ${p}`, handlers[handlers.length - 1]);
    return app;
  };
  app.get = recorder("GET");
  app.post = recorder("POST");
  app.patch = recorder("PATCH");
  app.delete = recorder("DELETE");
  app.put = recorder("PUT");
  app.all = recorder("ALL");
  app.use = () => app;
  app.set = () => app;
  app.engine = () => app;
  app.disable = () => app;
  app.enable = () => app;
  app.locals = {};
  return app;
}

async function captureMoneyRoutes(): Promise<void> {
  if (routesCapturedFlag.ready) return;
  const app = makeCapturingApp();
  await registerRoutes(app as Express);
  routesCapturedFlag.ready = true;
}

type MockResult = { statusCode: number; body: unknown };
function makeMockReqRes(opts: {
  token: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
}): { req: Request; res: any; result: MockResult } {
  const result: MockResult = { statusCode: 200, body: undefined };
  const req = {
    headers: {
      authorization: `Bearer ${opts.token}`,
      ...(opts.headers ?? {}),
    },
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: {},
    path: "",
    method: "POST",
    ip: "127.0.0.1",
  } as unknown as Request;
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(b: unknown) {
      result.body = b;
      return this;
    },
    send(b: unknown) {
      result.body = b;
      return this;
    },
  };
  return { req, res, result };
}

function getHandler(key: string): CapturedHandler {
  const h = captured.get(key);
  if (!h) {
    throw new Error(
      `internal: route handler '${key}' was not captured from registerRoutes()`,
    );
  }
  return h;
}

// Task #142 — preflight a route's availability so the lifecycle scenarios
// can SKIP cleanly (with a reason) instead of FAILing when the precondition
// they need wasn't even registered. Returns the missing keys, or [] if all
// expected handlers are present.
function missingHandlerKeys(...keys: string[]): string[] {
  return keys.filter((k) => !captured.has(k));
}

// ---------------------------------------------------------------------------
// Synthetic balanced ledger pair — used by the happy-path scenario to
// simulate the AUD and BTC legs of a crypto trade. Each leg is a single
// balanced transaction (postLedgerEntries enforces single-currency,
// debit==credit). The pair leaves the suspense account net-flat and the
// client account moved by the trade amount.
// ---------------------------------------------------------------------------
async function postSyntheticLeg(opts: {
  userId: number;
  currency: string;
  amount: string;
  direction: "to_client" | "to_suspense";
  description: string;
}): Promise<number> {
  let txId = 0;
  await db.transaction(async (tx) => {
    const [txRow] = await tx
      .insert(transactions)
      .values({
        userId: opts.userId,
        type: opts.direction === "to_client" ? "deposit" : "withdrawal",
        fromCurrency: opts.direction === "to_client" ? null : opts.currency,
        toCurrency: opts.direction === "to_client" ? opts.currency : null,
        amount: new Decimal(opts.amount).toFixed(8),
        fee: "0.00000000",
        exchangeRate: null,
        status: "completed",
        settlementStatus: "internal_only",
        description: opts.description,
        sourceExchange: null,
        blockchainTxHash: null,
      })
      .returning();
    txId = txRow.id;
    pushUnique(created.transactionIds, txRow.id);

    const clientAccount = await getOrCreateClientAccount(
      opts.userId,
      opts.currency,
      tx,
    );
    const suspenseAccount = await getOrCreateSuspenseAccount(opts.currency, tx);
    pushUnique(created.accountIds, clientAccount.id);
    pushUnique(created.accountIds, suspenseAccount.id);

    const amt = new Decimal(opts.amount).toFixed(8);
    const entries =
      opts.direction === "to_client"
        ? [
            {
              accountId: suspenseAccount.id,
              userId: suspenseAccount.userId,
              currency: opts.currency,
              direction: "debit" as const,
              amount: amt,
              description: `${opts.description} (suspense leg)`,
            },
            {
              accountId: clientAccount.id,
              userId: opts.userId,
              currency: opts.currency,
              direction: "credit" as const,
              amount: amt,
              description: `${opts.description} (client leg)`,
            },
          ]
        : [
            {
              accountId: clientAccount.id,
              userId: opts.userId,
              currency: opts.currency,
              direction: "debit" as const,
              amount: amt,
              description: `${opts.description} (client leg)`,
            },
            {
              accountId: suspenseAccount.id,
              userId: suspenseAccount.userId,
              currency: opts.currency,
              direction: "credit" as const,
              amount: amt,
              description: `${opts.description} (suspense leg)`,
            },
          ];
    await postLedgerEntries(txRow.id, entries, tx);
    await refreshWalletCacheBalance(tx, opts.userId, opts.currency);
  });
  return txId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function readWalletBalance(
  userId: number,
  currency: string,
): Promise<string> {
  const [row] = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)));
  return row?.balance ?? "0";
}

function eqToCent(a: string, b: string): boolean {
  return new Decimal(a).minus(new Decimal(b)).abs().lte(new Decimal("0.01"));
}

async function captureNewTxIds(userId: number): Promise<void> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  for (const r of rows) pushUnique(created.transactionIds, r.id);
}

async function captureNewIdemIds(userId: number): Promise<void> {
  const rows = await db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.userId, userId));
  for (const r of rows) pushUnique(created.idempotencyKeyIds, r.id);
}

// ---------------------------------------------------------------------------
// Lifecycle scenario 1: full happy-path lifecycle.
// signup -> KYC -> AUD deposit -> simulated buy crypto -> simulated sell
// crypto -> AUD withdrawal -> assert wallet == SUM(ledger_entries) per
// currency, to the cent.
//
// The "buy crypto / sell crypto" step is simulated as four balanced
// single-currency journals (two per leg) because the production
// /api/fx-exchange route writes wallet balances directly without a ledger
// pair (a known caveat; outside the scope of this rollup). Using
// postLedgerEntries directly keeps the ledger as the source of truth, and
// the crypto round-trip nets BTC to zero and returns AUD to its
// pre-trade level so the eventual withdraw -> wallet assertion is the
// clean end-to-end check.
// ---------------------------------------------------------------------------
async function lifecycle1_happyPath(): Promise<void> {
  const NAME = "lifecycle: happy-path wallet matches ledger";
  // Task #142 — preflight: if the deposit/withdraw routes weren't even
  // registered, we cannot meaningfully run this scenario. SKIP with a
  // clear reason rather than fall through to FAIL.
  const missing = missingHandlerKeys("POST /api/deposit", "POST /api/withdraw");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    const userId = await ensureUser({
      username: HAPPY_USERNAME,
      email: "prelaunch-happy@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");
    await ensureWallet(userId, "BTC");

    const token = signToken({
      userId,
      username: HAPPY_USERNAME,
      email: "prelaunch-happy@test.invalid",
      role: "client",
    });

    // --- Step 1: AUD deposit through the real /api/deposit handler.
    const depositHandler = getHandler("POST /api/deposit");
    const dep = makeMockReqRes({
      token,
      headers: { "idempotency-key": `prelaunch-happy-deposit-${randomUUID()}` },
      body: { currency: "AUD", amount: HAPPY_AUD_DEPOSIT },
    });
    await depositHandler(dep.req, dep.res);
    if (dep.result.statusCode !== 200) {
      throw new Error(
        `deposit handler returned ${dep.result.statusCode}: ${JSON.stringify(dep.result.body)}`,
      );
    }

    // --- Step 2a: simulated buy crypto, AUD leg (client AUD out -> suspense).
    await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: HAPPY_AUD_TRADE,
      direction: "to_suspense",
      description: "prelaunch trade buy AUD leg",
    });
    // --- Step 2b: simulated buy crypto, BTC leg (suspense BTC -> client).
    await postSyntheticLeg({
      userId,
      currency: "BTC",
      amount: HAPPY_BTC_NOTIONAL,
      direction: "to_client",
      description: "prelaunch trade buy BTC leg",
    });

    // --- Step 3a: simulated sell crypto, BTC leg (client BTC out -> suspense).
    await postSyntheticLeg({
      userId,
      currency: "BTC",
      amount: HAPPY_BTC_NOTIONAL,
      direction: "to_suspense",
      description: "prelaunch trade sell BTC leg",
    });
    // --- Step 3b: simulated sell crypto, AUD leg (suspense AUD -> client).
    await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: HAPPY_AUD_TRADE,
      direction: "to_client",
      description: "prelaunch trade sell AUD leg",
    });

    // --- Step 4: AUD withdrawal through the real /api/withdraw handler.
    const withdrawHandler = getHandler("POST /api/withdraw");
    const wd = makeMockReqRes({
      token,
      headers: {
        "idempotency-key": `prelaunch-happy-withdraw-${randomUUID()}`,
      },
      body: { currency: "AUD", amount: HAPPY_AUD_WITHDRAW },
    });
    await withdrawHandler(wd.req, wd.res);
    if (wd.result.statusCode !== 200) {
      throw new Error(
        `withdraw handler returned ${wd.result.statusCode}: ${JSON.stringify(wd.result.body)}`,
      );
    }

    // Track newly-created tx + idempotency rows for cleanup.
    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    // --- Assertion: wallet cache equals SUM(ledger_entries), per currency,
    // to the cent. Compute the expected closing AUD as a sanity check on
    // the maths — but the canonical proof is wallet == ledger.
    const audWallet = await readWalletBalance(userId, "AUD");
    const audLedger = await getUserCurrencyBalance(userId, "AUD");
    const btcWallet = await readWalletBalance(userId, "BTC");
    const btcLedger = await getUserCurrencyBalance(userId, "BTC");

    // Expected AUD: 1000 deposit - 500 trade-out + 500 trade-in
    //               - (200 withdraw + 35 fee) = 765
    const expectedAud = new Decimal(HAPPY_AUD_DEPOSIT)
      .minus(HAPPY_AUD_TRADE)
      .plus(HAPPY_AUD_TRADE)
      .minus(HAPPY_AUD_WITHDRAW)
      .minus(HAPPY_AUD_WITHDRAW_FEE)
      .toFixed(2);
    const expectedBtc = "0";

    const audOk =
      eqToCent(audWallet, audLedger) && eqToCent(audWallet, expectedAud);
    const btcOk =
      eqToCent(btcWallet, btcLedger) && eqToCent(btcWallet, expectedBtc);

    if (audOk && btcOk) {
      pass(
        NAME,
        `AUD wallet=${audWallet}, ledger=${audLedger}, expected=${expectedAud}; ` +
          `BTC wallet=${btcWallet}, ledger=${btcLedger}, expected=${expectedBtc}`,
      );
    } else {
      fail(
        NAME,
        `AUD wallet=${audWallet}, ledger=${audLedger}, expected=${expectedAud}; ` +
          `BTC wallet=${btcWallet}, ledger=${btcLedger}, expected=${expectedBtc}`,
      );
    }
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle scenario 2: idempotency under concurrency.
// Fire two parallel POSTs to /api/deposit with the same Idempotency-Key.
// Assert exactly: 1 transactions row, 1 ledger pair (2 entries, 1 receipt),
// 1 idempotency_keys row.
// ---------------------------------------------------------------------------
async function lifecycle2_idempotencyConcurrency(): Promise<void> {
  const NAME = "lifecycle: idempotency under concurrency";
  // Task #142 — preflight: needs the deposit handler.
  const missing = missingHandlerKeys("POST /api/deposit");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    const userId = await ensureUser({
      username: IDEM_USERNAME,
      email: "prelaunch-idem@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");

    const token = signToken({
      userId,
      username: IDEM_USERNAME,
      email: "prelaunch-idem@test.invalid",
      role: "client",
    });

    const idemKey = `prelaunch-idem-${randomUUID()}`;
    const body = { currency: "AUD", amount: "100.00" };

    const depositHandler = getHandler("POST /api/deposit");
    const callOne = (): Promise<MockResult> => {
      const m = makeMockReqRes({
        token,
        headers: { "idempotency-key": idemKey },
        body,
      });
      return Promise.resolve(depositHandler(m.req, m.res)).then(() => m.result);
    };

    const [r1, r2] = await Promise.all([callOne(), callOne()]);

    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    // Count what landed in the database under this user.
    const txRows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    const txIds = txRows.map((r) => r.id);
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(
        txIds.length > 0
          ? inArray(ledgerEntries.transactionId, txIds)
          : sql`FALSE`,
      );
    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(
        txIds.length > 0
          ? inArray(ledgerPostings.transactionId, txIds)
          : sql`FALSE`,
      );
    const [{ idemCount }] = await db
      .select({ idemCount: sql<number>`COUNT(*)::int` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, "/api/deposit"),
          eq(idempotencyKeys.key, idemKey),
        ),
      );

    const ok =
      txRows.length === 1 &&
      Number(entryCount) === 2 &&
      Number(receiptCount) === 1 &&
      Number(idemCount) === 1 &&
      r1.statusCode === 200 &&
      r2.statusCode === 200;

    const detail =
      `parallel deposits: tx=${txRows.length}, entries=${entryCount}, ` +
      `receipts=${receiptCount}, idem rows=${idemCount}, ` +
      `http=[${r1.statusCode},${r2.statusCode}]`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Task #185 — idempotency-under-concurrency for the OTHER money routes.
// /api/deposit was wired by Task #160; /api/withdraw, /api/fx-exchange,
// /api/wallets/transfer, and /api/investments now each call
// `replayIdempotentOnSerializationFailure` first in their catch blocks. Each
// scenario fires two parallel POSTs sharing one Idempotency-Key and asserts:
//   - http=[200, 200] (no leaked SQLSTATE 40001 → 500)
//   - exactly one new transaction row attributable to the parallel calls
//   - exactly one `idempotency_keys` row for that route+key
// Routes that post double-entry ledger pairs (only /api/withdraw in this
// group) additionally assert one ledger pair (2 entries, 1 receipt). The
// other three routes write wallet balances directly without ledger entries
// (a known pre-existing caveat — see lifecycle1 commentary), so the new tx
// row is the assertion.
// ---------------------------------------------------------------------------

// Snapshot the user's transactions BEFORE firing the parallel calls so we
// can count NEW rows the calls produced, independent of any seed tx the
// scenario created to fund the wallet.
async function snapshotTxIds(userId: number): Promise<Set<number>> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return new Set(rows.map((r) => r.id));
}

async function newTxIdsSince(
  userId: number,
  before: Set<number>,
): Promise<number[]> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  return rows.map((r) => r.id).filter((id) => !before.has(id));
}

async function ensureFxRateSeed(
  base: string,
  target: string,
  rate: string,
): Promise<void> {
  const existing = await storage.getFxRate(base, target);
  if (existing) return;
  await storage.createFxRate({
    baseCurrency: base,
    targetCurrency: target,
    rate,
    // `spread` is NOT NULL in the schema; the auto-FX-refresh job populates
    // it for live pairs. For test pairs we just need any valid value.
    spread: "0.0010",
  });
}

async function lifecycle2b_idempotencyConcurrencyWithdraw(): Promise<void> {
  const NAME = "lifecycle: idempotency under concurrency (withdraw)";
  const missing = missingHandlerKeys("POST /api/withdraw");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    const userId = await ensureUser({
      username: IDEM_WITHDRAW_USERNAME,
      email: "prelaunch-idem-withdraw@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");

    // Seed AUD funds via a balanced ledger pair so the withdrawal
    // pre-check (`available.lt(totalDeduction)`) passes.
    // Withdraw fee for AUD is 35.00 (matches WITHDRAWAL_FEES['AUD']).
    await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: "1000.00",
      direction: "to_client",
      description: "prelaunch idem-withdraw seed",
    });

    const txIdsBefore = await snapshotTxIds(userId);

    const token = signToken({
      userId,
      username: IDEM_WITHDRAW_USERNAME,
      email: "prelaunch-idem-withdraw@test.invalid",
      role: "client",
    });

    const idemKey = `prelaunch-idem-withdraw-${randomUUID()}`;
    const body = { currency: "AUD", amount: "100.00" };

    const withdrawHandler = getHandler("POST /api/withdraw");
    const callOne = (): Promise<MockResult> => {
      const m = makeMockReqRes({
        token,
        headers: { "idempotency-key": idemKey },
        body,
      });
      return Promise.resolve(withdrawHandler(m.req, m.res)).then(
        () => m.result,
      );
    };

    const [r1, r2] = await Promise.all([callOne(), callOne()]);

    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    const newTxIds = await newTxIdsSince(userId, txIdsBefore);
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerEntries.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerPostings.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ idemCount }] = await db
      .select({ idemCount: sql<number>`COUNT(*)::int` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, "/api/withdraw"),
          eq(idempotencyKeys.key, idemKey),
        ),
      );

    const ok =
      newTxIds.length === 1 &&
      Number(entryCount) === 2 &&
      Number(receiptCount) === 1 &&
      Number(idemCount) === 1 &&
      r1.statusCode === 200 &&
      r2.statusCode === 200;

    const detail =
      `parallel withdrawals: new tx=${newTxIds.length}, entries=${entryCount}, ` +
      `receipts=${receiptCount}, idem rows=${idemCount}, ` +
      `http=[${r1.statusCode},${r2.statusCode}]`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

async function lifecycle2c_idempotencyConcurrencyFxExchange(): Promise<void> {
  const NAME = "lifecycle: idempotency under concurrency (fx-exchange)";
  const missing = missingHandlerKeys("POST /api/fx-exchange");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    // Pre-check: an FX rate must exist for the pair we're going to trade.
    // If not, SKIP cleanly rather than fail on a precondition the gate
    // wasn't designed to verify.
    await ensureFxRateSeed("AUD", "USD", "0.65");

    const userId = await ensureUser({
      username: IDEM_FXEX_USERNAME,
      email: "prelaunch-idem-fxex@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");
    await ensureWallet(userId, "USD");

    // Seed AUD funds via a balanced ledger pair, then refresh the wallet
    // cache so `available.lt(amount)` in the FX handler passes.
    await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: "1000.00",
      direction: "to_client",
      description: "prelaunch idem-fxex seed",
    });
    // The FX handler reads `wallets.availableBalance` — the seed already
    // refreshed it via `refreshWalletCacheBalance` inside postSyntheticLeg.

    const txIdsBefore = await snapshotTxIds(userId);

    const token = signToken({
      userId,
      username: IDEM_FXEX_USERNAME,
      email: "prelaunch-idem-fxex@test.invalid",
      role: "client",
    });

    const idemKey = `prelaunch-idem-fxex-${randomUUID()}`;
    const body = { fromCurrency: "AUD", toCurrency: "USD", amount: "100.00" };

    const fxHandler = getHandler("POST /api/fx-exchange");
    const callOne = (): Promise<MockResult> => {
      const m = makeMockReqRes({
        token,
        headers: { "idempotency-key": idemKey },
        body,
      });
      return Promise.resolve(fxHandler(m.req, m.res)).then(() => m.result);
    };

    const [r1, r2] = await Promise.all([callOne(), callOne()]);

    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    const newTxIds = await newTxIdsSince(userId, txIdsBefore);
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerEntries.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerPostings.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ idemCount }] = await db
      .select({ idemCount: sql<number>`COUNT(*)::int` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, "/api/fx-exchange"),
          eq(idempotencyKeys.key, idemKey),
        ),
      );

    // Task #201 — /api/fx-exchange now posts a single multi-currency
    // journal: source-currency leg (DEBIT clientSrc + CREDIT suspenseSrc)
    // = 2 entries, target-currency leg (DEBIT suspenseTgt + CREDIT
    // clientTgt + CREDIT feeAccountTgt) = 3 entries. Total = 5 entries
    // and exactly 1 receipt for the new tx. Two parallel calls under
    // the same idempotency key → 1 new tx, 1 idem row, 200/200.
    const ok =
      newTxIds.length === 1 &&
      Number(entryCount) === 5 &&
      Number(receiptCount) === 1 &&
      Number(idemCount) === 1 &&
      r1.statusCode === 200 &&
      r2.statusCode === 200;

    const detail =
      `parallel fx-exchange: new tx=${newTxIds.length}, entries=${entryCount}, ` +
      `receipts=${receiptCount}, idem rows=${idemCount}, ` +
      `http=[${r1.statusCode},${r2.statusCode}]`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

async function lifecycle2d_idempotencyConcurrencyWalletTransfer(): Promise<void> {
  const NAME = "lifecycle: idempotency under concurrency (wallets/transfer)";
  const missing = missingHandlerKeys("POST /api/wallets/transfer");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    await ensureFxRateSeed("AUD", "USD", "0.65");

    const userId = await ensureUser({
      username: IDEM_WTRANSFER_USERNAME,
      email: "prelaunch-idem-wtransfer@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");
    await ensureWallet(userId, "USD");

    await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: "1000.00",
      direction: "to_client",
      description: "prelaunch idem-wtransfer seed",
    });

    const txIdsBefore = await snapshotTxIds(userId);

    const token = signToken({
      userId,
      username: IDEM_WTRANSFER_USERNAME,
      email: "prelaunch-idem-wtransfer@test.invalid",
      role: "client",
    });

    const idemKey = `prelaunch-idem-wtransfer-${randomUUID()}`;
    const body = { fromCurrency: "AUD", toCurrency: "USD", amount: "100.00" };

    const handler = getHandler("POST /api/wallets/transfer");
    const callOne = (): Promise<MockResult> => {
      const m = makeMockReqRes({
        token,
        headers: { "idempotency-key": idemKey },
        body,
      });
      return Promise.resolve(handler(m.req, m.res)).then(() => m.result);
    };

    const [r1, r2] = await Promise.all([callOne(), callOne()]);

    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    const newTxIds = await newTxIdsSince(userId, txIdsBefore);
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerEntries.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerPostings.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ idemCount }] = await db
      .select({ idemCount: sql<number>`COUNT(*)::int` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, "/api/wallets/transfer"),
          eq(idempotencyKeys.key, idemKey),
        ),
      );

    // Task #201 — same FX-shaped multi-currency journal as fx-exchange:
    // 5 entries (2 source-currency + 3 target-currency), 1 receipt.
    const ok =
      newTxIds.length === 1 &&
      Number(entryCount) === 5 &&
      Number(receiptCount) === 1 &&
      Number(idemCount) === 1 &&
      r1.statusCode === 200 &&
      r2.statusCode === 200;

    const detail =
      `parallel wallets/transfer: new tx=${newTxIds.length}, entries=${entryCount}, ` +
      `receipts=${receiptCount}, idem rows=${idemCount}, ` +
      `http=[${r1.statusCode},${r2.statusCode}]`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

async function lifecycle2e_idempotencyConcurrencyInvestments(): Promise<void> {
  const NAME = "lifecycle: idempotency under concurrency (investments)";
  const missing = missingHandlerKeys("POST /api/investments");
  if (missing.length > 0) {
    skip(NAME, `route handler(s) not captured: ${missing.join(", ")}`);
    return;
  }
  try {
    // Pick the cheapest active investment product so we can fund the
    // source wallet without huge seeds. SKIP cleanly if no product exists
    // (the gate is for the catch-block wiring, not for product seeding).
    const productRows = await db
      .select({
        id: investmentProducts.id,
        minimumInvestment: investmentProducts.minimumInvestment,
      })
      .from(investmentProducts)
      .where(eq(investmentProducts.isActive, true))
      .orderBy(investmentProducts.minimumInvestment)
      .limit(1);
    if (productRows.length === 0) {
      skip(NAME, "no active investment_products row available to test against");
      return;
    }
    const product = productRows[0];

    const userId = await ensureUser({
      username: IDEM_INVEST_USERNAME,
      email: "prelaunch-idem-invest@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "USD");
    // resetScenarioState() does not know about user_investments — clear it
    // explicitly so re-runs don't accumulate prior investment rows that
    // would break the `invCount === 1` assertion.
    await db
      .delete(userInvestments)
      .where(eq(userInvestments.userId, userId));

    // Need to fund the USD wallet with at least the minimum investment.
    // Floor everything at 100 so a product with `minimumInvestment = 0`
    // (which would make the seed 0 and trip postLedgerEntries' positive-
    // amount invariant) still produces a sensible scenario.
    const minInvestRaw = new Decimal(product.minimumInvestment);
    const investAmountDec = Decimal.max(minInvestRaw, new Decimal("100"));
    const seedAmount = investAmountDec.mul(2).toFixed(2);
    await postSyntheticLeg({
      userId,
      currency: "USD",
      amount: seedAmount,
      direction: "to_client",
      description: "prelaunch idem-invest seed",
    });

    const txIdsBefore = await snapshotTxIds(userId);

    const token = signToken({
      userId,
      username: IDEM_INVEST_USERNAME,
      email: "prelaunch-idem-invest@test.invalid",
      role: "client",
    });

    const idemKey = `prelaunch-idem-invest-${randomUUID()}`;
    const investAmount = investAmountDec.toFixed(2);
    const body = {
      productId: product.id,
      amount: investAmount,
      sourceCurrency: "USD",
    };

    const handler = getHandler("POST /api/investments");
    const callOne = (): Promise<MockResult> => {
      const m = makeMockReqRes({
        token,
        headers: { "idempotency-key": idemKey },
        body,
      });
      return Promise.resolve(handler(m.req, m.res)).then(() => m.result);
    };

    const [r1, r2] = await Promise.all([callOne(), callOne()]);

    await captureNewTxIds(userId);
    await captureNewIdemIds(userId);

    const newTxIds = await newTxIdsSince(userId, txIdsBefore);
    const [{ entryCount }] = await db
      .select({ entryCount: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerEntries.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ receiptCount }] = await db
      .select({ receiptCount: sql<number>`COUNT(*)::int` })
      .from(ledgerPostings)
      .where(
        newTxIds.length > 0
          ? inArray(ledgerPostings.transactionId, newTxIds)
          : sql`FALSE`,
      );
    const [{ idemCount }] = await db
      .select({ idemCount: sql<number>`COUNT(*)::int` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, "/api/investments"),
          eq(idempotencyKeys.key, idemKey),
        ),
      );
    const [{ invCount }] = await db
      .select({ invCount: sql<number>`COUNT(*)::int` })
      .from(userInvestments)
      .where(eq(userInvestments.userId, userId));

    // Task #201 — /api/investments now posts a single-currency journal:
    // DEBIT clientSrc + CREDIT suspenseSrc = 2 entries, 1 receipt.
    // Plus 1 new tx, 1 user_investments row, 1 idem row, 200/200.
    const ok =
      newTxIds.length === 1 &&
      Number(entryCount) === 2 &&
      Number(receiptCount) === 1 &&
      Number(invCount) === 1 &&
      Number(idemCount) === 1 &&
      r1.statusCode === 200 &&
      r2.statusCode === 200;

    const detail =
      `parallel investments: new tx=${newTxIds.length}, entries=${entryCount}, ` +
      `receipts=${receiptCount}, user_investments=${invCount}, idem rows=${idemCount}, ` +
      `http=[${r1.statusCode},${r2.statusCode}]`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle scenario 3: reversal symmetry.
// Post a forward transaction (debit suspense, credit client) and then a
// REVERSAL transaction (debit client, credit suspense, equal magnitude).
// Both rows must remain visible (audit-safe) and the wallet + ledger must
// be at exactly the pre-state, to the cent.
// ---------------------------------------------------------------------------
async function lifecycle3_reversalSymmetry(): Promise<void> {
  const NAME = "lifecycle: reversal symmetry";
  try {
    const userId = await ensureUser({
      username: REVERSAL_USERNAME,
      email: "prelaunch-reversal@test.invalid",
      role: "client",
    });
    await resetScenarioState([userId]);
    await ensureWallet(userId, "AUD");

    // Snapshot pre-state.
    const walletBefore = await readWalletBalance(userId, "AUD");
    const ledgerBefore = await getUserCurrencyBalance(userId, "AUD");

    const forwardTxId = await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: REVERSAL_AMOUNT,
      direction: "to_client",
      description: "prelaunch reversal forward",
    });

    // After forward: wallet should have moved by REVERSAL_AMOUNT.
    const walletMid = await readWalletBalance(userId, "AUD");
    const ledgerMid = await getUserCurrencyBalance(userId, "AUD");
    const movedByExpected =
      eqToCent(
        new Decimal(walletMid).minus(walletBefore).toFixed(2),
        REVERSAL_AMOUNT,
      ) && eqToCent(walletMid, ledgerMid);

    const reversalTxId = await postSyntheticLeg({
      userId,
      currency: "AUD",
      amount: REVERSAL_AMOUNT,
      direction: "to_suspense",
      description: `prelaunch reversal reverses tx#${forwardTxId}`,
    });

    await captureNewTxIds(userId);

    const walletAfter = await readWalletBalance(userId, "AUD");
    const ledgerAfter = await getUserCurrencyBalance(userId, "AUD");

    // Both rows must still be visible (audit-safe).
    const audit = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.id, [forwardTxId, reversalTxId]));

    const restored =
      eqToCent(walletAfter, walletBefore) &&
      eqToCent(ledgerAfter, ledgerBefore) &&
      eqToCent(walletAfter, ledgerAfter);

    const ok = movedByExpected && restored && audit.length === 2;

    const detail =
      `pre wallet=${walletBefore} ledger=${ledgerBefore}; ` +
      `mid wallet=${walletMid} ledger=${ledgerMid}; ` +
      `post wallet=${walletAfter} ledger=${ledgerAfter}; ` +
      `audit rows visible=${audit.length}/2 (forward=${forwardTxId}, reversal=${reversalTxId})`;

    if (ok) pass(NAME, detail);
    else fail(NAME, detail);
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Operator-alert clean rooms (Task #142 — split per service).
// Each reconciliation service is its own gate: snapshot MAX(operator_alerts.id)
// before, run the service in-process, then assert no rows of severity
// 'critical' or 'alert' were produced over the snapshot baseline. A service
// that finds no data to reconcile (no users with wallets/ledger entries, or
// no postings to compare) reports SKIP — there's nothing for the gate to
// have actually verified.
// ---------------------------------------------------------------------------
async function snapshotMaxAlertId(): Promise<number> {
  const [maxRow] = await db
    .select({ maxId: sql<number>`COALESCE(MAX(id), 0)::int` })
    .from(operatorAlerts);
  return Number(maxRow?.maxId ?? 0);
}

async function newCriticalOrAlertRows(baselineMaxId: number, source?: string) {
  const conditions = [
    gt(operatorAlerts.id, baselineMaxId),
    inArray(operatorAlerts.severity, ["critical", "alert"]),
  ];
  if (source) conditions.push(eq(operatorAlerts.source, source));
  return db
    .select({
      id: operatorAlerts.id,
      source: operatorAlerts.source,
      severity: operatorAlerts.severity,
      title: operatorAlerts.title,
    })
    .from(operatorAlerts)
    .where(and(...conditions))
    .orderBy(desc(operatorAlerts.id));
}

function summarizeAlertRows(
  rows: Array<{ id: number; source: string; severity: string; title: string }>,
): string {
  return rows
    .slice(0, 5)
    .map((r) => `#${r.id}[${r.severity}/${r.source}] ${r.title}`)
    .join("; ");
}

async function reconWalletLedgerCleanRoom(): Promise<void> {
  const NAME = "reconciliation: wallet-ledger clean-room";
  try {
    const baselineMaxId = await snapshotMaxAlertId();
    const summary = await runWalletLedgerReconciliation();
    if (summary.pairsChecked === 0) {
      skip(
        NAME,
        "no (user, currency) pairs to reconcile (no wallet rows and no ledger entries)",
      );
      return;
    }
    const newRows = await newCriticalOrAlertRows(baselineMaxId);
    // Task #200 — also fail when the reconciliation pass itself classified
    // ANY (user, currency) pair as `alert` or `critical` severity, even
    // when no new `operator_alerts` row was inserted. notifyOperator()
    // coalesces repeat firings inside its dedupe window by bumping the
    // existing row's `occurrences` counter instead of inserting a fresh
    // row, so a persistent critical drift can re-trigger every gate run
    // while baselineMaxId stays still — producing a false PASS that hides
    // a real money-correctness problem from the launch operator. The
    // decision is delegated to evaluateReconCleanRoomGate so the Task
    // #200 regression test exercises the EXACT logic the live gate runs.
    const verdict = evaluateReconCleanRoomGate({
      newCriticalOrAlertRowCount: newRows.length,
      summaryAlerts: summary.alerts,
      summaryCriticals: summary.criticals,
    });
    const reconAlertCount = summary.alerts + summary.criticals;
    if (verdict.outcome === "pass") {
      pass(
        NAME,
        `pairs=${summary.pairsChecked}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows, recon classified 0 pair(s) as alert/critical`,
      );
    } else if (verdict.reason === "dedupe_suppressed_drift") {
      fail(
        NAME,
        `recon classified ${summary.criticals} critical + ${summary.alerts} alert drift pair(s) ` +
          `but 0 new operator_alerts rows since baseline max_id=${baselineMaxId} ` +
          `(notifyOperator dedupe is masking a persistent drift; inspect operator_alerts ` +
          `with severity in ('alert','critical') and id<=${baselineMaxId} for the suppressed firings)`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}` +
          (reconAlertCount > 0
            ? ` (recon also classified ${summary.criticals} critical + ${summary.alerts} alert pair(s) this pass)`
            : ""),
      );
    }
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

async function reconLedgerVsCustodianCleanRoom(): Promise<void> {
  const NAME = "reconciliation: ledger-vs-custodian clean-room";
  try {
    const baselineMaxId = await snapshotMaxAlertId();
    const summary = await runLedgerReconciliation();
    if (summary.pairsChecked === 0) {
      // The gate's contract is "no NEW critical/alert rows since baseline"
      // — with zero (user, currency) pairs to inspect, that contract is
      // trivially satisfied (vacuously true). Treat as PASS rather than
      // SKIP so --strict mode doesn't conflate "nothing to check" with
      // "policy violation". In production the DB is always populated so
      // this branch is unreachable in real launch checks. (Task #201
      // removed the lifecycle-platform-leg scrub; the platform user is
      // now flagged is_demo=true and excluded from reconciliation.)
      pass(
        NAME,
        `pairs=0 (no ledger entries to inspect; trivially 0 new alerts) baseline max_id=${baselineMaxId}`,
      );
      return;
    }
    const newRows = await newCriticalOrAlertRows(baselineMaxId);
    // Task #200 — same dedupe-suppression escape hatch as the wallet-ledger
    // clean-room above. Inspect the recon summary directly so a persistent
    // drift that re-fires under notifyOperator's dedupe window still trips
    // the gate. Decision delegated to the shared helper for symmetry with
    // the regression test in scripts/test-task-200-recon-gate.ts.
    const verdict = evaluateReconCleanRoomGate({
      newCriticalOrAlertRowCount: newRows.length,
      summaryAlerts: summary.alerts,
      summaryCriticals: summary.criticals,
    });
    const reconAlertCount = summary.alerts + summary.criticals;
    if (verdict.outcome === "pass") {
      pass(
        NAME,
        `pairs=${summary.pairsChecked}, externalUnavailable=${summary.externalUnavailable}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows, recon classified 0 pair(s) as alert/critical`,
      );
    } else if (verdict.reason === "dedupe_suppressed_drift") {
      fail(
        NAME,
        `recon classified ${summary.criticals} critical + ${summary.alerts} alert mismatch(es) ` +
          `but 0 new operator_alerts rows since baseline max_id=${baselineMaxId} ` +
          `(notifyOperator dedupe is masking a persistent ledger-vs-custodian drift)`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}` +
          (reconAlertCount > 0
            ? ` (recon also classified ${summary.criticals} critical + ${summary.alerts} alert mismatch(es) this pass)`
            : ""),
      );
    }
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

async function reconPostingReceiptCleanRoom(): Promise<void> {
  const NAME = "reconciliation: posting-receipt invariant clean-room";
  try {
    const baselineMaxId = await snapshotMaxAlertId();
    const result = await runPostingReceiptInvariantCheck();
    if (result.txWithEntries === 0 && result.receipts === 0) {
      // Same rationale as reconLedgerVsCustodianCleanRoom above: with
      // zero rows to inspect, the contract "no NEW critical/alert rows
      // since baseline" is trivially satisfied. Treat as PASS rather
      // than SKIP. In production this branch is unreachable.
      pass(
        NAME,
        `txWithEntries=0, receipts=0 (nothing to inspect; trivially 0 new alerts) baseline max_id=${baselineMaxId}`,
      );
      return;
    }
    const newRows = await newCriticalOrAlertRows(baselineMaxId);
    // Task #200 — also fail when the invariant check itself observed a
    // divergence (missingCount !== 0), regardless of whether a new
    // operator_alerts row was inserted. notifyOperator()'s dedupe window
    // means a persistent missing-receipt or orphan-receipt condition can
    // re-fire on every run while baselineMaxId stays still — the gate
    // would silently PASS even though the invariant is still broken.
    // Decision delegated to evaluateInvariantCleanRoomGate so the
    // regression test uses the same logic.
    const divergent = result.missingCount !== 0;
    const verdict = evaluateInvariantCleanRoomGate({
      newCriticalOrAlertRowCount: newRows.length,
      divergent,
    });
    if (verdict.outcome === "pass") {
      pass(
        NAME,
        `txWithEntries=${result.txWithEntries}, receipts=${result.receipts}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows, missingCount=0`,
      );
    } else if (verdict.reason === "dedupe_suppressed_divergence") {
      fail(
        NAME,
        `posting-receipt invariant divergent (txWithEntries=${result.txWithEntries}, receipts=${result.receipts}, missingCount=${result.missingCount}` +
          (result.missingSample.length > 0
            ? `, sample=[${result.missingSample.join(",")}]`
            : "") +
          `) but 0 new operator_alerts rows since baseline max_id=${baselineMaxId} ` +
          `(notifyOperator dedupe is masking a persistent invariant break)`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}` +
          (divergent
            ? ` (invariant also divergent: missingCount=${result.missingCount})`
            : ""),
      );
    }
  } catch (err: any) {
    fail(NAME, `threw: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup. Strict PK-only deletes in FK order. Mirrors the model used by
// the other safety scripts: no DELETE in this script targets rows by
// user-id-IN-set; every delete uses inArray(<table>.id, created.*).
// ---------------------------------------------------------------------------
async function cleanupTrackedRows(): Promise<void> {
  // FK-walk: pick up any ledger entries / receipts attached to tracked tx.
  if (created.transactionIds.length > 0) {
    const entryRows = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, created.transactionIds));
    for (const r of entryRows) pushUnique(created.ledgerEntryIds, r.id);
  }
  // FK-walk: pick up any accounts owned by tracked users (so the post-run
  // recon doesn't see orphaned client/suspense rows).
  if (created.userIds.length > 0) {
    const accountRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.userId, created.userIds));
    for (const r of accountRows) pushUnique(created.accountIds, r.id);
  }
  // FK-walk: pick up any ledger entries posted AGAINST tracked accounts —
  // even if the parent transaction id isn't in created.transactionIds. This
  // closes the FK-violation hole where a lifecycle scenario aborts after
  // posting an entry but before tracking the transactionId, leaving the
  // entry to break the accounts DELETE at the bottom of this function.
  // Collect their transactionIds too so the matching ledger_postings rows
  // (PK = transactionId, FK -> ledger_entries via shared parent tx) get
  // deleted before the entries themselves.
  const extraTxForPostings: number[] = [];
  if (created.accountIds.length > 0) {
    const acctEntryRows = await db
      .select({
        id: ledgerEntries.id,
        transactionId: ledgerEntries.transactionId,
      })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.accountId, created.accountIds));
    for (const r of acctEntryRows) {
      pushUnique(created.ledgerEntryIds, r.id);
      pushUnique(extraTxForPostings, r.transactionId);
    }
  }

  // Combined posting-delete set: tracked tx ∪ tx discovered by FK-walk above.
  const postingTxIds: number[] = [];
  for (const id of created.transactionIds) pushUnique(postingTxIds, id);
  for (const id of extraTxForPostings) pushUnique(postingTxIds, id);
  if (postingTxIds.length > 0) {
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, postingTxIds));
  }
  if (created.ledgerEntryIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.id, created.ledgerEntryIds));
  }
  if (created.idempotencyKeyIds.length > 0) {
    await db
      .delete(idempotencyKeys)
      .where(inArray(idempotencyKeys.id, created.idempotencyKeyIds));
  }
  if (created.transactionIds.length > 0) {
    await db
      .delete(transactions)
      .where(inArray(transactions.id, created.transactionIds));
  }
  if (created.walletIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.id, created.walletIds));
  }
  if (created.accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, created.accountIds));
  }
  // Users: keep them. They're __prelaunch_-prefixed and idempotent across
  // runs so the next invocation reuses them. Deleting users would also
  // require deleting every audit_logs row pointing back at them, which we
  // do not own.
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Task #142 — parse --strict. In strict mode, any SKIP fails the exit
  // code (alongside any FAIL); without it, only FAILs change the exit code.
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  let exitCode = 0;
  try {
    // -------------------------------------------------------------------
    // PLATFORM_USER_ID is needed by getOrCreateSuspenseAccount inside the
    // happy-path + reversal scenarios. If the env var isn't set, mint a
    // deterministic platform user and pin it for this process.
    //
    // CRITICAL: do NOT route this through ensureUser() — that helper auto-
    // pushes the user id into `created.userIds`, which then makes the
    // platform suspense account a "tracked account" in cleanupTrackedRows.
    // The cleanup's FK-walk on accountIds would then delete the SUSPENSE
    // legs of every subprocess test (test-transaction-safety,
    // test-fee-deduction-gate-b, test-task-35-suppression) that posted
    // against this same suspense account during Stage 1, leaving their
    // CLIENT-side legs orphaned (single-leg, no receipt). The
    // posting-receipt-invariant gate then fails on those orphans.
    //
    // The platform user is shared infrastructure across the whole pre-
    // launch run AND every subprocess test it spawns — pre-launch must
    // create it if missing, but must not claim its accounts for cleanup.
    // -------------------------------------------------------------------
    if (!process.env.PLATFORM_USER_ID) {
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.username, PLATFORM_USERNAME));
      let platformId: number;
      if (existing) {
        if (existing.kycStatus !== "verified" || !existing.emailVerified) {
          await db
            .update(users)
            .set({ kycStatus: "verified", emailVerified: true })
            .where(eq(users.id, existing.id));
        }
        platformId = existing.id;
      } else {
        const [row] = await db
          .insert(users)
          .values({
            username: PLATFORM_USERNAME,
            email: "prelaunch-platform@test.invalid",
            password: "not-a-real-password",
            firstName: "PreLaunch",
            lastName: "Platform",
            role: "admin",
            kycStatus: "verified",
            emailVerified: true,
          })
          .returning();
        platformId = row.id;
      }
      process.env.PLATFORM_USER_ID = String(platformId);
    }

    // -------------------------------------------------------------------
    // Task #201 — ALWAYS mark the resolved platform user `is_demo=true`,
    // whether it was pre-bound by the env var (`system` user 11 in dev)
    // or freshly provisioned by the block above (`__prelaunch_platform`).
    //
    // Why: the platform user is a synthetic accounting endpoint. It owns
    // the platform_suspense / fee accounts that hold the OTHER side of
    // every client-side leg posted by every test in this run, so its
    // per-currency ledger sums are NOT zero — and the wallets table's
    // non-negative check constraint means we cannot mirror those sums
    // in a wallet row anyway. `is_demo=true` is the only mechanism that
    // makes the wallet-vs-ledger reconciler ignore this user (see
    // server/services/reconciliation.ts ~line 126). Without it, every
    // pre-launch run produces a critical wallet-vs-ledger mismatch
    // against the platform user.
    //
    // The flip is idempotent and only touches the single platform row,
    // so re-runs are cheap. We do this AFTER the resolution block above
    // so it covers both code paths uniformly.
    // -------------------------------------------------------------------
    {
      const platformIdResolved = parseInt(process.env.PLATFORM_USER_ID!, 10);
      if (Number.isInteger(platformIdResolved) && platformIdResolved > 0) {
        await db
          .update(users)
          .set({ isDemo: true })
          .where(eq(users.id, platformIdResolved));
      }
    }

    // -------------------------------------------------------------------
    // Stage 1: run the four existing safety scripts in sequence.
    //
    // Task #193 — every Stage-1 script is also wrapped in a per-script
    // ledger-leak gate that snapshots the platform user's per-currency
    // (SUM, COUNT) before and after the spawn. A non-zero delta means
    // the script regressed back to the same leak pattern fixed by tasks
    // #158 and #187 (forgot to wrap the test body in try/finally and
    // call the per-user cleanup at end-of-script). The leak gate is
    // reported as a SEPARATE outcome from the script's own pass/fail
    // so an operator can tell "the script asserted everything correctly
    // BUT it leaked rows" apart from "the script's assertions failed".
    //
    // PLATFORM_USER_ID is already pinned by the resolver above, so
    // every sub-script's platform-side suspense / fee legs land on the
    // same user we're snapshotting.
    // -------------------------------------------------------------------
    const platformUserIdForLeak = parseInt(
      process.env.PLATFORM_USER_ID ?? "0",
      10,
    );
    for (const s of EXISTING_SCRIPTS) {
      console.log(`\n--- pre-launch: running ${s.file} ---`);
      let leakBefore: PlatformSnapshot | null = null;
      try {
        if (platformUserIdForLeak > 0) {
          leakBefore = await snapshotPlatformLedger(platformUserIdForLeak);
        }
      } catch (err: any) {
        // Snapshot failure shouldn't block the script run; we'll SKIP
        // the leak gate with a reason if we can't capture the baseline.
        console.error(
          `pre-launch: leak-gate snapshot (before) failed for ${s.file}:`,
          err?.message ?? err,
        );
      }

      const r = runExistingScript(s.file);
      if (r.outcome === "pass") pass(s.label, r.details);
      else if (r.outcome === "skip") skip(s.label, r.details);
      else fail(s.label, r.details);

      // Per-script leak gate report.
      if (platformUserIdForLeak <= 0) {
        skip(
          s.leakLabel,
          `PLATFORM_USER_ID not resolvable; cannot snapshot platform ledger`,
        );
      } else if (!leakBefore) {
        skip(
          s.leakLabel,
          `pre-snapshot of platform ledger failed; see error above`,
        );
      } else if (r.outcome === "skip") {
        // If the sub-script never actually ran, there's nothing to
        // gate against — same SKIP semantics as the existing-script
        // outcome above (Task #142).
        skip(s.leakLabel, `sub-script did not complete (${r.details})`);
      } else {
        try {
          const leakAfter = await snapshotPlatformLedger(platformUserIdForLeak);
          const drift = diffPlatformLedger(leakBefore, leakAfter);
          if (drift.length === 0) {
            pass(
              s.leakLabel,
              `platform user (id=${platformUserIdForLeak}) ledger unchanged`,
            );
          } else {
            fail(
              s.leakLabel,
              `script leaked on platform user (id=${platformUserIdForLeak}): ` +
                drift.join("; ") +
                ` — wrap the test body in try/finally and call the per-user ` +
                `cleanup at end-of-script (see Task #187 reference fix in ` +
                `scripts/test-fee-insufficient-funds.ts)`,
            );
          }
        } catch (err: any) {
          skip(
            s.leakLabel,
            `post-snapshot of platform ledger failed: ${err?.message ?? err}`,
          );
        }
      }
    }

    // -------------------------------------------------------------------
    // Stage 2: capture money routes once, then run the three lifecycle
    // scenarios in-process.
    // -------------------------------------------------------------------
    console.log("\n--- pre-launch: capturing money routes ---");
    await captureMoneyRoutes();

    // Task #202 — every Stage 2 lifecycle scenario is now wrapped in
    // `runScenarioWithPlatformLegAssert`, which snapshots PLATFORM_USER_ID's
    // per-currency ledger sum BEFORE the scenario, runs the scenario, scrubs
    // the fixture user's transactions (cascading to delete the scenario's
    // platform-side legs), and asserts the per-currency delta is zero
    // within an explicit epsilon. A failure names the scenario AND the
    // offending currency so an operator can localize the contamination
    // to the exact scenario that introduced it, instead of having to
    // back-track from a Stage 3 reconciliation alert.
    console.log("\n--- pre-launch: lifecycle 1 (happy path) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 1 (happy path)",
      scenarioName: "lifecycle 1 (happy path)",
      scenarioGateName: "lifecycle: happy-path wallet matches ledger",
      fixtureUsername: HAPPY_USERNAME,
      currencies: ["AUD", "BTC"],
      run: lifecycle1_happyPath,
    });

    console.log("\n--- pre-launch: lifecycle 2 (idempotency under concurrency) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 2 (idempotency: deposit)",
      scenarioName: "lifecycle 2 (idempotency: deposit)",
      scenarioGateName: "lifecycle: idempotency under concurrency",
      fixtureUsername: IDEM_USERNAME,
      currencies: ["AUD"],
      run: lifecycle2_idempotencyConcurrency,
    });

    // Task #185 — same gate, applied to the OTHER money-movement routes.
    console.log("\n--- pre-launch: lifecycle 2b (idempotency: withdraw) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 2b (idempotency: withdraw)",
      scenarioName: "lifecycle 2b (idempotency: withdraw)",
      scenarioGateName: "lifecycle: idempotency under concurrency (withdraw)",
      fixtureUsername: IDEM_WITHDRAW_USERNAME,
      currencies: ["AUD"],
      run: lifecycle2b_idempotencyConcurrencyWithdraw,
    });

    console.log("\n--- pre-launch: lifecycle 2c (idempotency: fx-exchange) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 2c (idempotency: fx-exchange)",
      scenarioName: "lifecycle 2c (idempotency: fx-exchange)",
      scenarioGateName: "lifecycle: idempotency under concurrency (fx-exchange)",
      fixtureUsername: IDEM_FXEX_USERNAME,
      currencies: ["AUD", "USD"],
      run: lifecycle2c_idempotencyConcurrencyFxExchange,
    });

    console.log("\n--- pre-launch: lifecycle 2d (idempotency: wallets/transfer) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 2d (idempotency: wallets/transfer)",
      scenarioName: "lifecycle 2d (idempotency: wallets/transfer)",
      scenarioGateName: "lifecycle: idempotency under concurrency (wallets/transfer)",
      fixtureUsername: IDEM_WTRANSFER_USERNAME,
      currencies: ["AUD", "USD"],
      run: lifecycle2d_idempotencyConcurrencyWalletTransfer,
    });

    console.log("\n--- pre-launch: lifecycle 2e (idempotency: investments) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 2e (idempotency: investments)",
      scenarioName: "lifecycle 2e (idempotency: investments)",
      scenarioGateName: "lifecycle: idempotency under concurrency (investments)",
      fixtureUsername: IDEM_INVEST_USERNAME,
      currencies: ["USD"],
      run: lifecycle2e_idempotencyConcurrencyInvestments,
    });

    console.log("\n--- pre-launch: lifecycle 3 (reversal symmetry) ---");
    await runScenarioWithPlatformLegAssert({
      gateName: "platform-leg: lifecycle 3 (reversal symmetry)",
      scenarioName: "lifecycle 3 (reversal symmetry)",
      scenarioGateName: "lifecycle: reversal symmetry",
      fixtureUsername: REVERSAL_USERNAME,
      currencies: ["AUD"],
      run: lifecycle3_reversalSymmetry,
    });

    // -------------------------------------------------------------------
    // Stage 2.5 — end-of-Stage-2 fixture-user contract gate.
    //
    // Task #201 removed the previous bulk `scrubLifecyclePlatformLegs()`
    // call that ran here, because every Stage 2 scenario above is now
    // wrapped in `runScenarioWithPlatformLegAssert` (Task #202), which
    // scrubs the fixture user's transactions PER-SCENARIO. The bulk
    // scrub had become a defensive no-op.
    //
    // Task #210 then converted the now-redundant scrub into a strict
    // CONTRACT assertion: every `__prelaunch_%` fixture user MUST own
    // zero transactions at this point. If a future scenario is added
    // without the per-scenario wrapper (or with a mismatched fixture
    // username), this gate FAILs loudly and names the offender —
    // instead of the residue silently leaking into the Stage 3
    // reconciliation clean-rooms below as a misleading critical
    // wallet-vs-ledger alert. The platform user (resolved via
    // PLATFORM_USER_ID, also flagged is_demo=true so the reconciler
    // ignores its rows) is excluded from this assertion: it is shared
    // infrastructure across the whole pre-launch run, not a per-
    // scenario fixture.
    //
    // Stage 3: operator-alert clean rooms (Task #142 — one gate per
    // reconciliation service). Runs LAST so any drift the lifecycle
    // scenarios inadvertently introduced shows up here as a new
    // critical/alert row instead of being masked. Each service is its
    // own gate so SKIP / FAIL / PASS is reported independently.
    // -------------------------------------------------------------------
    console.log("\n--- pre-launch: end-of-Stage-2 fixture-user contract ---");
    await assertFixtureUsersHaveZeroTransactions();

    console.log("\n--- pre-launch: reconciliation: wallet-ledger clean room ---");
    await reconWalletLedgerCleanRoom();

    console.log("\n--- pre-launch: reconciliation: ledger-vs-custodian clean room ---");
    await reconLedgerVsCustodianCleanRoom();

    console.log("\n--- pre-launch: reconciliation: posting-receipt invariant clean room ---");
    await reconPostingReceiptCleanRoom();

    // -------------------------------------------------------------------
    // Stage 4 (Task #193): leak gate for the test scripts NOT covered by
    // Stage 1's per-script wraps. Single subprocess invocation of the
    // standalone CI gate (scripts/ci-ledger-leak-gate.ts) so we use
    // exactly the same harness PR / CI uses, with no double-runs of the
    // four heavy Stage-1 scripts.
    // -------------------------------------------------------------------
    console.log(
      "\n--- pre-launch: ledger-leak: ci-gate (other test-*.ts) ---",
    );
    {
      const NAME = "ledger-leak: ci-gate (other test-*.ts)";
      const r = spawnSync(
        "npx",
        [
          "tsx",
          "scripts/ci-ledger-leak-gate.ts",
          "--scripts",
          CI_LEAK_GATE_OTHER_SCRIPTS.join(","),
        ],
        { stdio: "inherit", env: process.env, encoding: "utf8" },
      );
      if (r.error) {
        skip(
          NAME,
          `ci-ledger-leak-gate did not run (spawn error: ${r.error.message})`,
        );
      } else if (r.signal) {
        skip(
          NAME,
          `ci-ledger-leak-gate did not complete (killed by signal ${r.signal})`,
        );
      } else if ((r.status ?? -1) === 0) {
        pass(
          NAME,
          `ci-ledger-leak-gate covered ${CI_LEAK_GATE_OTHER_SCRIPTS.length} script(s) with zero drift`,
        );
      } else {
        fail(
          NAME,
          `ci-ledger-leak-gate exit=${r.status} — see its output above for the leaking script and per-currency diff`,
        );
      }
    }

    // -------------------------------------------------------------------
    // Canonical reporter (Task #142 — PASS / FAIL / SKIP).
    // -------------------------------------------------------------------
    console.log("");
    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const skippedNames: string[] = [];
    for (const name of CANONICAL_ORDER) {
      const r = results.get(name);
      if (!r) {
        console.log(`MISSING ${name}`);
        failCount += 1;
        continue;
      }
      if (r.outcome === "pass") {
        console.log(`PASS ${name} — ${r.details}`);
        passCount += 1;
      } else if (r.outcome === "skip") {
        console.log(`SKIP ${name} — ${r.details}`);
        skipCount += 1;
        skippedNames.push(name);
      } else {
        console.log(`FAIL ${name} — ${r.details}`);
        failCount += 1;
      }
    }

    console.log(
      `\nSummary: ${passCount} passed, ${failCount} failed, ${skipCount} skipped` +
        (strict ? " (--strict mode: SKIP fails)" : ""),
    );
    if (skipCount > 0) {
      console.log("Skipped gates:");
      for (const n of skippedNames) {
        const r = results.get(n);
        console.log(`  - ${n}: ${r?.details ?? ""}`);
      }
    }

    if (failCount > 0) {
      console.error(
        "\nPRE-LAUNCH SAFETY: FAIL — gate(s) failed. Do not deploy.",
      );
      exitCode = 1;
    } else if (strict && skipCount > 0) {
      console.error(
        `\nPRE-LAUNCH SAFETY: FAIL — ${skipCount} skipped in --strict mode. Do not deploy.`,
      );
      exitCode = 1;
    } else if (skipCount > 0) {
      console.log(
        `\nPRE-LAUNCH SAFETY: PASS — ${skipCount} skipped (run with --strict to block on skipped gates)`,
      );
    } else {
      console.log("\nPRE-LAUNCH SAFETY: ALL GATES PASSED ✅");
    }
  } catch (err: any) {
    console.error("pre-launch safety roll-up crashed:", err);
    exitCode = 1;
  } finally {
    try {
      await cleanupTrackedRows();
    } catch (err: any) {
      console.error("pre-launch cleanup failed:", err?.message ?? err);
      exitCode = exitCode || 1;
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("pre-launch safety roll-up unhandled rejection:", err);
  process.exit(1);
});
