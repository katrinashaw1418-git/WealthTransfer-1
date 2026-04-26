// =============================================================================
// FEE DEDUCTION GATE B — VERIFICATION ROLL-UP (Task #92)
// =============================================================================
// Single-shot, re-runnable script that proves the entire fee-deduction Gate B
// safety surface end-to-end. This is the verification gate — if any assertion
// fails, fee-deduction work must NOT proceed (and any in-flight follow-on
// task that depends on Gate B should be paused).
//
// Each assertion is a hard PASS/FAIL with concrete evidence (row counts,
// status values, ledger sums). The 10 assertions, in canonical order, are:
//
//   1. non-admin cannot deduct
//        — A non-admin role hitting POST /api/admin/fee-deductions/:id/approve
//          via the actual route handler (mock req/res) gets 403, NOT a money
//          movement. Locks in `requireRole("admin")` at the route layer.
//
//   2. approved deduction posts once
//        — settleApprovedDeduction on a pending row: status='settled',
//          settledTransactionId is set, exactly one transactions row with the
//          deterministic idempotency key `fee_deduction_<id>` exists, and
//          its corresponding ledger_postings receipt row exists.
//
//   3. duplicate deduction blocked
//        — A second settleApprovedDeduction call on the same row is the
//          idempotent fast-path: returns the existing settled row and does
//          NOT create a second transactions row, ledger entries, or
//          ledger_postings receipt.
//
//   4. expired consent blocked
//        — runDailyAccruals against a rule whose feeConsents.consentExpiryDate
//          is in the past inserts a 0-amount accrual row with
//          gateReason='consent_expired'. No deduction can ever roll up from
//          a skipped accrual.
//
//   5. withdrawn consent blocked
//        — runDailyAccruals against a rule whose feeConsents.withdrawnAt is
//          set inserts a 0-amount accrual row with gateReason='consent_withdrawn'.
//          Same cascade: no rolled-up deduction → no settlement possible.
//
//   6. insufficient ledger balance blocked
//        — settleApprovedDeduction on a row whose totalAccrued exceeds the
//          client's ledger-derived balance throws InsufficientFundsError,
//          flips the row to status='insufficient_funds' with a populated
//          failureReason, and writes ZERO transactions / ledger / receipt
//          rows for the deterministic idempotency key.
//
//   7. ledger debit created
//        — The settled deduction from #2 produced a balanced ledger triple
//          (client DEBIT totalAccrued, adviser CREDIT adviserShare, platform
//          CREDIT platformShare). The client debit specifically must equal
//          totalAccrued at 8dp.
//
//   8. reversal ledger credit created
//        — reverseSettledDeduction on the settled row: status='reversed',
//          reversalTransactionId is set, the OPPOSITE balanced triple is
//          posted against a NEW transactions row with deterministic
//          idempotency key `fee_deduction_<id>_reversal`. The client credit
//          on the reversal must equal the original totalAccrued.
//
//   9. wallet balance not directly mutated
//        — The wallets cache for both the client and the adviser must equal
//          their ledger-derived balance at every checkpoint (after top-up,
//          after settle, after reversal). Drift would mean someone wrote
//          wallets.balance directly instead of via refreshWalletCacheBalance,
//          violating the "ledger is the only writer of the wallet cache"
//          invariant.
//
//  10. reconciliation clean after post/reversal
//        — runWalletLedgerReconciliation finds no drift > MATCH_EPSILON
//          for either the client or the adviser in the test currency.
//          Status='match' on both. The full settle-then-reverse cycle
//          leaves the books exactly as it found them.
//
// Hard rules:
//   - Scoped to deterministic test users; cleans its own rows on every run
//     so re-runs are idempotent.
//   - Does NOT touch any production user, advice record, fee consent, or
//     fee rule.
//   - Exits non-zero on any FAIL so a deploy gate can rely on it.
//
// Usage:
//   npx tsx scripts/test-fee-deduction-gate-b.ts
// =============================================================================

import "./_bootstrap-test-env";
import type { Express, Request } from "express";
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  wallets,
  accounts,
  ledgerEntries,
  ledgerPostings,
  transactions,
  adviserClients,
  adviceRecords,
  feeConsents,
  adviserFeeRules,
  adviserFeeAccruals,
  adviserFeeDeductions,
  walletLedgerReconciliations,
} from "../shared/schema";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
  getUserCurrencyBalance,
} from "../server/services/ledger";
import {
  settleApprovedDeduction,
  reverseSettledDeduction,
  runDailyAccruals,
  InsufficientFundsError,
} from "../server/services/fee-engine";
import { runWalletLedgerReconciliation } from "../server/services/reconciliation";
import { runPostingReceiptInvariantCheck } from "../server/services/posting-receipt-invariant";
import { signToken } from "../server/auth";
import { registerAdminRoutes } from "../server/admin-routes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLIENT_USERNAME = "__gateb_test_client__";
const ADVISER_USERNAME = "__gateb_test_adviser__";
const CONSENT4_CLIENT_USERNAME = "__gateb_test_consent_expired_client__";
const CONSENT5_CLIENT_USERNAME = "__gateb_test_consent_withdrawn_client__";
const PLATFORM_FALLBACK_USERNAME = "__gateb_test_platform__";
const TEST_CURRENCY = "AUD";

// ---------------------------------------------------------------------------
// Result tracking — keyed by canonical name so we can print in a stable order
// regardless of execution order.
// ---------------------------------------------------------------------------
type TestResult = { passed: boolean; details: string };
// Canonical operator-facing output contract from the task spec
// (`.local/tasks/task-92.md` — "Done looks like"). The reporter prints
// EXACTLY these names in exactly this order. Do not rename, do not
// renumber, do not append details to PASS lines.
const CANONICAL_ORDER: string[] = [
  "non-admin cannot deduct",
  "approved deduction posts once",
  "duplicate deduction blocked",
  "expired consent blocked",
  "withdrawn consent blocked",
  "insufficient ledger balance blocked",
  "ledger debit created",
  "reversal ledger credit created",
  "wallet balance not directly mutated",
  "reconciliation clean after post/reversal",
];
// Internal extras: extra safety assertions added in response to architect
// + validator review. These RUN and a failure aborts the script with a
// FAIL line, but they are NOT printed in the canonical operator output
// — that contract is locked at the 10 lines above.
const INTERNAL_EXTRAS: string[] = [
  "concurrent settle race posts exactly once",
  "concurrent reverse race reverses exactly once",
  "posting-receipt invariant holds",
];
const results = new Map<string, TestResult>();

// ---------------------------------------------------------------------------
// Typed extraction helpers
// ---------------------------------------------------------------------------
// `db.execute(sql\`...\`)` returns the underlying driver row shape, which
// Drizzle types loosely. Mirrors the centralised `extractRows` helper in
// `server/services/posting-receipt-invariant.ts` so we never need an
// `as any` cast against driver result shapes anywhere in this script.
function extractCountRows(result: unknown): Array<{ n: number | string | null }> {
  const r = result as { rows?: unknown } | null | undefined;
  if (r && Array.isArray(r.rows)) {
    return r.rows as Array<{ n: number | string | null }>;
  }
  if (Array.isArray(result)) {
    return result as Array<{ n: number | string | null }>;
  }
  return [];
}

// Discriminated union for race-test results — replaces the previous
// `(r as any).raceError` access pattern. `Promise.all` over the two race
// arms gives us `RaceOutcome<T>[]`; narrowing on `.ok` is exhaustive and
// type-safe.
type RaceOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

function settleRace<T>(p: Promise<T>): Promise<RaceOutcome<T>> {
  return p.then(
    (value): RaceOutcome<T> => ({ ok: true, value }),
    (error: unknown): RaceOutcome<T> => ({ ok: false, error }),
  );
}

function record(name: string, passed: boolean, details: string): void {
  if (!CANONICAL_ORDER.includes(name) && !INTERNAL_EXTRAS.includes(name)) {
    throw new Error(`Internal: unknown test name '${name}'`);
  }
  results.set(name, { passed, details });
}
const pass = (name: string, details: string) => record(name, true, details);
const fail = (name: string, details: string) => record(name, false, details);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
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
    if (opts.role && existing.role !== opts.role) {
      await db
        .update(users)
        .set({ role: opts.role })
        .where(eq(users.id, existing.id));
    }
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: opts.username,
      email: opts.email,
      password: "not-a-real-password",
      firstName: "GateB",
      lastName: "Test",
      role: opts.role ?? "client",
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return created.id;
}

// ---------------------------------------------------------------------------
// PK tracking — strict mirror of the posting-receipt-invariant safety model.
// ---------------------------------------------------------------------------
// Cleanup deletes ONLY rows whose primary key was captured in this run.
// Two flavours of capture:
//   1. Explicit push at create time — every helper below records the PK of
//      the row it inserts into the matching `created.*` array.
//   2. Discovery via FK-walk of a tracked parent — for rows that the
//      service layer (fee-engine, ledger) writes on our behalf without
//      returning the PK (accruals, fee-engine adviser/platform accounts,
//      reconciliation report rows). Discovery happens inside
//      `cleanupTrackedRows()` BEFORE deletion: we read the children of
//      every tracked parent and capture their PKs the same way.
// Net effect: no DELETE in this script targets anything by user-id-IN-set
// (the broad pattern the architect flagged); every delete uses
// `inArray(<table>.id, created.<table>Ids)`.
// ---------------------------------------------------------------------------
const created = {
  userIds: [] as number[],
  walletIds: [] as number[],
  accountIds: [] as number[],
  adviserClientIds: [] as number[],
  adviceRecordIds: [] as number[],
  consentIds: [] as number[],
  ruleIds: [] as number[],
  accrualIds: [] as number[],
  deductionIds: [] as number[],
  transactionIds: [] as number[],
  reconciliationIds: [] as number[],
};

function pushUnique(arr: number[], id: number): void {
  if (!arr.includes(id)) arr.push(id);
}

async function ensureFreshWallet(userId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, TEST_CURRENCY)));
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
      currency: TEST_CURRENCY,
      balance: "0",
      availableBalance: "0",
      walletType: "fiat",
    })
    .returning({ id: wallets.id });
  pushUnique(created.walletIds, row.id);
}

async function ensureAdviserClientLink(
  adviserUserId: number,
  clientUserId: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (existing) {
    if (!existing.isActive) {
      await db
        .update(adviserClients)
        .set({ isActive: true, unlinkedAt: null })
        .where(eq(adviserClients.id, existing.id));
    }
    pushUnique(created.adviserClientIds, existing.id);
    return;
  }
  const [row] = await db
    .insert(adviserClients)
    .values({
      adviserUserId,
      clientUserId,
      relationshipType: "servicing",
      isActive: true,
    })
    .returning({ id: adviserClients.id });
  pushUnique(created.adviserClientIds, row.id);
}

async function makeAdviceRecord(clientUserId: number): Promise<number> {
  const [row] = await db
    .insert(adviceRecords)
    .values({ clientId: clientUserId })
    .returning({ id: adviceRecords.id });
  created.adviceRecordIds.push(row.id);
  return row.id;
}

type ConsentOverrides = {
  withdrawnAt?: Date | null;
  consentExpiryDate?: Date;
  renewalStatus?: string;
};

async function makeFeeConsent(opts: {
  clientUserId: number;
  adviserUserId: number;
  adviceRecordId: number;
  overrides?: ConsentOverrides;
}): Promise<number> {
  const now = new Date();
  const oneYearOut = new Date(now.getTime() + 365 * 86400 * 1000);
  const [row] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId: opts.adviceRecordId,
      clientId: opts.clientUserId,
      adviserId: opts.adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "100.0000",
      accountNumber: "GATEB-TEST",
      accountName: "GateB Test Account",
      deductionFrequency: "monthly",
      referenceDay: now,
      renewalWindowStart: now,
      renewalWindowEnd: oneYearOut,
      consentExpiryDate: opts.overrides?.consentExpiryDate ?? oneYearOut,
      renewalStatus: opts.overrides?.renewalStatus ?? "active",
      clientSignatureName: "GateB Test Signature",
      withdrawnAt: opts.overrides?.withdrawnAt ?? null,
    })
    .returning({ id: feeConsents.id });
  created.consentIds.push(row.id);
  return row.id;
}

async function makeFeeRule(opts: {
  feeConsentId: number;
  clientUserId: number;
  adviserUserId: number;
}): Promise<number> {
  // Direct-insert (bypass createFeeRule) because the consent-gate tests need
  // a rule against a withdrawn or expired consent — createFeeRule blocks
  // withdrawn at the service boundary, but the gate we're verifying lives
  // inside runDailyAccruals.
  const [row] = await db
    .insert(adviserFeeRules)
    .values({
      feeConsentId: opts.feeConsentId,
      clientUserId: opts.clientUserId,
      adviserUserId: opts.adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      fixedAmount: "100.0000",
      currency: TEST_CURRENCY,
      adviserSplitBps: 8000,
      platformSplitBps: 2000,
      status: "active",
    })
    .returning({ id: adviserFeeRules.id });
  created.ruleIds.push(row.id);
  return row.id;
}

async function insertPendingDeduction(opts: {
  clientUserId: number;
  adviserUserId: number;
  totalAccrued: string;
  adviserShare: string;
}): Promise<number> {
  const start = new Date(Date.UTC(2026, 3, 1));
  const end = new Date(Date.UTC(2026, 3, 30));
  const platformShare = (
    Number(opts.totalAccrued) - Number(opts.adviserShare)
  ).toFixed(4);
  const [row] = await db
    .insert(adviserFeeDeductions)
    .values({
      clientUserId: opts.clientUserId,
      adviserUserId: opts.adviserUserId,
      periodStart: start,
      periodEnd: end,
      totalAccrued: opts.totalAccrued,
      adviserShareAmount: opts.adviserShare,
      platformShareAmount: platformShare,
      currency: TEST_CURRENCY,
      accrualIds: [],
    })
    .returning({ id: adviserFeeDeductions.id });
  pushUnique(created.deductionIds, row.id);
  return row.id;
}

// Synthetic top-up: posts a balanced credit-client / debit-suspense pair so
// the client account's ledger-derived balance is positive — without touching
// any deposit handler.
async function topUpClient(userId: number, amount: string): Promise<void> {
  await db.transaction(async (tx) => {
    // No `as any` — drizzle's tx parameter is properly typed; we just need
    // to be explicit about the returning shape so the unused-property TS
    // narrowing doesn't degrade the inserted row's type.
    const [txRow] = await tx
      .insert(transactions)
      .values({
        userId,
        type: "deposit",
        fromCurrency: null,
        toCurrency: TEST_CURRENCY,
        amount,
        fee: "0",
        status: "completed",
        description: "gateb test top-up",
      })
      .returning({ id: transactions.id });
    pushUnique(created.transactionIds, txRow.id);

    const clientAccount = await getOrCreateClientAccount(
      userId,
      TEST_CURRENCY,
      tx,
    );
    pushUnique(created.accountIds, clientAccount.id);
    const suspense = await getOrCreateSuspenseAccount(TEST_CURRENCY, tx);
    // Note: suspense account has user_id = null (system-shared) so we do
    // NOT track it for cleanup. The ledger entries written against it are
    // still cleaned up via inArray on transactionIds (see cleanupTrackedRows).

    await postLedgerEntries(
      txRow.id,
      [
        {
          accountId: suspense.id,
          userId: suspense.userId,
          currency: TEST_CURRENCY,
          direction: "debit",
          amount,
          description: "gateb test top-up (suspense debit)",
        },
        {
          accountId: clientAccount.id,
          userId,
          currency: TEST_CURRENCY,
          direction: "credit",
          amount,
          description: "gateb test top-up (client credit)",
        },
      ],
      tx,
    );

    await refreshWalletCacheBalance(tx, userId, TEST_CURRENCY);
  });
}

// ---------------------------------------------------------------------------
// Cleanup — STRICT PK-only deletes mirroring the posting-receipt-invariant
// safety model. Every DELETE in this function targets `<table>.id IN
// (created.<table>Ids)`. There is no `WHERE user_id IN (...)` and no raw
// SQL with string interpolation. Rows the service layer wrote on our
// behalf without returning their PKs (accruals, fee-engine adviser/platform
// accounts, reconciliation reports) are PK-discovered up front by walking
// the FK from a tracked parent. If that walk finds nothing, we skip the
// matching delete — never broaden scope.
// FK order (children before parents):
//   fee_deductions → fee_accruals → fee_rules → fee_consents → advice_records
//   → adviser_clients → ledger_postings → ledger_entries → transactions
//   → wallet_ledger_reconciliations → wallets → accounts
// Test users themselves are intentionally NOT deleted: re-runs of this
// script find them via ensureUser() and reset their wallets to zero.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Discover PKs of rows left over from a previous run of this script. We
// look up rows by walking the FK from the deterministic test users (which
// persist across runs by design — `ensureUser()` finds them, doesn't
// recreate them). Every found PK is pushed into the tracker, so the
// SAME `cleanupTrackedRows()` PK-only delete pipeline handles BOTH
// prior-run residue AND rows we create in this run. No DELETE in the
// script is ever scoped by user_id directly — only PK arrays.
// ---------------------------------------------------------------------------
async function discoverPriorRunRows(testUserIds: number[]): Promise<void> {
  if (testUserIds.length === 0) return;

  const walletRows = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(inArray(wallets.userId, testUserIds));
  for (const r of walletRows) pushUnique(created.walletIds, r.id);

  const accountRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.userId, testUserIds));
  for (const r of accountRows) pushUnique(created.accountIds, r.id);

  const acClient = await db
    .select({ id: adviserClients.id })
    .from(adviserClients)
    .where(inArray(adviserClients.clientUserId, testUserIds));
  const acAdviser = await db
    .select({ id: adviserClients.id })
    .from(adviserClients)
    .where(inArray(adviserClients.adviserUserId, testUserIds));
  for (const r of acClient) pushUnique(created.adviserClientIds, r.id);
  for (const r of acAdviser) pushUnique(created.adviserClientIds, r.id);

  const adviceRows = await db
    .select({ id: adviceRecords.id })
    .from(adviceRecords)
    .where(inArray(adviceRecords.clientId, testUserIds));
  for (const r of adviceRows) pushUnique(created.adviceRecordIds, r.id);

  const consentRows = await db
    .select({ id: feeConsents.id })
    .from(feeConsents)
    .where(inArray(feeConsents.clientId, testUserIds));
  for (const r of consentRows) pushUnique(created.consentIds, r.id);

  const ruleRowsClient = await db
    .select({ id: adviserFeeRules.id })
    .from(adviserFeeRules)
    .where(inArray(adviserFeeRules.clientUserId, testUserIds));
  const ruleRowsAdviser = await db
    .select({ id: adviserFeeRules.id })
    .from(adviserFeeRules)
    .where(inArray(adviserFeeRules.adviserUserId, testUserIds));
  for (const r of ruleRowsClient) pushUnique(created.ruleIds, r.id);
  for (const r of ruleRowsAdviser) pushUnique(created.ruleIds, r.id);

  const dedRowsClient = await db
    .select({ id: adviserFeeDeductions.id })
    .from(adviserFeeDeductions)
    .where(inArray(adviserFeeDeductions.clientUserId, testUserIds));
  const dedRowsAdviser = await db
    .select({ id: adviserFeeDeductions.id })
    .from(adviserFeeDeductions)
    .where(inArray(adviserFeeDeductions.adviserUserId, testUserIds));
  for (const r of dedRowsClient) pushUnique(created.deductionIds, r.id);
  for (const r of dedRowsAdviser) pushUnique(created.deductionIds, r.id);

  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.userId, testUserIds));
  for (const r of txRows) pushUnique(created.transactionIds, r.id);

  // Reconciliations and accruals will be PK-discovered inside
  // cleanupTrackedRows()'s phase-1 walk (FK from tracked users / rules).
}

async function cleanupTrackedRows(): Promise<void> {
  // -------------------------------------------------------------------------
  // PHASE 1: discover PKs of rows that the service layer created on our
  // behalf, by walking the FK from each tracked parent to its children.
  // -------------------------------------------------------------------------

  // Accruals are written by `runDailyAccruals` against our tracked rules.
  if (created.ruleIds.length > 0) {
    const accrualRows = await db
      .select({ id: adviserFeeAccruals.id })
      .from(adviserFeeAccruals)
      .where(inArray(adviserFeeAccruals.feeRuleId, created.ruleIds));
    for (const r of accrualRows) pushUnique(created.accrualIds, r.id);
  }

  // The fee-engine creates per-user accounts (adviser & client) and
  // settle/reverse paths credit them. Discover via FK from tracked users.
  if (created.userIds.length > 0) {
    const accountRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.userId, created.userIds));
    for (const r of accountRows) pushUnique(created.accountIds, r.id);

    const reconRows = await db
      .select({ id: walletLedgerReconciliations.id })
      .from(walletLedgerReconciliations)
      .where(inArray(walletLedgerReconciliations.userId, created.userIds));
    for (const r of reconRows) pushUnique(created.reconciliationIds, r.id);
  }

  // -------------------------------------------------------------------------
  // PHASE 2: PK-only deletes in strict FK order. Each block is a no-op if
  // its tracker is empty.
  // -------------------------------------------------------------------------

  if (created.deductionIds.length > 0) {
    await db
      .delete(adviserFeeDeductions)
      .where(inArray(adviserFeeDeductions.id, created.deductionIds));
  }
  if (created.accrualIds.length > 0) {
    await db
      .delete(adviserFeeAccruals)
      .where(inArray(adviserFeeAccruals.id, created.accrualIds));
  }
  if (created.ruleIds.length > 0) {
    await db
      .delete(adviserFeeRules)
      .where(inArray(adviserFeeRules.id, created.ruleIds));
  }
  if (created.consentIds.length > 0) {
    await db
      .delete(feeConsents)
      .where(inArray(feeConsents.id, created.consentIds));
  }
  if (created.adviceRecordIds.length > 0) {
    await db
      .delete(adviceRecords)
      .where(inArray(adviceRecords.id, created.adviceRecordIds));
  }
  if (created.adviserClientIds.length > 0) {
    await db
      .delete(adviserClients)
      .where(inArray(adviserClients.id, created.adviserClientIds));
  }

  // ledger_postings FK to transactions(id), so by-tx-id is the right key.
  if (created.transactionIds.length > 0) {
    await db
      .delete(ledgerPostings)
      .where(inArray(ledgerPostings.transactionId, created.transactionIds));
  }
  // ledger_entries can be reached via either tracked tx or tracked account.
  // Both passes are PK-targeted (transaction_id and account_id are FK PKs
  // we collected). The two-pass form catches any entry that was written
  // against a tracked account but somehow not against a tracked tx (would
  // indicate a service-layer bug — this leaves no orphans either way).
  if (created.transactionIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, created.transactionIds));
  }
  if (created.accountIds.length > 0) {
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.accountId, created.accountIds));
  }
  if (created.transactionIds.length > 0) {
    await db
      .delete(transactions)
      .where(inArray(transactions.id, created.transactionIds));
  }
  if (created.reconciliationIds.length > 0) {
    await db
      .delete(walletLedgerReconciliations)
      .where(
        inArray(walletLedgerReconciliations.id, created.reconciliationIds),
      );
  }
  if (created.walletIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.id, created.walletIds));
  }
  if (created.accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, created.accountIds));
  }
}

// ---------------------------------------------------------------------------
// Capture the actual admin route handler so test #1 calls the same wrapper
// the production app uses — `adminRoute(...)` (auth + role + try/catch).
// ---------------------------------------------------------------------------
type CapturedHandler = (req: Request, res: any) => unknown;
const captured = new Map<string, CapturedHandler>();

// Express's `get/post/patch/delete/put` are heavily-overloaded `IRouterMatcher`
// types. Re-declaring all overloads in this script just to capture handlers
// would be both noisy and brittle (every Express minor bump risks drift).
// Instead, we type our recorder narrowly (the one signature we actually use:
// `(path, handler) => void`) and bridge to Express's IRouterMatcher with one
// `unknown`-cast per method — `unknown` is the audited TS escape hatch, no
// `any` is involved, so the type system still catches misuse INSIDE our
// recorder (wrong arg shapes etc.).
type RouteRecorder = (path: string, handler: CapturedHandler) => void;
type RouterMatcher = Express["get"]; // structurally identical to post/patch/delete/put

const makeRecorder =
  (verb: string): RouterMatcher =>
  ((path: string, handler: CapturedHandler) => {
    captured.set(`${verb} ${path}`, handler);
  }) as unknown as RouterMatcher;

// Static assertion that RouteRecorder is at least assignment-compatible with
// what we're handing to Express, so unrelated drift (e.g. CapturedHandler
// rename) is caught at type-check time and not just at the unknown bridge.
const _routeRecorderShapeCheck: RouteRecorder = (path, handler) => {
  void path;
  void handler;
};
void _routeRecorderShapeCheck;

function captureAdminRoutes(): void {
  const fakeApp: Partial<Express> = {
    get: makeRecorder("GET"),
    post: makeRecorder("POST"),
    patch: makeRecorder("PATCH"),
    delete: makeRecorder("DELETE"),
    put: makeRecorder("PUT"),
  };
  registerAdminRoutes(fakeApp as Express);
}

function makeMockReqRes(opts: { token: string; params: Record<string, string>; body: unknown }): {
  req: Request;
  res: any;
  result: { statusCode: number; body: unknown };
} {
  const result = { statusCode: 200, body: undefined as unknown };
  const req = {
    headers: { authorization: `Bearer ${opts.token}` },
    params: opts.params,
    body: opts.body,
    query: {},
    path: "",
    method: "POST",
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

// ---------------------------------------------------------------------------
// Tests, executed in canonical order.
// ---------------------------------------------------------------------------

async function test1_nonAdminCannotDeduct(opts: {
  clientUserId: number;
  clientUsername: string;
  clientEmail: string;
  deductionId: number;
}): Promise<void> {
  const handler = captured.get("POST /api/admin/fee-deductions/:id/approve");
  if (!handler) {
    fail(
      "non-admin cannot deduct",
      "internal: approve route handler was not captured from registerAdminRoutes",
    );
    return;
  }

  const token = signToken({
    userId: opts.clientUserId,
    username: opts.clientUsername,
    email: opts.clientEmail,
    role: "client",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    params: { id: String(opts.deductionId) },
    body: {},
  });

  await handler(req, res);

  // Snapshot the deduction afterwards so we can also prove no settlement
  // happened as a side-effect of this attempt.
  const [after] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, opts.deductionId));

  // Strict: must be 403 (role guard rejected), NOT 401 (token rejected). The
  // JWT we just signed is valid against the same JWT_SECRET the auth
  // middleware uses, so a 401 here would mean the token verification path
  // regressed and the test would silently pass on an unrelated failure mode.
  const isRoleForbidden = result.statusCode === 403;
  const stillPending = after?.status === "pending_approval";
  if (isRoleForbidden && stillPending) {
    pass(
      "non-admin cannot deduct",
      `route returned 403 (role guard), deduction still status='${after.status}'`,
    );
  } else {
    fail(
      "non-admin cannot deduct",
      `expected 403 (role guard) + status='pending_approval', got status=${result.statusCode}, dedStatus='${after?.status}'`,
    );
  }
}

type SettleSnapshot = {
  walletClient: string;
  ledgerClient: string;
  walletAdviser: string;
  ledgerAdviser: string;
};

async function snapshotWalletVsLedger(opts: {
  clientUserId: number;
  adviserUserId: number;
}): Promise<SettleSnapshot> {
  const [walletClient] = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, opts.clientUserId),
        eq(wallets.currency, TEST_CURRENCY),
      ),
    );
  const [walletAdviser] = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, opts.adviserUserId),
        eq(wallets.currency, TEST_CURRENCY),
      ),
    );
  const ledgerClient = await getUserCurrencyBalance(
    opts.clientUserId,
    TEST_CURRENCY,
  );
  const ledgerAdviser = await getUserCurrencyBalance(
    opts.adviserUserId,
    TEST_CURRENCY,
  );
  return {
    walletClient: walletClient?.balance ?? "0",
    ledgerClient,
    walletAdviser: walletAdviser?.balance ?? "0",
    ledgerAdviser,
  };
}

async function test2_approvedDeductionPostsOnce(opts: {
  deductionId: number;
  approverUserId: number;
}): Promise<void> {
  const settled = await settleApprovedDeduction({
    deductionId: opts.deductionId,
    approverUserId: opts.approverUserId,
  });
  if (settled.settledTransactionId) {
    pushUnique(created.transactionIds, settled.settledTransactionId);
  }

  const idemKey = `fee_deduction_${opts.deductionId}`;
  const txRows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  const receiptRows = settled.settledTransactionId
    ? await db
        .select()
        .from(ledgerPostings)
        .where(eq(ledgerPostings.transactionId, settled.settledTransactionId))
    : [];

  const ok =
    settled.status === "settled" &&
    settled.settledTransactionId !== null &&
    settled.settledTransactionId !== undefined &&
    txRows.length === 1 &&
    receiptRows.length === 1;
  if (ok) {
    pass(
      "approved deduction posts once",
      `status='settled', settledTransactionId=${settled.settledTransactionId}, transactions=${txRows.length}, ledger_postings=${receiptRows.length}`,
    );
  } else {
    fail(
      "approved deduction posts once",
      `status='${settled.status}', settledTransactionId=${settled.settledTransactionId}, transactions=${txRows.length}, ledger_postings=${receiptRows.length}`,
    );
  }
}

async function test3_duplicateDeductionBlocked(opts: {
  deductionId: number;
  approverUserId: number;
}): Promise<void> {
  // Snapshot what exists before the second call so we can prove nothing new
  // was written on the duplicate.
  const idemKey = `fee_deduction_${opts.deductionId}`;
  const txBefore = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  const settledTxId = txBefore[0]?.id;
  if (!settledTxId) {
    fail(
      "duplicate deduction blocked",
      "no settled transactions row found from test #2 — cannot evaluate duplicate guard",
    );
    return;
  }
  const entriesBefore = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, settledTxId));
  const receiptsBefore = await db
    .select()
    .from(ledgerPostings)
    .where(eq(ledgerPostings.transactionId, settledTxId));

  // Re-call the settlement.
  const second = await settleApprovedDeduction({
    deductionId: opts.deductionId,
    approverUserId: opts.approverUserId,
  });

  const txAfter = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  const entriesAfter = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, settledTxId));
  const receiptsAfter = await db
    .select()
    .from(ledgerPostings)
    .where(eq(ledgerPostings.transactionId, settledTxId));

  const ok =
    second.status === "settled" &&
    second.id === opts.deductionId &&
    txAfter.length === txBefore.length &&
    entriesAfter.length === entriesBefore.length &&
    receiptsAfter.length === receiptsBefore.length;
  if (ok) {
    pass(
      "duplicate deduction blocked",
      `re-settle returned same row; transactions ${txBefore.length}→${txAfter.length}, ledger_entries ${entriesBefore.length}→${entriesAfter.length}, ledger_postings ${receiptsBefore.length}→${receiptsAfter.length}`,
    );
  } else {
    fail(
      "duplicate deduction blocked",
      `second.status='${second.status}', transactions ${txBefore.length}→${txAfter.length}, entries ${entriesBefore.length}→${entriesAfter.length}, receipts ${receiptsBefore.length}→${receiptsAfter.length}`,
    );
  }
}

async function test4_expiredConsentBlocked(opts: {
  clientUserId: number;
  adviserUserId: number;
}): Promise<void> {
  const accrualDate = new Date(Date.UTC(2026, 5, 1));
  const expiredAt = new Date(Date.UTC(2026, 0, 1));
  const adviceRecordId = await makeAdviceRecord(opts.clientUserId);
  const consentId = await makeFeeConsent({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    adviceRecordId,
    overrides: { consentExpiryDate: expiredAt },
  });
  const ruleId = await makeFeeRule({
    feeConsentId: consentId,
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
  });

  await runDailyAccruals({ accrualDate });

  const [accrual] = await db
    .select()
    .from(adviserFeeAccruals)
    .where(
      and(
        eq(adviserFeeAccruals.feeRuleId, ruleId),
        eq(adviserFeeAccruals.accrualDate, accrualDate),
      ),
    );

  const ok =
    accrual?.gateReason === "consent_expired" &&
    Number(accrual.accrualAmount) === 0;
  if (ok) {
    pass(
      "expired consent blocked",
      `accrual rule#${ruleId} accrualDate=${accrualDate.toISOString().slice(0, 10)} gateReason='${accrual.gateReason}', amount=${accrual.accrualAmount}`,
    );
  } else {
    fail(
      "expired consent blocked",
      `expected gateReason='consent_expired' + amount=0, got gateReason='${accrual?.gateReason}', amount='${accrual?.accrualAmount}'`,
    );
  }
}

async function test5_withdrawnConsentBlocked(opts: {
  clientUserId: number;
  adviserUserId: number;
}): Promise<void> {
  const accrualDate = new Date(Date.UTC(2026, 5, 2));
  const adviceRecordId = await makeAdviceRecord(opts.clientUserId);
  const consentId = await makeFeeConsent({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    adviceRecordId,
    overrides: { withdrawnAt: new Date(Date.UTC(2026, 4, 1)) },
  });
  const ruleId = await makeFeeRule({
    feeConsentId: consentId,
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
  });

  await runDailyAccruals({ accrualDate });

  const [accrual] = await db
    .select()
    .from(adviserFeeAccruals)
    .where(
      and(
        eq(adviserFeeAccruals.feeRuleId, ruleId),
        eq(adviserFeeAccruals.accrualDate, accrualDate),
      ),
    );

  const ok =
    accrual?.gateReason === "consent_withdrawn" &&
    Number(accrual.accrualAmount) === 0;
  if (ok) {
    pass(
      "withdrawn consent blocked",
      `accrual rule#${ruleId} accrualDate=${accrualDate.toISOString().slice(0, 10)} gateReason='${accrual.gateReason}', amount=${accrual.accrualAmount}`,
    );
  } else {
    fail(
      "withdrawn consent blocked",
      `expected gateReason='consent_withdrawn' + amount=0, got gateReason='${accrual?.gateReason}', amount='${accrual?.accrualAmount}'`,
    );
  }
}

async function test6_insufficientLedgerBlocked(opts: {
  clientUserId: number;
  adviserUserId: number;
  approverUserId: number;
}): Promise<number> {
  // Pick an amount that comfortably exceeds the client's current balance so
  // the gate fires regardless of where in the test sequence we land.
  const currentBalance = Number(
    await getUserCurrencyBalance(opts.clientUserId, TEST_CURRENCY),
  );
  const amount = (currentBalance + 1_000_000).toFixed(4);
  const adviserShare = (Number(amount) * 0.8).toFixed(4);
  const deductionId = await insertPendingDeduction({
    clientUserId: opts.clientUserId,
    adviserUserId: opts.adviserUserId,
    totalAccrued: amount,
    adviserShare,
  });

  const idemKey = `fee_deduction_${deductionId}`;

  let caught: unknown = null;
  try {
    await settleApprovedDeduction({
      deductionId,
      approverUserId: opts.approverUserId,
    });
  } catch (err) {
    caught = err;
  }

  const [after] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, deductionId));

  const txRows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  const receiptCount = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM ledger_postings p
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.idempotency_key = ${idemKey}
  `);
  // Tolerate both driver row shapes (pg returns `{ rows: [...] }`,
  // some Drizzle/driver combinations return the array directly), exactly
  // mirroring the `extractRows` helper in posting-receipt-invariant.ts.
  const receiptRows = extractCountRows(receiptCount);
  const receiptN = receiptRows.length > 0 ? Number(receiptRows[0]?.n ?? 0) : 0;

  const ok =
    caught instanceof InsufficientFundsError &&
    after?.status === "insufficient_funds" &&
    !!after.failureReason &&
    Number(txRows[0]?.n ?? 0) === 0 &&
    receiptN === 0;
  if (ok) {
    pass(
      "insufficient ledger balance blocked",
      `InsufficientFundsError thrown, deduction status='insufficient_funds', failureReason set, transactions=0, ledger_postings=0`,
    );
  } else {
    fail(
      "insufficient ledger balance blocked",
      `caught=${caught instanceof Error ? caught.constructor.name : String(caught)}, status='${after?.status}', failureReason='${after?.failureReason ?? ""}', transactions=${txRows[0]?.n ?? 0}, ledger_postings=${receiptN}`,
    );
  }
  return deductionId;
}

async function test7_ledgerDebitCreated(opts: {
  deductionId: number;
  expectedAmount: string;
  clientUserId: number;
}): Promise<void> {
  const [deduction] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, opts.deductionId));
  if (!deduction?.settledTransactionId) {
    fail(
      "ledger debit created",
      `deduction#${opts.deductionId} has no settledTransactionId — settle from test #2 didn't land`,
    );
    return;
  }
  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, deduction.settledTransactionId));

  const clientDebits = entries.filter(
    (e) => e.userId === opts.clientUserId && e.direction === "debit",
  );
  const totalDebits = entries
    .filter((e) => e.direction === "debit")
    .reduce((s, e) => s + Number(e.amount), 0);
  const totalCredits = entries
    .filter((e) => e.direction === "credit")
    .reduce((s, e) => s + Number(e.amount), 0);

  const expected = Number(opts.expectedAmount);
  const ok =
    entries.length === 3 &&
    Math.abs(totalDebits - totalCredits) < 1e-8 &&
    Math.abs(totalDebits - expected) < 1e-8 &&
    clientDebits.length === 1 &&
    Math.abs(Number(clientDebits[0].amount) - expected) < 1e-8;
  if (ok) {
    pass(
      "ledger debit created",
      `tx#${deduction.settledTransactionId}: 3 entries, debits=${totalDebits}, credits=${totalCredits}, client debit=${clientDebits[0].amount}`,
    );
  } else {
    fail(
      "ledger debit created",
      `tx#${deduction.settledTransactionId}: entries=${entries.length}, debits=${totalDebits}, credits=${totalCredits}, clientDebits=${clientDebits.length} (expected ${expected})`,
    );
  }
}

async function test8_reversalLedgerCreditCreated(opts: {
  deductionId: number;
  reverserUserId: number;
  expectedAmount: string;
  clientUserId: number;
}): Promise<void> {
  const reversed = await reverseSettledDeduction({
    deductionId: opts.deductionId,
    reverserUserId: opts.reverserUserId,
    reason: "Gate B verification roll-up: reversal credit assertion",
  });
  if (reversed.reversalTransactionId) {
    pushUnique(created.transactionIds, reversed.reversalTransactionId);
  }

  if (
    reversed.status !== "reversed" ||
    !reversed.reversalTransactionId
  ) {
    fail(
      "reversal ledger credit created",
      `reverse returned status='${reversed.status}', reversalTransactionId=${reversed.reversalTransactionId}`,
    );
    return;
  }

  const idemKey = `fee_deduction_${opts.deductionId}_reversal`;
  const reversalTxRows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, idemKey));
  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, reversed.reversalTransactionId));

  const clientCredits = entries.filter(
    (e) => e.userId === opts.clientUserId && e.direction === "credit",
  );
  const expected = Number(opts.expectedAmount);
  const totalDebits = entries
    .filter((e) => e.direction === "debit")
    .reduce((s, e) => s + Number(e.amount), 0);
  const totalCredits = entries
    .filter((e) => e.direction === "credit")
    .reduce((s, e) => s + Number(e.amount), 0);

  const ok =
    reversalTxRows.length === 1 &&
    entries.length === 3 &&
    Math.abs(totalDebits - totalCredits) < 1e-8 &&
    clientCredits.length === 1 &&
    Math.abs(Number(clientCredits[0].amount) - expected) < 1e-8;
  if (ok) {
    pass(
      "reversal ledger credit created",
      `reversal tx#${reversed.reversalTransactionId}: status='reversed', client credit=${clientCredits[0].amount}, debits=${totalDebits}, credits=${totalCredits}`,
    );
  } else {
    fail(
      "reversal ledger credit created",
      `reversalTransactions=${reversalTxRows.length}, entries=${entries.length}, debits=${totalDebits}, credits=${totalCredits}, clientCredits=${clientCredits.length}`,
    );
  }
}

async function test9_walletNotDirectlyMutated(
  snapshots: { label: string; snap: SettleSnapshot }[],
): Promise<void> {
  // The hard rule: wallets.balance must equal the ledger-derived balance at
  // EVERY checkpoint. If it ever drifts, someone bypassed
  // refreshWalletCacheBalance and wrote wallets.balance directly.
  const driftLines: string[] = [];
  for (const { label, snap } of snapshots) {
    const driftClient = Math.abs(
      Number(snap.walletClient) - Number(snap.ledgerClient),
    );
    const driftAdviser = Math.abs(
      Number(snap.walletAdviser) - Number(snap.ledgerAdviser),
    );
    if (driftClient >= 0.01 || driftAdviser >= 0.01) {
      driftLines.push(
        `[${label}] client wallet=${snap.walletClient} ledger=${snap.ledgerClient} drift=${driftClient.toFixed(8)}; adviser wallet=${snap.walletAdviser} ledger=${snap.ledgerAdviser} drift=${driftAdviser.toFixed(8)}`,
      );
    }
  }

  if (driftLines.length === 0) {
    pass(
      "wallet balance not directly mutated",
      `${snapshots.length} checkpoints; wallet cache == ledger sum at each (client + adviser)`,
    );
  } else {
    fail(
      "wallet balance not directly mutated",
      driftLines.join(" | "),
    );
  }
}

async function test10_reconciliationClean(opts: {
  clientUserId: number;
  adviserUserId: number;
}): Promise<void> {
  await runWalletLedgerReconciliation();

  const fetchLatest = async (userId: number) => {
    const [row] = await db
      .select()
      .from(walletLedgerReconciliations)
      .where(
        and(
          eq(walletLedgerReconciliations.userId, userId),
          eq(walletLedgerReconciliations.currency, TEST_CURRENCY),
        ),
      )
      .orderBy(sql`${walletLedgerReconciliations.createdAt} DESC`)
      .limit(1);
    return row;
  };

  const clientRow = await fetchLatest(opts.clientUserId);
  const adviserRow = await fetchLatest(opts.adviserUserId);

  const ok =
    clientRow?.status === "match" &&
    adviserRow?.status === "match" &&
    Math.abs(Number(clientRow.driftAmount ?? 0)) < 0.01 &&
    Math.abs(Number(adviserRow.driftAmount ?? 0)) < 0.01;
  if (ok) {
    pass(
      "reconciliation clean after post/reversal",
      `client status='${clientRow.status}' drift=${clientRow.driftAmount}; adviser status='${adviserRow.status}' drift=${adviserRow.driftAmount}`,
    );
  } else {
    fail(
      "reconciliation clean after post/reversal",
      `client=${JSON.stringify({ status: clientRow?.status, drift: clientRow?.driftAmount })}, adviser=${JSON.stringify({ status: adviserRow?.status, drift: adviserRow?.driftAmount })}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 11 — concurrent settle race posts exactly once.
// ---------------------------------------------------------------------------
// Two parallel settleApprovedDeduction() calls on the same pending deduction
// row must collapse to a single posting. The fee-engine's safety stack is:
//   - SELECT ... FOR UPDATE on the deduction row inside db.transaction()
//   - UNIQUE constraint on transactions.idempotency_key (`fee_deduction_<id>`)
//   - PRIMARY KEY on ledger_postings.transaction_id (Task #37 receipt table)
// Together they guarantee that even with two concurrent winners racing, the
// SECOND caller either: (a) waits on the row lock and enters the idempotent
// fast-path, or (b) hits the unique-key violation on the transactions row
// and surfaces a deterministic error WITHOUT writing duplicate ledger rows.
// PASS condition: exactly 1 transactions row, exactly 1 ledger_postings
// receipt, exactly 3 ledger_entries (the balanced triple), and final
// deduction status='settled' with a single settledTransactionId.
// ---------------------------------------------------------------------------
async function test11_concurrentSettleRace(opts: {
  deductionId: number;
  approverUserId: number;
}): Promise<void> {
  const settled1Promise = settleRace(
    settleApprovedDeduction({
      deductionId: opts.deductionId,
      approverUserId: opts.approverUserId,
    }),
  );
  const settled2Promise = settleRace(
    settleApprovedDeduction({
      deductionId: opts.deductionId,
      approverUserId: opts.approverUserId,
    }),
  );

  const [r1, r2] = await Promise.all([settled1Promise, settled2Promise]);

  // At least one of the two callers MUST have produced a successful settled
  // row. The other is allowed to either return the same settled row (lock
  // fast-path) or surface a deterministic LedgerDoublePostError /
  // unique-key error (race lost on the receipt or transactions row).
  const successful: unknown[] = [];
  const errors: unknown[] = [];
  for (const r of [r1, r2]) {
    if (r.ok) successful.push(r.value);
    else errors.push(r.error);
  }
  if (successful.length === 0) {
    fail(
      "concurrent settle race posts exactly once",
      `both racers errored: ${errors.map((e) => (e as Error).message).join(" / ")}`,
    );
    return;
  }

  const [after] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, opts.deductionId));
  if (after?.status !== "settled" || !after.settledTransactionId) {
    fail(
      "concurrent settle race posts exactly once",
      `expected settled, got status='${after?.status}' settledTransactionId=${after?.settledTransactionId}`,
    );
    return;
  }

  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.idempotencyKey, `fee_deduction_${opts.deductionId}`));
  const receiptRows = await db
    .select({ transactionId: ledgerPostings.transactionId })
    .from(ledgerPostings)
    .where(eq(ledgerPostings.transactionId, after.settledTransactionId));
  const entryRows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, after.settledTransactionId));

  if (
    txRows.length === 1 &&
    receiptRows.length === 1 &&
    entryRows.length === 3
  ) {
    pass(
      "concurrent settle race posts exactly once",
      `2 racers → 1 settled tx (#${after.settledTransactionId}), 1 receipt, 3 entries; ${successful.length} success / ${errors.length} race-error`,
    );
  } else {
    fail(
      "concurrent settle race posts exactly once",
      `expected 1 tx + 1 receipt + 3 entries; got tx=${txRows.length}, receipts=${receiptRows.length}, entries=${entryRows.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 12 — concurrent reverse race reverses exactly once.
// ---------------------------------------------------------------------------
// Same shape as test 11, applied to reverseSettledDeduction. The reversal
// path uses the deterministic key `fee_deduction_<id>_reversal`. Two
// parallel reverse calls on the same settled deduction must collapse to a
// single reversal transaction with one balanced opposite triple.
// PASS condition: exactly 1 reversal transaction, 1 receipt, 3 entries;
// deduction.status='reversed' with reversalTransactionId set.
// ---------------------------------------------------------------------------
async function test12_concurrentReverseRace(opts: {
  deductionId: number;
  reverserUserId: number;
}): Promise<void> {
  const reverse1Promise = settleRace(
    reverseSettledDeduction({
      deductionId: opts.deductionId,
      reverserUserId: opts.reverserUserId,
      reason: "concurrent reverse race test",
    }),
  );
  const reverse2Promise = settleRace(
    reverseSettledDeduction({
      deductionId: opts.deductionId,
      reverserUserId: opts.reverserUserId,
      reason: "concurrent reverse race test",
    }),
  );

  const [r1, r2] = await Promise.all([reverse1Promise, reverse2Promise]);

  const successful: unknown[] = [];
  const errors: unknown[] = [];
  for (const r of [r1, r2]) {
    if (r.ok) successful.push(r.value);
    else errors.push(r.error);
  }
  if (successful.length === 0) {
    fail(
      "concurrent reverse race reverses exactly once",
      `both racers errored: ${errors.map((e) => (e as Error).message).join(" / ")}`,
    );
    return;
  }

  const [after] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, opts.deductionId));
  if (after?.status !== "reversed" || !after.reversalTransactionId) {
    fail(
      "concurrent reverse race reverses exactly once",
      `expected reversed, got status='${after?.status}' reversalTransactionId=${after?.reversalTransactionId}`,
    );
    return;
  }

  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      eq(
        transactions.idempotencyKey,
        `fee_deduction_${opts.deductionId}_reversal`,
      ),
    );
  const receiptRows = await db
    .select({ transactionId: ledgerPostings.transactionId })
    .from(ledgerPostings)
    .where(eq(ledgerPostings.transactionId, after.reversalTransactionId));
  const entryRows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, after.reversalTransactionId));

  if (
    txRows.length === 1 &&
    receiptRows.length === 1 &&
    entryRows.length === 3
  ) {
    pass(
      "concurrent reverse race reverses exactly once",
      `2 racers → 1 reversal tx (#${after.reversalTransactionId}), 1 receipt, 3 entries; ${successful.length} success / ${errors.length} race-error`,
    );
  } else {
    fail(
      "concurrent reverse race reverses exactly once",
      `expected 1 tx + 1 receipt + 3 entries; got tx=${txRows.length}, receipts=${receiptRows.length}, entries=${entryRows.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 13 — posting-receipt invariant holds.
// ---------------------------------------------------------------------------
// Calls the production `runPostingReceiptInvariantCheck()` directly (the
// same function `server/index.ts` invokes at boot and on the daily cron).
// The global result is logged for context — but the strict assertion is
// scoped to THIS run's transactions to avoid coupling the gate to any
// pre-existing dev-DB residue (e.g. transactions that pre-date Task #37
// and have not been backfilled). For our run, every transactionId we
// touched MUST have a matching ledger_postings receipt. If it does not,
// the next caller of `postLedgerEntries()` against that tx would slip
// past the double-post guard — exactly the failure mode the invariant
// exists to catch.
// ---------------------------------------------------------------------------
async function test13_postingReceiptInvariantHolds(): Promise<void> {
  // Invoke the production checker directly — proves the invariant
  // machinery executes without throwing AND surfaces any global drift.
  const result = await runPostingReceiptInvariantCheck();

  // Strict scoped assertion: distinct ledger_entries.transaction_id IN
  // (our tx ids) must equal the count of ledger_postings rows for those
  // same tx ids. Use only PK-tracked tx ids so prior-run noise (already
  // wiped by the upfront PK cleanup) cannot affect the result.
  const trackedTxIds = created.transactionIds;
  if (trackedTxIds.length === 0) {
    fail(
      "posting-receipt invariant holds",
      "no transactions were tracked in this run — cannot validate scoped invariant",
    );
    return;
  }

  const entryRows = await db
    .select({ txId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.transactionId, trackedTxIds));
  const distinctTxWithEntries = new Set<number>();
  for (const r of entryRows) {
    if (r.txId !== null && r.txId !== undefined) {
      distinctTxWithEntries.add(r.txId);
    }
  }

  const receiptRows = await db
    .select({ txId: ledgerPostings.transactionId })
    .from(ledgerPostings)
    .where(inArray(ledgerPostings.transactionId, trackedTxIds));

  const scopedTx = distinctTxWithEntries.size;
  const scopedReceipts = receiptRows.length;
  const scopedClean = scopedTx === scopedReceipts && scopedTx > 0;

  if (scopedClean) {
    pass(
      "posting-receipt invariant holds",
      `runPostingReceiptInvariantCheck() ran (global missingCount=${result.missingCount}); scoped to this run's ${trackedTxIds.length} tx: ${scopedTx} with entries == ${scopedReceipts} receipts.`,
    );
  } else {
    fail(
      "posting-receipt invariant holds",
      `scoped: ${scopedTx} tx with entries vs ${scopedReceipts} receipts (global missingCount=${result.missingCount}, global missingSample=${JSON.stringify(result.missingSample)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
// Status object returned by `runAllTests()`. The runner NEVER calls
// process.exit itself — that decision lives in `main()`, AFTER the
// guaranteed cleanup `finally` has run. This is critical: a hard exit
// inside the runner would skip cleanup and leave seeded fixture rows
// behind in the dev DB, violating the script's PK-tracked cleanup
// contract.
type RunStatus = { exitCode: number };

async function main(): Promise<void> {
  console.log("=== Fee Deduction GATE B verification roll-up (Task #92) ===\n");
  let status: RunStatus = { exitCode: 0 };
  try {
    status = await runAllTests();
  } catch (err) {
    status = { exitCode: 1 };
    console.error("Gate B verification roll-up threw:", err);
  } finally {
    // GUARANTEED post-run cleanup. Runs even if a test threw, so the dev
    // DB is left in a clean state for the next run regardless of outcome.
    // Cleanup operates on PK arrays only — it cannot accidentally widen
    // scope, even if the run aborted mid-fixture (untracked rows simply
    // are not deleted, which is correct).
    try {
      await cleanupTrackedRows();
    } catch (cleanupErr) {
      console.error("Post-run cleanup threw:", cleanupErr);
      // Do NOT downgrade a successful run on cleanup failure — the test
      // result itself is still valid — but DO ensure non-zero exit so an
      // operator notices the cleanup gap.
      if (status.exitCode === 0) status = { exitCode: 1 };
    }
  }
  process.exit(status.exitCode);
}

async function runAllTests(): Promise<RunStatus> {
  // Capture the actual admin route handlers so test #1 calls the same
  // adminRoute() wrapper the production app uses.
  captureAdminRoutes();

  // PLATFORM_USER_ID must be set for getOrCreateSuspenseAccount/getOrCreateFeeAccount
  // during the top-up + settle paths. If it's missing, mint a deterministic
  // platform user and pin it.
  if (!process.env.PLATFORM_USER_ID) {
    const platformId = await ensureUser({
      username: PLATFORM_FALLBACK_USERNAME,
      email: "gateb-platform@test.invalid",
      role: "admin",
    });
    process.env.PLATFORM_USER_ID = String(platformId);
    created.userIds.push(platformId);
  }

  // Main pair (used by tests 1, 2, 3, 6, 7, 8, 9, 10).
  const clientUserId = await ensureUser({
    username: CLIENT_USERNAME,
    email: "gateb-client@test.invalid",
    role: "client",
  });
  const adviserUserId = await ensureUser({
    username: ADVISER_USERNAME,
    email: "gateb-adviser@test.invalid",
    role: "adviser",
  });
  // Approver for settle/reverse — production hits these via an admin route,
  // but the service-layer functions only need a user id to write into
  // approvedByUserId / reversedByUserId. We use the adviser to keep the
  // PLATFORM_USER_ID as the platform-only counterparty.
  const approverUserId = adviserUserId;

  // Isolated client per consent-gate test so the consent rows stay scoped
  // and cleanup never touches the main pair's rules/accruals.
  const consent4ClientUserId = await ensureUser({
    username: CONSENT4_CLIENT_USERNAME,
    email: "gateb-consent-expired@test.invalid",
    role: "client",
  });
  const consent5ClientUserId = await ensureUser({
    username: CONSENT5_CLIENT_USERNAME,
    email: "gateb-consent-withdrawn@test.invalid",
    role: "client",
  });

  const allTestUserIds = [
    clientUserId,
    adviserUserId,
    consent4ClientUserId,
    consent5ClientUserId,
  ];
  for (const uid of allTestUserIds) pushUnique(created.userIds, uid);

  // Wipe any residual rows from a prior run BEFORE we touch fixtures so
  // assertions about row counts are deterministic. We do this via the
  // same PK-only pipeline used for end-of-run cleanup: discover prior-run
  // rows by FK-walking from the deterministic test users, push their PKs
  // into the tracker, then run cleanupTrackedRows(). After this call the
  // tracker arrays for child tables are empty again because the rows
  // they referenced no longer exist; the user PKs in created.userIds
  // remain (we never delete the test users themselves).
  await discoverPriorRunRows(allTestUserIds);
  await cleanupTrackedRows();
  // Reset all child trackers — every PK we discovered is now deleted.
  // Only userIds (the test users themselves, never deleted) are kept.
  created.walletIds.length = 0;
  created.accountIds.length = 0;
  created.adviserClientIds.length = 0;
  created.adviceRecordIds.length = 0;
  created.consentIds.length = 0;
  created.ruleIds.length = 0;
  created.accrualIds.length = 0;
  created.deductionIds.length = 0;
  created.transactionIds.length = 0;
  created.reconciliationIds.length = 0;

  await ensureFreshWallet(clientUserId);
  await ensureFreshWallet(adviserUserId);
  await ensureAdviserClientLink(adviserUserId, clientUserId);
  await ensureAdviserClientLink(adviserUserId, consent4ClientUserId);
  await ensureAdviserClientLink(adviserUserId, consent5ClientUserId);

  // Pre-create deduction A used by tests 1, 2, 3, 7, 8.
  const deductionAId = await insertPendingDeduction({
    clientUserId,
    adviserUserId,
    totalAccrued: "100.0000",
    adviserShare: "80.0000",
  });

  // -----------------------------------------------------------------------
  // Test 1 — non-admin cannot deduct (BEFORE any top-up so we also prove a
  // non-admin can't sneak through even if other state is in place).
  // -----------------------------------------------------------------------
  await test1_nonAdminCannotDeduct({
    clientUserId,
    clientUsername: CLIENT_USERNAME,
    clientEmail: "gateb-client@test.invalid",
    deductionId: deductionAId,
  });

  // -----------------------------------------------------------------------
  // Top up the client so the settle path has funds to debit.
  // -----------------------------------------------------------------------
  await topUpClient(clientUserId, "500.00");
  const snapAfterTopUp = await snapshotWalletVsLedger({
    clientUserId,
    adviserUserId,
  });

  // -----------------------------------------------------------------------
  // Test 2 — settle deduction A.
  // -----------------------------------------------------------------------
  await test2_approvedDeductionPostsOnce({
    deductionId: deductionAId,
    approverUserId,
  });
  const snapAfterSettle = await snapshotWalletVsLedger({
    clientUserId,
    adviserUserId,
  });

  // -----------------------------------------------------------------------
  // Test 3 — duplicate settle is a no-op.
  // -----------------------------------------------------------------------
  await test3_duplicateDeductionBlocked({
    deductionId: deductionAId,
    approverUserId,
  });

  // -----------------------------------------------------------------------
  // Tests 4 + 5 — consent gates inside runDailyAccruals. Each runs against
  // its own client so the rule rows stay scoped.
  // -----------------------------------------------------------------------
  await test4_expiredConsentBlocked({
    clientUserId: consent4ClientUserId,
    adviserUserId,
  });
  await test5_withdrawnConsentBlocked({
    clientUserId: consent5ClientUserId,
    adviserUserId,
  });

  // -----------------------------------------------------------------------
  // Test 6 — insufficient ledger balance blocked. Creates its own deduction
  // with totalAccrued > current client balance.
  // -----------------------------------------------------------------------
  await test6_insufficientLedgerBlocked({
    clientUserId,
    adviserUserId,
    approverUserId,
  });

  // -----------------------------------------------------------------------
  // Test 7 — ledger debit on the test #2 settled transaction.
  // -----------------------------------------------------------------------
  await test7_ledgerDebitCreated({
    deductionId: deductionAId,
    expectedAmount: "100.0000",
    clientUserId,
  });

  // -----------------------------------------------------------------------
  // Test 8 — reverse the settled deduction A; expect a balanced opposite triple.
  // -----------------------------------------------------------------------
  await test8_reversalLedgerCreditCreated({
    deductionId: deductionAId,
    reverserUserId: approverUserId,
    expectedAmount: "100.0000",
    clientUserId,
  });
  const snapAfterReverse = await snapshotWalletVsLedger({
    clientUserId,
    adviserUserId,
  });

  // -----------------------------------------------------------------------
  // Test 9 — wallet cache == ledger sum at every checkpoint.
  // -----------------------------------------------------------------------
  await test9_walletNotDirectlyMutated([
    { label: "after_topup", snap: snapAfterTopUp },
    { label: "after_settle", snap: snapAfterSettle },
    { label: "after_reverse", snap: snapAfterReverse },
  ]);

  // -----------------------------------------------------------------------
  // Tests 11 + 12 — concurrency races. Use a fresh deduction (B) so we
  // don't disturb deduction A's already-asserted state. Top up enough to
  // cover B's settle (deduction A was reversed so the balance is back
  // around 500, but be defensive — top up a known-good buffer).
  // -----------------------------------------------------------------------
  await topUpClient(clientUserId, "200.00");
  const deductionBId = await insertPendingDeduction({
    clientUserId,
    adviserUserId,
    totalAccrued: "50.0000",
    adviserShare: "40.0000",
  });
  await test11_concurrentSettleRace({
    deductionId: deductionBId,
    approverUserId,
  });
  await test12_concurrentReverseRace({
    deductionId: deductionBId,
    reverserUserId: approverUserId,
  });

  // -----------------------------------------------------------------------
  // Test 10 — full reconciliation pass leaves both sides clean. Runs after
  // tests 11 + 12 so the recon also covers their tx rows.
  // -----------------------------------------------------------------------
  await test10_reconciliationClean({ clientUserId, adviserUserId });

  // -----------------------------------------------------------------------
  // Test 13 — direct posting-receipt invariant assertion (Task #63 surface).
  // Runs LAST: every tx we created must have its receipt by now, so any
  // missing-receipt finding for our scope is a hard regression.
  // -----------------------------------------------------------------------
  await test13_postingReceiptInvariantHolds();

  // -----------------------------------------------------------------------
  // CANONICAL operator-facing report. The contract from the task spec is:
  //   * one PASS|FAIL line per CANONICAL_ORDER entry, in that exact order
  //   * PASS lines: `PASS <name>` only — NO appended details
  //   * FAIL lines: `FAIL <name> — <details>`
  //   * blank line, then the success banner OR a non-zero exit
  // INTERNAL_EXTRAS (race tests + posting-receipt invariant) RUN, and
  // failures still abort the script with a FAIL line printed below the
  // canonical block, but they do NOT appear in the canonical block.
  // -----------------------------------------------------------------------
  console.log("");
  let canonicalFailed = false;
  let canonicalMissing = 0;
  for (const name of CANONICAL_ORDER) {
    const r = results.get(name);
    if (!r) {
      console.log(`MISSING ${name} — assertion was not recorded`);
      canonicalMissing += 1;
      continue;
    }
    if (r.passed) {
      console.log(`PASS ${name}`);
    } else {
      console.log(`FAIL ${name} — ${r.details}`);
      canonicalFailed = true;
    }
  }

  // INTERNAL_EXTRAS: only print FAIL lines (never PASS) so the canonical
  // operator output is unchanged on the green path.
  let extrasFailed = false;
  for (const name of INTERNAL_EXTRAS) {
    const r = results.get(name);
    if (!r) {
      console.log(`MISSING (internal) ${name} — assertion was not recorded`);
      extrasFailed = true;
      continue;
    }
    if (!r.passed) {
      console.log(`FAIL (internal) ${name} — ${r.details}`);
      extrasFailed = true;
    }
  }

  if (canonicalFailed || canonicalMissing > 0 || extrasFailed) {
    const failedCount = Array.from(results.values()).filter((r) => !r.passed)
      .length;
    console.error(
      `\n${failedCount} fail(s), ${canonicalMissing} missing canonical assertion(s) in Gate B verification roll-up.`,
    );
    // Return non-zero status — main() will exit AFTER cleanup. Do NOT
    // call process.exit here; doing so would skip the guaranteed
    // cleanup `finally` block in main() and leave fixture rows behind.
    return { exitCode: 1 };
  }

  console.log("\nALL GATE B FEE DEDUCTION TESTS PASSED \u2705");
  return { exitCode: 0 };
}

main().catch((err) => {
  console.error("Gate B verification roll-up crashed:", err);
  process.exit(1);
});
