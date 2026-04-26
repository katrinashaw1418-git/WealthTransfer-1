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
// =============================================================================

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { accounts, ledgerEntries, wallets } from "@shared/schema";

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
    throw new Error(
      `Ledger entries are not balanced: credits=${totalCredits}, debits=${totalDebits}`
    );
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
