// =============================================================================
// LEDGER SERVICE — Track B (Session 7)
// =============================================================================
// Double-entry accounting for the AMAX non-custodial wealth platform.
//
// Core rules (do not violate):
//   1. Balances are DERIVED — SUM(credits) - SUM(debits). Never stored, never
//      mutated by hand.
//   2. Ledger entries are POSTED ONLY at settlement confirmation. A pending
//      transaction must NOT result in any ledger entries.
//   3. Every postLedgerEntries() call must balance to zero per currency.
//   4. The ledger is append-only. To "reverse" a transaction, post the OPPOSITE
//      pair of entries against a fresh transaction row — never delete or update
//      historical entries.
//
// Session 25 (Task #17) — LEDGER IS THE SOURCE OF TRUTH:
//   The wallets.balance / wallets.availableBalance columns are a derived cache
//   only. The ONLY sanctioned writer of those columns is
//   refreshWalletCacheBalance() below. Every settlement path (deposit,
//   withdrawal, ...) MUST post ledger entries first, then call
//   refreshWalletCacheBalance() in the same DB transaction. Direct
//   `tx.update(wallets).set({ balance, availableBalance })` is forbidden.
//
// Task #22 — postLedgerEntries() CALL SITES (settlement-only audit):
//   The lifecycle rule above ("ledger entries are POSTED ONLY at settlement
//   confirmation") is enforced by code, not by convention. As of this task,
//   the complete set of callers is:
//     1. server/routes.ts — handleDeposit (deposit settlement transaction)
//     2. server/routes.ts — handleWithdraw (withdrawal settlement transaction)
//   Both run inside a `db.transaction(...)` and only on the synchronous,
//   atomic completion path — neither code path can reach postLedgerEntries()
//   from a `pending` or `failed` branch, because the transaction row is
//   inserted with status `completed` in the same transaction handle that
//   posts the ledger pair. If you add a new caller, it MUST also originate
//   from the settlement transition (not pending/failed) and MUST run inside
//   the same DB transaction handle that did/will refresh the wallet cache.
//   The same-transaction posting guard in postLedgerEntries() additionally
//   refuses to insert a second balanced pair against an existing
//   transactionId — see LedgerDoublePostError below. As of Task #37 that
//   guard is enforced by the database itself (PRIMARY KEY on the
//   ledger_postings receipt table), so it holds even across concurrent
//   connections at the default READ COMMITTED isolation level.
// =============================================================================

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { accounts, ledgerEntries, ledgerPostings, wallets } from "@shared/schema";
import { notifyOperator } from "./operator-alerts";

// Drizzle's transaction handle has the same query surface as `db`. We use a
// loose alias so callers can pass either the global `db` or a `tx` from
// `db.transaction()` without TS friction.
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type Direction = "debit" | "credit";

export type LedgerEntryInput = {
  accountId: number;
  userId: number;
  currency: string;
  direction: Direction;
  amount: string; // string to preserve decimal precision; never parse to JS Number for storage
  description?: string;
};

// ---------------------------------------------------------------------------
// Platform suspense user resolution — REVIEWER FIX #2
// ---------------------------------------------------------------------------
// The platform suspense account represents funds in transit between AMAX and
// regulated partner institutions. Its accounts must be owned by a dedicated
// platform user (NOT user id 1, which is a real demo user). The user id is
// resolved at runtime from the PLATFORM_USER_ID env var so that production
// can pin it to a tightly-controlled system user, while dev can use whatever
// the developer has seeded.
//
// We refuse to fall back to a hardcoded value because a wrong owner here
// silently mixes platform suspense funds into a real user's audit trail —
// which would be a compliance failure and is hard to detect after the fact.
// ---------------------------------------------------------------------------
function getPlatformUserId(): number {
  const raw = process.env.PLATFORM_USER_ID;
  if (!raw) {
    throw new Error(
      "PLATFORM_USER_ID env var is required for any platform_suspense account " +
        "operation. Set it to the user_id that owns platform-side ledger accounts."
    );
  }
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `PLATFORM_USER_ID must be a positive integer; got: ${JSON.stringify(raw)}`
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Account lookup / creation
// ---------------------------------------------------------------------------
// Each helper accepts an optional handle so it can be used either inside a
// `db.transaction(async tx => ...)` block or against the global `db` (when
// called outside a transaction, e.g. by reporting code).

export async function getOrCreateClientAccount(
  userId: number,
  currency: string,
  handle: DbHandle = db,
) {
  const cur = currency.toUpperCase();

  const [existing] = await (handle as any)
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.currency, cur),
        eq(accounts.accountType, "client")
      )
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await (handle as any)
    .insert(accounts)
    .values({
      userId,
      currency: cur,
      accountType: "client",
      status: "active",
    })
    .returning();

  return created;
}

export async function getOrCreateSuspenseAccount(
  currency: string,
  handle: DbHandle = db,
) {
  const platformUserId = getPlatformUserId();
  const cur = currency.toUpperCase();

  const [existing] = await (handle as any)
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, platformUserId),
        eq(accounts.currency, cur),
        eq(accounts.accountType, "platform_suspense")
      )
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await (handle as any)
    .insert(accounts)
    .values({
      userId: platformUserId,
      currency: cur,
      accountType: "platform_suspense",
      status: "active",
    })
    .returning();

  return created;
}

// ---------------------------------------------------------------------------
// Platform fee account — destination for the licensee's share of adviser
// fees (Session 23B / Gate B). Owned by the same PLATFORM_USER_ID as the
// suspense account, but tagged with accountType='fee' so revenue is cleanly
// segregated from in-flight settlement funds in the ledger.
// ---------------------------------------------------------------------------
export async function getOrCreateFeeAccount(
  currency: string,
  handle: DbHandle = db,
) {
  const platformUserId = getPlatformUserId();
  const cur = currency.toUpperCase();

  const [existing] = await (handle as any)
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, platformUserId),
        eq(accounts.currency, cur),
        eq(accounts.accountType, "fee")
      )
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await (handle as any)
    .insert(accounts)
    .values({
      userId: platformUserId,
      currency: cur,
      accountType: "fee",
      status: "active",
    })
    .returning();

  return created;
}

// ---------------------------------------------------------------------------
// Derived balance queries — never read from any stored balance column
// ---------------------------------------------------------------------------

export async function getAccountBalance(
  accountId: number,
  handle: DbHandle = db,
): Promise<string> {
  const [row] = await (handle as any)
    .select({
      balance: sql<string>`
        COALESCE(SUM(
          CASE
            WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount}
            ELSE -${ledgerEntries.amount}
          END
        ), 0)
      `,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));

  return row?.balance ?? "0";
}

export async function getUserCurrencyBalance(
  userId: number,
  currency: string,
  handle: DbHandle = db,
): Promise<string> {
  const cur = currency.toUpperCase();
  const [row] = await (handle as any)
    .select({
      balance: sql<string>`
        COALESCE(SUM(
          CASE
            WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount}
            ELSE -${ledgerEntries.amount}
          END
        ), 0)
      `,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.currency, cur)
      )
    );

  return row?.balance ?? "0";
}

// ---------------------------------------------------------------------------
// Posting ledger entries — the ONLY way money "moves" in this system
// ---------------------------------------------------------------------------
//
// Validation enforced before any insert:
//   - Minimum 2 entries (debit + credit pair)
//   - All entries share the same currency (multi-currency FX is its own pattern;
//     it must produce two balanced single-currency journals, one per leg)
//   - Total credits == total debits to within 1e-8 (the smallest unit of an
//     8-decimal currency like BTC)
// ---------------------------------------------------------------------------

const EPSILON = 1e-8;

/**
 * Task #22 — thrown by postLedgerEntries() when a caller tries to post a
 * second balanced pair for a transactionId that already has any ledger
 * entries. This is the safeguard against accidental double-posting from a
 * retry, race, or refactor — without it, the second post would silently
 * duplicate the impact and only surface as drift on the next reconciliation
 * run. The error is named so callers/tests can assert on its identity
 * rather than string-matching the message.
 */
export class LedgerDoublePostError extends Error {
  readonly transactionId: number;
  readonly existingEntryCount: number;
  constructor(transactionId: number, existingEntryCount: number) {
    super(
      `Refusing to post ledger entries for transactionId=${transactionId}: ` +
        `${existingEntryCount} ledger entr${existingEntryCount === 1 ? "y" : "ies"} ` +
        `already exist for this transaction. Each transactionId may only be ` +
        `posted once. To reverse, post the OPPOSITE pair against a fresh ` +
        `transaction row.`
    );
    this.name = "LedgerDoublePostError";
    this.transactionId = transactionId;
    this.existingEntryCount = existingEntryCount;
  }
}

/**
 * Task #54 — thrown by postLedgerEntries() when the in-memory entries fail
 * the credit==debit balance invariant (within EPSILON). The previous code
 * threw a plain `Error("Ledger entries are not balanced: ...")` which
 * surfaced to the user as a generic 500 from whichever route triggered the
 * unbalanced journal. The typed error gives every caller a way to:
 *   1. Map this specific failure to a stable 422 + clean user message
 *      (instead of leaking the internal credit/debit numbers to the client).
 *   2. Fan out an operator alert with the structured numbers so an unbalanced
 *      journal in production is paged within minutes — drift from a silent
 *      regression here is the worst-case outcome of the ledger.
 *
 * The error carries `status=422` so admin-route helpers that already key
 * off `error.status` route it correctly without a special case. Callers
 * SHOULD prefer `mapLedgerUnbalancedToHttpResponse()` (or call
 * `notifyLedgerUnbalanced()` directly) so the operator alert is fired
 * exactly once per occurrence.
 */
export class LedgerUnbalancedError extends Error {
  readonly transactionId: number;
  readonly totalCredits: number;
  readonly totalDebits: number;
  readonly difference: number;
  readonly currency: string;
  readonly entryCount: number;
  readonly status = 422 as const;

  constructor(
    transactionId: number,
    totalCredits: number,
    totalDebits: number,
    currency: string,
    entryCount: number,
  ) {
    super(
      `Ledger entries are not balanced: credits=${totalCredits}, debits=${totalDebits}`,
    );
    this.name = "LedgerUnbalancedError";
    this.transactionId = transactionId;
    this.totalCredits = totalCredits;
    this.totalDebits = totalDebits;
    this.difference = totalCredits - totalDebits;
    this.currency = currency;
    this.entryCount = entryCount;
  }
}

// Stable user-facing strings for the unbalanced-journal failure mode. Kept
// at module scope (and exported) so route-level tests can assert on the
// exact same constants the production response uses, instead of duplicating
// the message text.
export const LEDGER_UNBALANCED_USER_MESSAGE =
  "We could not complete this action because an internal accounting check " +
  "failed. Operations have been notified and will investigate.";
export const LEDGER_UNBALANCED_ERROR_CODE = "ledger_unbalanced";

/**
 * Fire a critical operator alert for a tripped balance guard. Best-effort:
 * any failure dispatching the alert is swallowed (logged to stderr) so the
 * caller's HTTP response path is never blocked by a flaky alert backend.
 *
 * `source` should identify the originating call site (e.g. `"deposit"`,
 * `"withdrawal"`, `"fee_deduction_settlement"`) so a downstream router can
 * fan out by code path.
 */
export async function notifyLedgerUnbalanced(opts: {
  source: string;
  err: LedgerUnbalancedError;
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    await notifyOperator({
      source: `ledger-balance-guard.${opts.source}`,
      severity: "critical",
      title: "Unbalanced ledger journal blocked at posting time",
      details: {
        callSite: opts.source,
        transactionId: opts.err.transactionId,
        currency: opts.err.currency,
        totalCredits: opts.err.totalCredits,
        totalDebits: opts.err.totalDebits,
        difference: opts.err.difference,
        entryCount: opts.err.entryCount,
        ...(opts.context ?? {}),
      },
    });
  } catch (alertErr) {
    console.error(
      `[ledger] failed to dispatch unbalanced-journal operator alert for source=${opts.source}`,
      alertErr,
    );
  }
}

/**
 * Express-aware mapping helper. If `error` is a `LedgerUnbalancedError`,
 * fires the operator alert (best-effort) and writes a stable 422 JSON
 * response, then returns true so the caller's catch block can early-return.
 * Otherwise returns false and writes nothing — the caller should fall back
 * to its existing error handling.
 *
 * Centralising both the alert dispatch AND the response shape here means
 * every call site (deposit, withdrawal, fee settlement, future flows) maps
 * the same way without copy-pasting the JSON payload.
 */
export async function mapLedgerUnbalancedToHttpResponse(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown,
  source: string,
  context?: Record<string, unknown>,
): Promise<boolean> {
  if (!(error instanceof LedgerUnbalancedError)) return false;
  await notifyLedgerUnbalanced({ source, err: error, context });
  res.status(422).json({
    error: LEDGER_UNBALANCED_USER_MESSAGE,
    code: LEDGER_UNBALANCED_ERROR_CODE,
  });
  return true;
}

export async function postLedgerEntries(
  transactionId: number,
  entries: LedgerEntryInput[],
  handle: DbHandle = db,
): Promise<void> {
  if (entries.length < 2) {
    throw new Error("Ledger transaction must have at least two entries");
  }

  const currency = entries[0].currency;
  if (entries.some((e) => e.currency !== currency)) {
    throw new Error(
      "Multi-currency ledger entries require explicit FX transaction handling: " +
        "split into two single-currency journals."
    );
  }

  let totalCredits = 0;
  let totalDebits = 0;
  for (const e of entries) {
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error(
        `Ledger entry amount must be a positive finite number; got: ${e.amount}`
      );
    }
    if (e.direction === "credit") totalCredits += amt;
    else if (e.direction === "debit") totalDebits += amt;
    else throw new Error(`Invalid ledger direction: ${e.direction}`);
  }

  if (Math.abs(totalCredits - totalDebits) > EPSILON) {
    // Task #54 — typed error so callers can map this specific failure to a
    // 422 + clean user message and fire an operator alert. The throw must
    // happen BEFORE any DB write (no claim row, no entries, no cache
    // refresh) — that ordering is depended on by the route-level mapping
    // (it's safe to early-return without rolling back state) and by the
    // ledger.test.ts assertion that no entries leak.
    throw new LedgerUnbalancedError(
      transactionId,
      totalCredits,
      totalDebits,
      currency,
      entries.length,
    );
  }

  // -----------------------------------------------------------------------
  // Task #22 / Task #37 — DB-enforced same-transaction posting guard.
  //
  // We claim a per-transactionId lock by inserting a row into the
  // ledger_postings receipt table (PRIMARY KEY = transactionId) with
  // ON CONFLICT DO NOTHING. Postgres serialises concurrent inserts of the
  // same primary key value: the second poster blocks until the first
  // commits or rolls back, then either silently no-ops (if first
  // committed — we detect this via the empty .returning() result) or
  // succeeds (if first rolled back). This closes the TOCTOU window the
  // previous COUNT-then-INSERT guard left open at READ COMMITTED, where
  // two concurrent posts on different connections targeting the same
  // pre-existing transactionId could both pass the COUNT check before
  // either inserted.
  //
  // We deliberately use ON CONFLICT DO NOTHING + RETURNING (instead of
  // catching a 23505 unique_violation) because catching a unique
  // violation inside an open Postgres transaction aborts the whole
  // transaction — leaving us no clean path to translate the error to a
  // typed LedgerDoublePostError. With ON CONFLICT DO NOTHING the receipt
  // insert resolves cleanly either way, and we throw our typed error
  // explicitly so the outer caller's tx unwinds via a normal exception.
  //
  // We keep the receipt in its own table rather than putting a unique
  // index on ledger_entries.transactionId because the schema permits N
  // entries per transactionId (a balanced pair is two; future FX flows
  // may be more) — uniqueness lives at the transactionId level, not the
  // per-row level.
  //
  // SCOPE OF PROTECTION (after Task #37):
  //   - Catches retry-style double-posts (single connection re-runs).
  //   - Catches refactor-bug double-posts (two callers in one tx).
  //   - Catches concurrent double-posts (two transactions on different
  //     connections targeting the same pre-existing transactionId), which
  //     the COUNT-only guard could miss.
  // -----------------------------------------------------------------------
  const claim = await (handle as any)
    .insert(ledgerPostings)
    .values({ transactionId })
    .onConflictDoNothing()
    .returning({ transactionId: ledgerPostings.transactionId });

  if (claim.length === 0) {
    // Another tx already posted entries for this transactionId. Look up
    // the surviving entry count so the typed error carries an accurate
    // existingEntryCount for callers / reconciliation tooling.
    const [existing] = await (handle as any)
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, transactionId));
    const existingCount = Number(existing?.count ?? 0);
    throw new LedgerDoublePostError(transactionId, existingCount);
  }

  await (handle as any).insert(ledgerEntries).values(
    entries.map((entry) => ({
      transactionId,
      accountId: entry.accountId,
      userId: entry.userId,
      currency: entry.currency.toUpperCase(),
      direction: entry.direction,
      amount: entry.amount,
      description: entry.description,
    }))
  );
}

// ---------------------------------------------------------------------------
// SESSION 25 (Task #17) — Wallet cache refresh
// ---------------------------------------------------------------------------
// The wallets table carries a denormalised display balance (`balance`,
// `availableBalance`) used by the legacy UX layer for fast reads. After
// task #17 it is a CACHE only — the ledger is the source of truth.
//
// This is the ONLY function that may write `wallets.balance` /
// `wallets.availableBalance`. Every settlement path must call it inside the
// same DB transaction in which it just posted ledger entries, so the cache
// can never lag the ledger by more than the duration of that transaction.
//
// Behaviour:
//   - Recomputes SUM(ledger_entries) for (userId, currency)
//   - Locates the matching wallets row (one per (userId, currency) by unique
//     index). If no wallet row exists yet for this currency, the cache update
//     is a no-op — the wallet is auto-created by the wallet-creation paths;
//     not here.
//   - Writes the same value to both `balance` and `availableBalance`. We do
//     not yet model "pending holds" as a distinct cache; that lands with the
//     transaction-lifecycle work.
//   - NEVER mutates ledger_entries, accounts, or transactions.
// ---------------------------------------------------------------------------
export async function refreshWalletCacheBalance(
  handle: DbHandle,
  userId: number,
  currency: string,
): Promise<{ balance: string } | null> {
  const cur = currency.toUpperCase();
  const ledgerSum = await getUserCurrencyBalance(userId, cur, handle);

  const [updated] = await (handle as any)
    .update(wallets)
    .set({
      balance: ledgerSum,
      availableBalance: ledgerSum,
      updatedAt: new Date(),
    })
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, cur)))
    .returning();

  if (!updated) return null;
  return { balance: ledgerSum };
}

// ---------------------------------------------------------------------------
// Task #22 — bulk ledger-sum reader for the wallet/balance API surface
// ---------------------------------------------------------------------------
// Used by /api/wallets (and any future endpoint returning a per-currency
// wallet breakdown) to compute the AUTHORITATIVE per-currency balance for
// every currency the user has any ledger activity in, in a single query.
//
// Why bulk: a per-wallet getUserCurrencyBalance() loop would issue N round
// trips to Postgres for what is fundamentally one GROUP BY. The wallet list
// endpoint is on the hot path of the dashboard and refetches every few
// seconds, so the round-trip count matters.
//
// Why not derive from the cache: the whole point of the transparency fields
// is to expose disagreement between the ledger and the cache. Reading the
// cache here would defeat that.
// ---------------------------------------------------------------------------
export async function getUserLedgerSumsByCurrency(
  userId: number,
  handle: DbHandle = db,
): Promise<Map<string, string>> {
  const rows: Array<{ currency: string; balance: string }> = await (handle as any)
    .select({
      currency: ledgerEntries.currency,
      balance: sql<string>`
        COALESCE(SUM(
          CASE
            WHEN ${ledgerEntries.direction} = 'credit' THEN ${ledgerEntries.amount}
            ELSE -${ledgerEntries.amount}
          END
        ), 0)
      `,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))
    .groupBy(ledgerEntries.currency);

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(String(row.currency).toUpperCase(), String(row.balance ?? "0"));
  }
  return map;
}
