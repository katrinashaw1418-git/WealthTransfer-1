// =============================================================================
// PLATFORM-LEG GATE — FAILURE-PATH REGRESSION TEST (Task #209)
// =============================================================================
// Task #202 added a per-scenario "platform-leg invariant" gate that snapshots
// PLATFORM_USER_ID's per-currency ledger sum BEFORE each Stage 2 lifecycle
// scenario, scrubs the fixture user's transactions (cascading to delete the
// scenario's platform-side legs), then asserts the AFTER sum equals the
// BEFORE sum (within PLATFORM_LEG_EPSILON). The forward path is verified —
// every clean run reports the seven new gates as PASS.
//
// What this script verifies — the FAILURE path. We deliberately inject a
// platform-user ledger entry under a transaction NOT owned by the gate's
// fixture user (the exact regression pattern this gate exists to catch),
// run `assertPlatformLegInvariantAndScrub` against it, and assert that:
//
//   1. The gate's reporter records the gate name with `outcome === "fail"`.
//   2. The failure message names the offending currency (so an operator
//      can grep the scenario for the bad write in seconds).
//
// Without this script, a future refactor that silently broke the
// scrub-or-assert plumbing (e.g. the scrub accidentally widening to
// "everything but the fixture user", or the AFTER snapshot reading the
// BEFORE map) would still report PASS in CI and the gate would go
// quietly dead.
//
// Cleanup: every row this script creates (users, accounts, wallets, the
// contamination transaction, and its ledger entries) is wiped in a
// try/finally so a re-run starts from a clean slate and no row leaks
// between this test and the rest of pre-launch / CI. Mirrors the
// cleanup style of scripts/test-fee-insufficient-funds.ts.
//
// Usage:
//   npx tsx scripts/test-platform-leg-gate.ts
//
// Exit code:
//   - 0 if both assertions pass (gate correctly reports FAIL with currency).
//   - 1 if either assertion fails OR if cleanup throws.
// =============================================================================

import "./_bootstrap-test-env";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "../server/db";
import {
  users,
  accounts,
  wallets,
  transactions,
  ledgerEntries,
  ledgerPostings,
} from "../shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  getUserCurrencyBalance,
  postLedgerEntries,
} from "../server/services/ledger";
import {
  assertPlatformLegInvariantAndScrub,
  snapshotPlatformPerCurrency,
  type PlatformLegGateReporter,
} from "./lib/platform-leg-gate";

// ---------------------------------------------------------------------------
// Fixtures — deterministic `__pgate209_` prefix so cleanup never touches a
// row owned by another script and re-runs are idempotent.
// ---------------------------------------------------------------------------
const PLATFORM_USERNAME_FALLBACK = "__pgate209_platform";
const FIXTURE_USERNAME = "__pgate209_fixture";
const CONTAMINATION_USERNAME = "__pgate209_contam";
const TEST_CURRENCY = "AUD";
// A loud, non-round amount makes it obvious in logs that this drift came
// from THIS script and not background noise.
const CONTAMINATION_AMOUNT = "7.77777";
const GATE_NAME = "platform-leg: regression test (deliberate contamination)";
const SCENARIO_NAME = "regression-test-deliberate-contamination";

// ---------------------------------------------------------------------------
// Resolve the platform user. PLATFORM_USER_ID is required by
// getOrCreateSuspenseAccount inside the ledger service, so if the env var
// isn't set, mint a deterministic platform user (mirrors the resolver in
// scripts/pre-launch-safety.ts) and pin it for this process.
// ---------------------------------------------------------------------------
async function resolvePlatformUserId(): Promise<number> {
  if (process.env.PLATFORM_USER_ID) {
    const parsed = parseInt(process.env.PLATFORM_USER_ID, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, PLATFORM_USERNAME_FALLBACK));
  let id: number;
  if (existing) {
    id = existing.id;
  } else {
    const [row] = await db
      .insert(users)
      .values({
        username: PLATFORM_USERNAME_FALLBACK,
        email: "pgate209-platform@test.invalid",
        password: "not-a-real-password",
        firstName: "PGate209",
        lastName: "Platform",
        role: "admin",
        kycStatus: "verified",
        emailVerified: true,
      })
      .returning();
    id = row.id;
  }
  // Mark is_demo so the wallet-vs-ledger reconciler ignores this user (the
  // platform user holds non-zero suspense balances by design and the wallets
  // table's non-negative check constraint can't mirror them anyway).
  await db
    .update(users)
    .set({ isDemo: true })
    .where(eq(users.id, id));
  process.env.PLATFORM_USER_ID = String(id);
  return id;
}

async function ensureUser(username: string, email: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));
  if (existing) return existing.id;
  const [row] = await db
    .insert(users)
    .values({
      username,
      email,
      password: "not-a-real-password",
      firstName: "PGate209",
      lastName: "Test",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return row.id;
}

// ---------------------------------------------------------------------------
// Cleanup — wipe everything this script created on the fixture and
// contamination users. FK chain mirrors test-fee-insufficient-funds.ts:
// drop ledger entries / postings keyed by transaction, then transactions,
// then wallets / accounts. Users themselves are kept so re-runs reuse them.
// ---------------------------------------------------------------------------
async function cleanupForUserIds(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.userId, userIds));
  const txIds = txRows.map((r) => r.id);
  if (txIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, txIds));
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, txIds));
    await db.delete(transactions).where(inArray(transactions.id, txIds));
  }
  // Also drop any stray ledger entries pointing at accounts owned by these
  // users (defensive — postLedgerEntries always writes via a transaction
  // we just dropped, but a partial run could orphan rows).
  const acctRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.userId, userIds));
  const acctIds = acctRows.map((r) => r.id);
  if (acctIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.accountId, acctIds));
    await db.delete(accounts).where(inArray(accounts.id, acctIds));
  }
  await db.delete(wallets).where(inArray(wallets.userId, userIds));
}

// ---------------------------------------------------------------------------
// Inject contamination — the exact regression pattern this gate exists to
// catch. We post a balanced AUD pair under a transaction owned by the
// CONTAMINATION user. One leg lands on the platform user's suspense
// account; the other on the contamination user's client account. The
// per-currency credit==debit check inside postLedgerEntries passes, so
// this is a "valid" posting from the ledger primitive's point of view —
// which is the whole point: the bug pattern looks valid until you check
// per-scenario platform-leg invariance, which is exactly what the gate
// does.
//
// Returns the transaction id and the platform-side delta amount (negative
// because the platform leg is a debit) so the caller can verify the gate's
// drift detection landed on the right currency.
// ---------------------------------------------------------------------------
async function injectContamination(
  contaminationUserId: number,
): Promise<{ transactionId: number }> {
  return await db.transaction(async (tx) => {
    const [txRow] = await (tx as any)
      .insert(transactions)
      .values({
        userId: contaminationUserId,
        type: "deposit",
        toCurrency: TEST_CURRENCY,
        amount: CONTAMINATION_AMOUNT,
        fee: "0",
        status: "completed",
        description: "platform-leg gate regression test (deliberate)",
      })
      .returning();

    const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY, tx);
    const clientAccount = await getOrCreateClientAccount(
      contaminationUserId,
      TEST_CURRENCY,
      tx,
    );

    await postLedgerEntries(
      txRow.id,
      [
        {
          accountId: suspense.id,
          userId: suspense.userId,
          currency: TEST_CURRENCY,
          direction: "debit",
          amount: CONTAMINATION_AMOUNT,
          description: "pgate209: platform-side debit (contamination)",
        },
        {
          accountId: clientAccount.id,
          userId: contaminationUserId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount: CONTAMINATION_AMOUNT,
          description: "pgate209: contamination-user credit (other leg)",
        },
      ],
      tx,
    );

    return { transactionId: txRow.id };
  });
}

// ---------------------------------------------------------------------------
// Local reporter — captures the gate's outcome so we can assert on it
// without needing the pre-launch script's module-level `results` map.
// Same shape (pass/fail/skip) as PlatformLegGateReporter.
// ---------------------------------------------------------------------------
type Outcome = "pass" | "fail" | "skip";
type Result = { outcome: Outcome; details: string };

class CapturingReporter implements PlatformLegGateReporter {
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

async function main(): Promise<void> {
  let exitCode = 0;
  let fixtureUserId: number | null = null;
  let contaminationUserId: number | null = null;

  try {
    const platformUserId = await resolvePlatformUserId();

    fixtureUserId = await ensureUser(
      FIXTURE_USERNAME,
      "pgate209-fixture@test.invalid",
    );
    contaminationUserId = await ensureUser(
      CONTAMINATION_USERNAME,
      "pgate209-contam@test.invalid",
    );

    // Start from a clean slate so a previous aborted run can't pollute
    // our snapshot baseline.
    await cleanupForUserIds([fixtureUserId, contaminationUserId]);

    // Snapshot platform user's AUD balance BEFORE we contaminate.
    const baseline = await snapshotPlatformPerCurrency(
      platformUserId,
      [TEST_CURRENCY],
      getUserCurrencyBalance,
    );
    console.log(
      `pgate209: baseline platform AUD balance = ${baseline.get(TEST_CURRENCY) ?? "0"}`,
    );

    // Inject the contamination — a platform-side leg under a tx owned by
    // the CONTAMINATION user (not the fixture user the gate will scrub).
    const { transactionId } = await injectContamination(contaminationUserId);
    console.log(
      `pgate209: injected contamination tx#${transactionId} owned by user ${contaminationUserId} ` +
        `(NOT fixture user "${FIXTURE_USERNAME}"); platform-side leg debits suspense ${CONTAMINATION_AMOUNT} ${TEST_CURRENCY}`,
    );

    // Run the gate. Its scrub targets the fixture user's transactions —
    // which are zero, because we put the contamination on the contamination
    // user. So the AFTER snapshot still shows the drift, and the gate must
    // FAIL with the offending currency named.
    const reporter = new CapturingReporter();
    await assertPlatformLegInvariantAndScrub({
      gateName: GATE_NAME,
      scenarioName: SCENARIO_NAME,
      fixtureUsername: FIXTURE_USERNAME,
      currencies: [TEST_CURRENCY],
      baseline,
      platformUserId,
      baselineCaptured: true,
      baselineError: null,
      reporter,
      lookupFixtureUserId: async (username) => {
        const [row] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, username));
        return row?.id ?? null;
      },
      // Same scrub shape as pre-launch (drop the fixture user's
      // transactions and their ledger entries). For our test fixture
      // this is a no-op — by construction the fixture user has no
      // transactions — but we run the real scrub so the test exercises
      // the same code path the live gate runs.
      scrubFixture: async (uid) => {
        await cleanupForUserIds([uid]);
      },
      getBalance: getUserCurrencyBalance,
    });

    // ---------------------------------------------------------------------
    // Assertion 1: the gate flipped to "fail" for our gate name.
    // ---------------------------------------------------------------------
    const result = reporter.results.get(GATE_NAME);
    if (!result) {
      console.error(
        `FAIL: gate "${GATE_NAME}" did not record any outcome (no entry in reporter map)`,
      );
      exitCode = 1;
    } else if (result.outcome !== "fail") {
      console.error(
        `FAIL: gate outcome = ${result.outcome} (expected "fail"). Details: ${result.details}`,
      );
      exitCode = 1;
    } else {
      console.log(
        `PASS: gate correctly reported outcome="fail" for deliberate contamination`,
      );
    }

    // ---------------------------------------------------------------------
    // Assertion 2: the failure message names the offending currency.
    // The gate's wording (see scripts/lib/platform-leg-gate.ts) embeds
    // the currency in the per-currency drift line, so a substring match
    // on `TEST_CURRENCY` is the right shape.
    // ---------------------------------------------------------------------
    if (result?.outcome === "fail") {
      if (result.details.includes(TEST_CURRENCY)) {
        console.log(
          `PASS: failure message names the offending currency "${TEST_CURRENCY}"`,
        );
      } else {
        console.error(
          `FAIL: failure message does NOT name the offending currency "${TEST_CURRENCY}". Details: ${result.details}`,
        );
        exitCode = 1;
      }
      // Belt-and-braces: the message must also mention the scenario name
      // so an operator looking at the failure can grep the scenario's
      // source. The gate wording embeds it via "scenario \"<name>\"".
      if (result.details.includes(SCENARIO_NAME)) {
        console.log(
          `PASS: failure message names the offending scenario "${SCENARIO_NAME}"`,
        );
      } else {
        console.error(
          `FAIL: failure message does NOT name the offending scenario "${SCENARIO_NAME}". Details: ${result.details}`,
        );
        exitCode = 1;
      }
    }
  } catch (err: any) {
    console.error(`pgate209: unexpected error:`, err?.stack ?? err);
    exitCode = 1;
  } finally {
    // try/finally cleanup so a re-run starts clean even if an assertion
    // threw mid-flight. Only touches the deterministic __pgate209_* users.
    try {
      const userIds: number[] = [];
      if (fixtureUserId != null) userIds.push(fixtureUserId);
      if (contaminationUserId != null) userIds.push(contaminationUserId);
      await cleanupForUserIds(userIds);
    } catch (cleanupErr: any) {
      console.error(`pgate209: cleanup failed:`, cleanupErr?.stack ?? cleanupErr);
      exitCode = exitCode || 1;
    }
  }

  if (exitCode === 0) {
    console.log(
      `\nplatform-leg gate regression test: PASS — gate correctly catches deliberate contamination`,
    );
  } else {
    console.error(
      `\nplatform-leg gate regression test: FAIL — gate did NOT catch the contamination as expected`,
    );
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`pgate209: unhandled rejection:`, err);
  process.exit(1);
});
