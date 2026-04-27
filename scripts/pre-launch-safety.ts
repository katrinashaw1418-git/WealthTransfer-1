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
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
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
} from "../shared/schema";
import { signToken } from "../server/auth";
import { registerRoutes } from "../server/routes";
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
  "existing: test-fee-deduction-gate-b",
  "existing: test-wealth-planner-compliance",
  "existing: test-task-35-suppression",
  "lifecycle: happy-path wallet matches ledger",
  "lifecycle: idempotency under concurrency",
  "lifecycle: reversal symmetry",
  "reconciliation: wallet-ledger clean-room",
  "reconciliation: ledger-vs-custodian clean-room",
  "reconciliation: posting-receipt invariant clean-room",
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
const EXISTING_SCRIPTS: Array<{ label: string; file: string }> = [
  {
    label: "existing: test-transaction-safety",
    file: "scripts/test-transaction-safety.ts",
  },
  {
    label: "existing: test-fee-deduction-gate-b",
    file: "scripts/test-fee-deduction-gate-b.ts",
  },
  {
    label: "existing: test-wealth-planner-compliance",
    file: "scripts/test-wealth-planner-compliance.ts",
  },
  {
    label: "existing: test-task-35-suppression",
    file: "scripts/test-task-35-suppression.ts",
  },
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
// Deterministic test-user fixtures (idempotent across re-runs).
// All scenario users are prefixed `__prelaunch_` so cleanup never touches
// fixtures owned by other scripts (which use their own prefixes).
// ---------------------------------------------------------------------------
const PLATFORM_USERNAME = "__prelaunch_platform";
const HAPPY_USERNAME = "__prelaunch_happy_path";
const IDEM_USERNAME = "__prelaunch_idem_concurrency";
const REVERSAL_USERNAME = "__prelaunch_reversal";

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
    if (newRows.length === 0) {
      pass(
        NAME,
        `pairs=${summary.pairsChecked}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}`,
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
      skip(
        NAME,
        "no (user, currency) pairs to reconcile (no ledger entries exist)",
      );
      return;
    }
    const newRows = await newCriticalOrAlertRows(baselineMaxId);
    if (newRows.length === 0) {
      pass(
        NAME,
        `pairs=${summary.pairsChecked}, externalUnavailable=${summary.externalUnavailable}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}`,
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
      skip(
        NAME,
        "no ledger entries and no postings to compare (invariant has nothing to check)",
      );
      return;
    }
    const newRows = await newCriticalOrAlertRows(baselineMaxId);
    if (newRows.length === 0) {
      pass(
        NAME,
        `txWithEntries=${result.txWithEntries}, receipts=${result.receipts}, baseline max_id=${baselineMaxId}, 0 new critical/alert rows`,
      );
    } else {
      fail(
        NAME,
        `${newRows.length} new critical/alert row(s) since baseline max_id=${baselineMaxId}: ${summarizeAlertRows(newRows)}`,
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
    // -------------------------------------------------------------------
    if (!process.env.PLATFORM_USER_ID) {
      const platformId = await ensureUser({
        username: PLATFORM_USERNAME,
        email: "prelaunch-platform@test.invalid",
        role: "admin",
      });
      process.env.PLATFORM_USER_ID = String(platformId);
    }

    // -------------------------------------------------------------------
    // Stage 1: run the four existing safety scripts in sequence.
    // -------------------------------------------------------------------
    for (const s of EXISTING_SCRIPTS) {
      console.log(`\n--- pre-launch: running ${s.file} ---`);
      const r = runExistingScript(s.file);
      if (r.outcome === "pass") pass(s.label, r.details);
      else if (r.outcome === "skip") skip(s.label, r.details);
      else fail(s.label, r.details);
    }

    // -------------------------------------------------------------------
    // Stage 2: capture money routes once, then run the three lifecycle
    // scenarios in-process.
    // -------------------------------------------------------------------
    console.log("\n--- pre-launch: capturing money routes ---");
    await captureMoneyRoutes();

    console.log("\n--- pre-launch: lifecycle 1 (happy path) ---");
    await lifecycle1_happyPath();

    console.log("\n--- pre-launch: lifecycle 2 (idempotency under concurrency) ---");
    await lifecycle2_idempotencyConcurrency();

    console.log("\n--- pre-launch: lifecycle 3 (reversal symmetry) ---");
    await lifecycle3_reversalSymmetry();

    // -------------------------------------------------------------------
    // Stage 3: operator-alert clean rooms (Task #142 — one gate per
    // reconciliation service). Runs LAST so any drift the lifecycle
    // scenarios inadvertently introduced shows up here as a new
    // critical/alert row instead of being masked. Each service is its
    // own gate so SKIP / FAIL / PASS is reported independently.
    // -------------------------------------------------------------------
    console.log("\n--- pre-launch: reconciliation: wallet-ledger clean room ---");
    await reconWalletLedgerCleanRoom();

    console.log("\n--- pre-launch: reconciliation: ledger-vs-custodian clean room ---");
    await reconLedgerVsCustodianCleanRoom();

    console.log("\n--- pre-launch: reconciliation: posting-receipt invariant clean room ---");
    await reconPostingReceiptCleanRoom();

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
