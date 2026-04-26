// =============================================================================
// LEDGER RECONCILIATION SERVICE — Session 8
// =============================================================================
// Periodic verification that the internal double-entry ledger agrees with what
// our regulated custodian partners report. The ledger is the system of record
// for what AMAX *believes* is true; the custodian is the system of record for
// what is *actually* true. Any divergence is either a bug in our settlement
// pipeline, a missed posting, or an external problem at the partner — and all
// three need a paper trail.
//
// Design rules:
//   1. Reconciliation never mutates the ledger. It only observes and records.
//   2. A "match" is `abs(internal - external) < MATCH_EPSILON` (currently 0.01).
//   3. "external_unavailable" is its own status — distinct from "mismatch" —
//      because a custodian outage is a verification failure, not evidence of
//      drift. Conflating them silently hides feed outages.
//   4. Severity is computed from the magnitude of `abs(diff)` per the alert
//      thresholds in ALERT_THRESHOLDS below.
//   5. The custodian fetcher is a stub returning `null` (NOT "0") until the
//      partner integration lands in Session 9. Returning "0" would silently
//      generate false mismatches against every real internal balance; returning
//      `null` correctly produces `external_unavailable` rows so the audit trail
//      records "we attempted verification and could not". This is the *expected*
//      output of Phase 1.
// =============================================================================

import { db } from "../db";
import {
  ledgerEntries,
  reconciliations,
  wallets,
  walletLedgerReconciliations,
  type InsertReconciliation,
  type InsertWalletLedgerReconciliation,
} from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { getUserCurrencyBalance } from "./ledger";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
// Note: thresholds are evaluated against `abs(diff)` in the SOURCE currency
// units (no FX conversion yet). For fiat (AUD/USD) this is dollars; for crypto
// (BTC/ETH) this is the native unit. A 0.01 BTC drift is materially larger
// than a $0.01 AUD drift — Session 9 will introduce per-currency thresholds.
// ---------------------------------------------------------------------------
// Exported so the wallet/balance API surface (Task #22) can reuse the SAME
// drift tolerance the cron-driven wallet-vs-ledger reconciliation uses.
// Introducing a second tolerance constant elsewhere would silently let the UI
// disagree with the reconciliation page about whether a wallet is "clean".
export const MATCH_EPSILON = 0.01;   // below this: status = match
const SEVERITY_WARN = 1;             // ≥ $1: log a warning
const SEVERITY_ALERT = 100;          // ≥ $100: alert (console.error)
const SEVERITY_CRITICAL = 1000;      // ≥ $1000: critical (console.error + emphasis)

export type ReconciliationSeverity =
  | "none"
  | "info"
  | "warning"
  | "alert"
  | "critical";

export type ReconciliationStatus = "match" | "mismatch" | "external_unavailable";

function classifySeverity(absDiff: number): ReconciliationSeverity {
  if (absDiff < MATCH_EPSILON) return "none";
  if (absDiff < SEVERITY_WARN) return "info";
  if (absDiff < SEVERITY_ALERT) return "warning";
  if (absDiff < SEVERITY_CRITICAL) return "alert";
  return "critical";
}

// ---------------------------------------------------------------------------
// Custodian stub
// ---------------------------------------------------------------------------
// Returns a string-encoded balance to preserve decimal precision on the way
// in. Returns null when the custodian is unreachable / unconfigured — callers
// must treat null as "verification could not be performed", NOT as zero.
// ---------------------------------------------------------------------------
export async function fetchCustodianBalance(
  _userId: number,
  _currency: string
): Promise<string | null> {
  // Phase 1 stub: no partner is connected yet. Return null so we record
  // "external_unavailable" instead of falsely claiming a $0 external balance —
  // which would generate a flood of fake mismatches against every real balance.
  // Session 9 will replace this with the partner SDK call.
  return null;
}

// ---------------------------------------------------------------------------
// Run reconciliation across every (userId, currency) pair that has any
// ledger activity. Returns a summary so the cron caller can log a one-line
// completion message without needing to query the table.
// ---------------------------------------------------------------------------

export type ReconciliationSummary = {
  pairsChecked: number;
  matches: number;
  mismatches: number;
  externalUnavailable: number;
  alerts: number;
  criticals: number;
};

export async function runLedgerReconciliation(): Promise<ReconciliationSummary> {
  // 1. Find every (userId, currency) pair with at least one ledger entry.
  //    Pairs with zero entries don't need reconciliation — there's nothing
  //    on our side to compare against.
  const pairs = await db
    .selectDistinct({
      userId: ledgerEntries.userId,
      currency: ledgerEntries.currency,
    })
    .from(ledgerEntries);

  const summary: ReconciliationSummary = {
    pairsChecked: pairs.length,
    matches: 0,
    mismatches: 0,
    externalUnavailable: 0,
    alerts: 0,
    criticals: 0,
  };

  for (const pair of pairs) {
    const internal = await getUserCurrencyBalance(pair.userId, pair.currency);
    let external: string | null = null;
    try {
      external = await fetchCustodianBalance(pair.userId, pair.currency);
    } catch (err) {
      // Custodian fetcher exception is operationally identical to the fetcher
      // returning null — both mean "we couldn't verify". Treat them the same.
      console.error(
        "[reconciliation] custodian fetch failed",
        { userId: pair.userId, currency: pair.currency, err: (err as Error)?.message }
      );
      external = null;
    }

    let status: ReconciliationStatus;
    let severity: ReconciliationSeverity;
    let difference: string | null = null;
    let notes: string | null = null;

    if (external === null) {
      // Verification could not be performed — record it explicitly.
      status = "external_unavailable";
      severity = "warning";
      notes = "Custodian balance unavailable; reconciliation could not be performed.";
      summary.externalUnavailable += 1;
      console.warn(
        "[reconciliation] external balance unavailable",
        { userId: pair.userId, currency: pair.currency, internalBalance: internal }
      );
    } else {
      const internalNum = Number(internal);
      const externalNum = Number(external);
      const diff = internalNum - externalNum;
      const absDiff = Math.abs(diff);
      difference = diff.toFixed(8);
      severity = classifySeverity(absDiff);

      if (absDiff < MATCH_EPSILON) {
        status = "match";
        summary.matches += 1;
      } else {
        status = "mismatch";
        summary.mismatches += 1;

        const payload = {
          userId: pair.userId,
          currency: pair.currency,
          internalBalance: internal,
          externalBalance: external,
          difference,
        };

        if (severity === "critical") {
          summary.criticals += 1;
          console.error("[RECONCILIATION CRITICAL] *** LARGE LEDGER DRIFT ***", payload);
        } else if (severity === "alert") {
          summary.alerts += 1;
          console.error("[RECONCILIATION ALERT]", payload);
        } else if (severity === "warning") {
          console.warn("[reconciliation] mismatch", payload);
        } else {
          // severity === "info" — small drift, logged at info level for trend visibility
          console.log("[reconciliation] minor drift", payload);
        }
      }
    }

    const row: InsertReconciliation = {
      userId: pair.userId,
      currency: pair.currency,
      internalBalance: internal,
      externalBalance: external,
      difference,
      status,
      severity,
      notes,
    };

    await db.insert(reconciliations).values(row);
  }

  return summary;
}

// =============================================================================
// SESSION 25 (Task #17) — WALLET ↔ LEDGER RECONCILIATION
// =============================================================================
// LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
//
// Companion to runLedgerReconciliation() above. Where that one compares the
// internal ledger against the external custodian, this one compares the
// CACHED wallet display balance (`wallets.balance`) against the AUTHORITATIVE
// ledger sum (`SUM(ledger_entries)`) for every (userId, currency) pair we
// know about (either side).
//
// Hard rules:
//   1. NEVER mutates the ledger.
//   2. NEVER mutates the wallet cache. (If it did, drift would silently
//      heal itself and we'd lose the audit trail of "this got out of sync".)
//   3. Every (userId, currency) pair gets exactly one row inserted per run,
//      so the admin Reconciliation page can show "the most recent check".
//   4. Any non-zero drift over the match epsilon is logged at error level
//      with the same severity classifier the custodian reconciliation uses.
// =============================================================================

export type WalletLedgerReconciliationSummary = {
  pairsChecked: number;
  matches: number;
  mismatches: number;
  alerts: number;
  criticals: number;
};

export async function runWalletLedgerReconciliation(): Promise<WalletLedgerReconciliationSummary> {
  // Union the two sides so a wallet row that has zero ledger activity (and
  // vice versa: a ledger entry against a user with no wallet row yet) is
  // still examined. The alternative — iterating only one side — silently
  // hides a category of drift.
  const pairsRaw = await db.execute(sql`
    SELECT user_id AS "userId", currency
    FROM (
      SELECT user_id, currency FROM ${wallets}
      UNION
      SELECT user_id, currency FROM ${ledgerEntries}
    ) AS combined
    GROUP BY user_id, currency
  `);

  const pairs = (pairsRaw as any).rows ?? (pairsRaw as any) ?? [];

  const summary: WalletLedgerReconciliationSummary = {
    pairsChecked: pairs.length,
    matches: 0,
    mismatches: 0,
    alerts: 0,
    criticals: 0,
  };

  for (const pair of pairs as Array<{ userId: number; currency: string }>) {
    const userId = Number(pair.userId);
    const currency = String(pair.currency);

    // Authoritative side: SUM(ledger_entries).
    const ledgerSum = await getUserCurrencyBalance(userId, currency);

    // Cached side: wallets.balance for this (user, currency). May be absent
    // (no wallet row for this currency yet) — treat as "0" so the drift
    // surfaces as the full ledger amount.
    const [walletRow] = await db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(sql`${wallets.userId} = ${userId} AND ${wallets.currency} = ${currency}`);

    const cached = walletRow?.balance ?? "0";

    const cachedNum = Number(cached);
    const ledgerNum = Number(ledgerSum);
    const drift = cachedNum - ledgerNum;
    const absDrift = Math.abs(drift);
    const severity = classifySeverity(absDrift);

    let status: "match" | "mismatch";
    let notes: string | null = null;

    if (absDrift < MATCH_EPSILON) {
      status = "match";
      summary.matches += 1;
    } else {
      status = "mismatch";
      summary.mismatches += 1;
      notes = walletRow
        ? `Wallet cache disagrees with ledger by ${drift.toFixed(8)} ${currency}.`
        : `No wallet row for ${currency} but ledger sum is ${ledgerSum}; cache assumed 0.`;

      const payload = {
        userId,
        currency,
        walletCachedBalance: cached,
        ledgerSumBalance: ledgerSum,
        driftAmount: drift.toFixed(8),
      };

      if (severity === "critical") {
        summary.criticals += 1;
        console.error("[WALLET-LEDGER RECONCILIATION CRITICAL] *** LARGE WALLET-CACHE DRIFT ***", payload);
      } else if (severity === "alert") {
        summary.alerts += 1;
        console.error("[WALLET-LEDGER RECONCILIATION ALERT]", payload);
      } else if (severity === "warning") {
        console.warn("[wallet-ledger-reconciliation] mismatch", payload);
      } else {
        console.log("[wallet-ledger-reconciliation] minor drift", payload);
      }
    }

    const row: InsertWalletLedgerReconciliation = {
      userId,
      currency,
      walletCachedBalance: cached,
      ledgerSumBalance: ledgerSum,
      driftAmount: drift.toFixed(8),
      status,
      severity,
      notes,
    };

    await db.insert(walletLedgerReconciliations).values(row);
  }

  return summary;
}
