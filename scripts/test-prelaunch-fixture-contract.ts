// =============================================================================
// END-OF-STAGE-2 FIXTURE-USER CONTRACT GATE — REGRESSION TEST (Task #213)
// =============================================================================
// Task #210 added a strict end-of-Stage-2 contract gate
// (`assertFixtureUsersHaveZeroTransactions` in scripts/pre-launch-safety.ts)
// that FAILs when any `__prelaunch_%` fixture user still owns transactions
// after Stage 2. The gate's whole reason for existing is to catch a future
// Stage 2 scenario that bypasses `runScenarioWithPlatformLegAssert` (or uses
// a mismatched fixture username). Until this script existed, only the happy
// path (PASS) was under test — meaning a future refactor that quietly turned
// the gate into a permanent PASS (e.g. accidentally widening the username
// exclusion or losing the inArray on `transactions.userId`) would go
// completely unnoticed.
//
// What this script verifies — three independent in-process invocations of
// the gate's pure helper (`scripts/lib/fixture-zero-transactions-gate.ts`):
//
//   1. FAIL path: seed one transaction owned by a fixture-prefixed user
//      that is NOT the platform user, invoke the gate, assert the result
//      is `outcome === "fail"` and that the failure message names the
//      offender username AND its non-zero transaction count.
//
//   2. SKIP path: with no fixture-prefixed users existing at all, invoke
//      the gate and assert the result is `outcome === "skip"` — NOT a
//      free PASS. (The pre-launch script's --strict mode treats SKIP as
//      blocking, so a downgrade to PASS would silently weaken the gate.)
//
//   3. Platform-exclusion path: seed one transaction owned by the
//      resolved PLATFORM_USER_ID itself (under the fixture prefix) and
//      assert the gate does NOT fail on it (PASSes because the platform
//      user is explicitly excluded by `ne(users.id, platformUserId)`).
//      A regression that drops the exclusion would surface here as a
//      FAIL even though no real per-scenario contamination occurred.
//
// To keep the gate's SQL behaviour under test (and not just our test's
// own copy of it), each case uses a UNIQUE per-case prefix wired through
// the helper's `usernamePrefix` parameter. That way the test never
// depends on the dev DB being free of the literal `__prelaunch_*` users
// the live pre-launch script may have left behind, AND each case's
// fixture is fully isolated from the others.
//
// Cleanup: every row this script creates (users, the seeded fixture
// transactions, and any rows on dependent tables that point at those
// transactions) is wiped in a try/finally per case so a re-run starts
// from a clean slate AND so the surrounding ledger-leak gates that
// already cover pre-launch don't see drift attributable to this test.
// Mirrors the cleanup style of scripts/test-platform-leg-gate.ts.
//
// Usage:
//   npx tsx scripts/test-prelaunch-fixture-contract.ts
//
// Exit code:
//   - 0 if all three cases satisfy their assertions.
//   - 1 if any assertion fails OR if cleanup throws.
// =============================================================================

import "./_bootstrap-test-env";

import { inArray } from "drizzle-orm";

import { db } from "../server/db";
import {
  ledgerEntries,
  ledgerPostings,
  transactions,
  users,
} from "../shared/schema";
import {
  assertFixtureUsersHaveZeroTransactions,
  type FixtureZeroTxGateReporter,
} from "./lib/fixture-zero-transactions-gate";

// ---------------------------------------------------------------------------
// Shared fixtures. Each case uses its own prefix + suffix so the cases are
// fully isolated from each other AND from any `__prelaunch_*` rows the
// live pre-launch script may have left in the dev DB.
// ---------------------------------------------------------------------------
const RUN_SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
const FAIL_PREFIX = `__pftest213fail_${RUN_SUFFIX}_`;
const SKIP_PREFIX = `__pftest213skip_${RUN_SUFFIX}_`;
const EXCL_PREFIX = `__pftest213excl_${RUN_SUFFIX}_`;
const GATE_NAME = "test-213: end-of-Stage-2 fixture-user contract (under test)";

// ---------------------------------------------------------------------------
// Local capturing reporter — captures pass/fail/skip outcomes so each case
// can assert on the exact result the gate emitted, without depending on
// the pre-launch script's module-level results map.
// ---------------------------------------------------------------------------
type Outcome = "pass" | "fail" | "skip";
type Result = { outcome: Outcome; details: string };

class CapturingReporter implements FixtureZeroTxGateReporter {
  readonly results = new Map<string, Result>();
  pass(name: string, details: string): void {
    this.results.set(name, { outcome: "pass", details });
  }
  fail(name: string, details: string): void {
    this.results.set(name, { outcome: "fail", details });
  }
  skip(name: string, details: string): void {
    this.results.set(name, { outcome: "skip", details });
  }
}

// ---------------------------------------------------------------------------
// Helpers — create a fixture user + a settled transaction owned by that
// user, and wipe everything we created. The transaction has no ledger
// rows of its own (we only need the row in `transactions` for the gate's
// inArray check to fire), so cleanup is a single delete per table.
// ---------------------------------------------------------------------------
async function createFixtureUser(username: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Task213",
      lastName: "FixtureContract",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning({ id: users.id });
  return row.id;
}

async function insertFixtureTx(userId: number): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      type: "deposit",
      toCurrency: "AUD",
      amount: "1.00",
      fee: "0.00",
      status: "completed",
      description: "task213 fixture-contract regression test",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanupForUserIds(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.userId, userIds));
  const txIds = txRows.map((r) => r.id);
  if (txIds.length > 0) {
    // Drop dependent rows in case any path created them — safe even if
    // there are zero matches. The fixture transactions in this test do
    // NOT post ledger rows, but the deletes are cheap insurance against
    // an aborted earlier run that did.
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, txIds));
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, txIds));
    await db.delete(transactions).where(inArray(transactions.id, txIds));
  }
  await db.delete(users).where(inArray(users.id, userIds));
}

function expectOutcome(
  caseLabel: string,
  reporter: CapturingReporter,
  expected: Outcome,
): { ok: boolean; result: Result | undefined } {
  const result = reporter.results.get(GATE_NAME);
  if (!result) {
    console.error(
      `FAIL [${caseLabel}]: gate "${GATE_NAME}" recorded no outcome at all`,
    );
    return { ok: false, result: undefined };
  }
  if (result.outcome !== expected) {
    console.error(
      `FAIL [${caseLabel}]: gate outcome = "${result.outcome}" ` +
        `(expected "${expected}"). Details: ${result.details}`,
    );
    return { ok: false, result };
  }
  console.log(
    `PASS [${caseLabel}]: gate correctly reported outcome="${expected}"`,
  );
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// CASE 1 — FAIL path. Seed one transaction owned by a fixture-prefixed
// user that is NOT the platform user. Assert the gate FAILs and names
// both the offender username and its non-zero transaction count.
// ---------------------------------------------------------------------------
async function runFailCase(): Promise<boolean> {
  const caseLabel = "FAIL path";
  const offenderUsername = `${FAIL_PREFIX}offender`;
  // Mint a SECOND fixture-prefixed user with NO transactions and use its
  // id as the gate's `platformUserId`. This way the live pre-launch
  // shape (`AND ne(users.id, platformUserId)`) is exercised on a real
  // row that should be excluded — proving the FAIL still fires on the
  // OTHER (offender) row rather than being masked by the exclusion.
  const platformUsername = `${FAIL_PREFIX}platform`;
  let offenderUserId: number | null = null;
  let platformUserId: number | null = null;
  let ok = true;
  try {
    platformUserId = await createFixtureUser(platformUsername);
    offenderUserId = await createFixtureUser(offenderUsername);
    await insertFixtureTx(offenderUserId);

    const reporter = new CapturingReporter();
    await assertFixtureUsersHaveZeroTransactions({
      gateName: GATE_NAME,
      usernamePrefix: FAIL_PREFIX,
      platformUserId,
      reporter,
      db,
    });

    const expectation = expectOutcome(caseLabel, reporter, "fail");
    ok = expectation.ok;
    if (ok && expectation.result) {
      const details = expectation.result.details;
      if (!details.includes(offenderUsername)) {
        console.error(
          `FAIL [${caseLabel}]: failure message does NOT name the offender ` +
            `username "${offenderUsername}". Details: ${details}`,
        );
        ok = false;
      } else {
        console.log(
          `PASS [${caseLabel}]: failure message names the offender username`,
        );
      }
      if (!details.includes(`${offenderUsername}=1`)) {
        console.error(
          `FAIL [${caseLabel}]: failure message does NOT name the offender's ` +
            `non-zero transaction count (expected substring "${offenderUsername}=1"). ` +
            `Details: ${details}`,
        );
        ok = false;
      } else {
        console.log(
          `PASS [${caseLabel}]: failure message names the offender's tx count`,
        );
      }
    }
  } finally {
    const ids: number[] = [];
    if (offenderUserId != null) ids.push(offenderUserId);
    if (platformUserId != null) ids.push(platformUserId);
    if (ids.length > 0) await cleanupForUserIds(ids);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// CASE 2 — SKIP path. Don't create any users under SKIP_PREFIX. Invoke
// the gate and assert it reports SKIP (not PASS), so --strict mode in
// the pre-launch caller treats it as unverified.
// ---------------------------------------------------------------------------
async function runSkipCase(): Promise<boolean> {
  const caseLabel = "SKIP path";
  const reporter = new CapturingReporter();
  await assertFixtureUsersHaveZeroTransactions({
    gateName: GATE_NAME,
    usernamePrefix: SKIP_PREFIX,
    platformUserId: 0,
    reporter,
    db,
  });
  return expectOutcome(caseLabel, reporter, "skip").ok;
}

// ---------------------------------------------------------------------------
// CASE 3 — Platform-exclusion path. Create a user under EXCL_PREFIX and
// give it a transaction. Pass that user's id as `platformUserId`. The
// gate must EXCLUDE it from the prefix match — so the only fixture user
// matching the prefix is excluded, no fixture users remain to verify,
// and the gate reports SKIP rather than FAIL. (A regression that
// dropped `ne(users.id, platformUserId)` would surface here as a FAIL.)
// ---------------------------------------------------------------------------
async function runPlatformExclusionCase(): Promise<boolean> {
  const caseLabel = "platform-exclusion path";
  const platformUsername = `${EXCL_PREFIX}platform`;
  let platformId: number | null = null;
  let ok = true;
  try {
    platformId = await createFixtureUser(platformUsername);
    await insertFixtureTx(platformId);

    const reporter = new CapturingReporter();
    await assertFixtureUsersHaveZeroTransactions({
      gateName: GATE_NAME,
      usernamePrefix: EXCL_PREFIX,
      platformUserId: platformId,
      reporter,
      db,
    });

    // The only user matching EXCL_PREFIX is excluded as the platform
    // user, so the gate has nothing to verify and must SKIP. Crucially
    // it must NOT fail — that's the entire point of the exclusion.
    const expectation = expectOutcome(caseLabel, reporter, "skip");
    ok = expectation.ok;
    if (ok && expectation.result) {
      // Defence-in-depth: confirm the resolved platform id is mentioned
      // in the SKIP reason wording (so an operator reading the SKIP can
      // confirm the exclusion landed on the user they expected). The
      // helper's SKIP wording embeds the prefix; the platform id itself
      // is informational only here, so we only assert the exclusion
      // referenced the prefix.
      if (!expectation.result.details.includes(EXCL_PREFIX)) {
        console.error(
          `FAIL [${caseLabel}]: SKIP reason does NOT name the prefix ` +
            `"${EXCL_PREFIX}". Details: ${expectation.result.details}`,
        );
        ok = false;
      } else {
        console.log(
          `PASS [${caseLabel}]: SKIP reason names the prefix being matched`,
        );
      }
    }
  } finally {
    if (platformId != null) await cleanupForUserIds([platformId]);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Belt-and-braces global cleanup — wipe ANY users left under the three
// per-run prefixes, even if a case threw before its own finally fired.
// Bounded by the per-run RUN_SUFFIX so it cannot touch other tests.
// ---------------------------------------------------------------------------
async function globalCleanup(): Promise<void> {
  for (const prefix of [FAIL_PREFIX, SKIP_PREFIX, EXCL_PREFIX]) {
    // Equality on the exact known usernames is enough because each case
    // mints at most one offender + one platform user under its prefix,
    // both with deterministic per-RUN_SUFFIX suffixes. Equality avoids
    // any ESCAPE pitfalls a LIKE on the prefix would re-introduce, and
    // keeps cleanup bounded by RUN_SUFFIX so it cannot touch rows owned
    // by other tests.
    const candidateUsernames = [
      `${prefix}offender`,
      `${prefix}platform`,
    ];
    const stragglers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.username, candidateUsernames));
    if (stragglers.length > 0) {
      await cleanupForUserIds(stragglers.map((s) => s.id));
    }
  }
}

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    const failOk = await runFailCase();
    const skipOk = await runSkipCase();
    const exclOk = await runPlatformExclusionCase();
    if (!failOk || !skipOk || !exclOk) exitCode = 1;
  } catch (err: any) {
    console.error(`task213: unexpected error:`, err?.stack ?? err);
    exitCode = 1;
  } finally {
    try {
      await globalCleanup();
    } catch (cleanupErr: any) {
      console.error(
        `task213: cleanup failed:`,
        cleanupErr?.stack ?? cleanupErr,
      );
      exitCode = exitCode || 1;
    }
  }

  if (exitCode === 0) {
    console.log(
      `\nfixture-contract gate regression test: PASS — gate correctly ` +
        `catches FAIL, SKIP and platform-exclusion paths`,
    );
  } else {
    console.error(
      `\nfixture-contract gate regression test: FAIL — see assertions above`,
    );
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`task213: unhandled rejection:`, err);
  process.exit(1);
});
