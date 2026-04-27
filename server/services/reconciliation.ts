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
  users,
  wallets,
  walletLedgerReconciliations,
  walletLedgerDriftAcknowledgements,
  type InsertReconciliation,
  type InsertWalletLedgerReconciliation,
  type WalletLedgerDriftAcknowledgement,
} from "@shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getUserCurrencyBalance } from "./ledger";
import { notifyOperator, type OperatorAlertSeverity } from "./operator-alerts";

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
  //
  //    Task #143 — exclude users flagged `is_demo = true`. Their balances
  //    exist purely so the dev/demo UI has realistic content; they were
  //    never posted through the ledger and would otherwise generate
  //    misleading drift rows in the reconciliations audit trail.
  const pairs = await db
    .selectDistinct({
      userId: ledgerEntries.userId,
      currency: ledgerEntries.currency,
    })
    .from(ledgerEntries)
    .leftJoin(users, eq(users.id, ledgerEntries.userId))
    .where(sql`${users.isDemo} IS NOT TRUE`);

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
  // Task #25 — count of operator notifications dispatched this run. One per
  // mismatched (user, currency) pair. Surfaced so the cron caller can log
  // "alerts dispatched: N" and ops can verify the notification path is firing.
  operatorNotifications: number;
  // Task #35 — count of operator notifications SUPPRESSED because the
  // (user, currency) pair has an active acknowledgement and the drift has
  // not moved by more than MATCH_EPSILON since the ack was recorded.
  // Surfaced so ops can confirm the suppression is firing as intended.
  operatorNotificationsSuppressed: number;
};

// ---------------------------------------------------------------------------
// Task #35 — drift acknowledgement lookup
// ---------------------------------------------------------------------------
// Fetch the most recent ACTIVE acknowledgement (clearedAt IS NULL) for a
// (userId, currency) pair. The partial unique index `wallet_ledger_drift_ack_active_uidx`
// guarantees at most one such row exists, so the LIMIT 1 is defensive only.
// Returns null when no active ack is on file — i.e. the dispatcher should
// page operators normally.
// ---------------------------------------------------------------------------
async function getActiveDriftAcknowledgement(
  userId: number,
  currency: string,
): Promise<WalletLedgerDriftAcknowledgement | null> {
  const [row] = await db
    .select()
    .from(walletLedgerDriftAcknowledgements)
    .where(
      and(
        eq(walletLedgerDriftAcknowledgements.userId, userId),
        eq(walletLedgerDriftAcknowledgements.currency, currency),
        isNull(walletLedgerDriftAcknowledgements.clearedAt),
      ),
    )
    .orderBy(desc(walletLedgerDriftAcknowledgements.acknowledgedAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Task #35 — suppression decision
// ---------------------------------------------------------------------------
// Given the drift the current reconciliation pass observed and a previously
// recorded acknowledgement, decide whether to dispatch a fresh operator
// notification. Suppression rule:
//   - If |currentDrift - acknowledgedDrift| <= MATCH_EPSILON, suppress.
//     "The situation is unchanged; ops already know."
//   - Otherwise, the drift has materially moved since the snapshot — fire
//     a new alert so ops can re-evaluate.
//
// Comparing SIGNED drift (rather than absolute magnitude) catches both
// growth in the same direction AND a sign-flip that happens to keep the
// magnitude similar — both of which are real changes ops needs to see.
// ---------------------------------------------------------------------------
function shouldSuppressNotification(
  currentDrift: number,
  ack: WalletLedgerDriftAcknowledgement,
): boolean {
  const ackDrift = Number(ack.acknowledgedDriftAmount);
  const change = Math.abs(currentDrift - ackDrift);
  return change <= MATCH_EPSILON;
}

export async function runWalletLedgerReconciliation(): Promise<WalletLedgerReconciliationSummary> {
  // Union the two sides so a wallet row that has zero ledger activity (and
  // vice versa: a ledger entry against a user with no wallet row yet) is
  // still examined. The alternative — iterating only one side — silently
  // hides a category of drift.
  //
  // Task #143 — exclude users flagged `is_demo = true` (the seeded
  // wiseinvestor / wiseadviser / wise demo accounts). Their wallet rows
  // carry illustrative balances that were never posted through the ledger,
  // so reconciling them produces a permanent flood of mismatch rows AND
  // operator alerts that have no real-money meaning. The skip happens at
  // the SOURCE — neither a `wallet_ledger_reconciliations` row nor an
  // `operator_alerts` row is created for these users on subsequent runs.
  const pairsRaw = await db.execute(sql`
    SELECT user_id AS "userId", currency
    FROM (
      SELECT user_id, currency FROM ${wallets}
      UNION
      SELECT user_id, currency FROM ${ledgerEntries}
    ) AS combined
    WHERE user_id NOT IN (SELECT id FROM ${users} WHERE is_demo = true)
    GROUP BY user_id, currency
  `);

  const pairs = (pairsRaw as any).rows ?? (pairsRaw as any) ?? [];

  const summary: WalletLedgerReconciliationSummary = {
    pairsChecked: pairs.length,
    matches: 0,
    mismatches: 0,
    alerts: 0,
    criticals: 0,
    operatorNotifications: 0,
    operatorNotificationsSuppressed: 0,
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

      // -----------------------------------------------------------------
      // Task #25 + Task #35 — operator notification (with ack-based suppression)
      // -----------------------------------------------------------------
      // Any drift above MATCH_EPSILON (i.e. status === "mismatch") pages
      // an operator UNLESS an active acknowledgement exists for this
      // (userId, currency) pair AND the drift has not moved by more than
      // MATCH_EPSILON since the ack was recorded. In that case ops already
      // know about the case and re-paging would just be alert fatigue.
      //
      // The reconciliation row itself is ALWAYS written (the audit trail
      // must show drift continued to exist); only the notification
      // dispatch is suppressed. We also append a one-line note to the row
      // so admins reading the listing can see "alert suppressed because
      // acknowledged on YYYY-MM-DD".
      //
      // We map our internal severity onto the operator-alert severity 1:1
      // ("none" is unreachable here because absDrift >= MATCH_EPSILON
      // guarantees severity is at minimum "info").
      // -----------------------------------------------------------------
      const opSeverity: OperatorAlertSeverity =
        severity === "critical" || severity === "alert" || severity === "warning"
          ? severity
          : "info";

      const ack = await getActiveDriftAcknowledgement(userId, currency);
      const suppress = ack !== null && shouldSuppressNotification(drift, ack);

      if (suppress && ack) {
        const ackDate = ack.acknowledgedAt.toISOString().slice(0, 10);
        const suppressionLine =
          `Operator alert suppressed: drift acknowledged on ${ackDate} ` +
          `(snapshot ${Number(ack.acknowledgedDriftAmount).toFixed(8)} ${currency}, ` +
          `current ${drift.toFixed(8)} ${currency}).`;
        notes = notes ? `${notes} ${suppressionLine}` : suppressionLine;
        summary.operatorNotificationsSuppressed += 1;
        console.log(
          "[wallet-ledger-reconciliation] operator alert suppressed (acknowledged)",
          {
            userId,
            currency,
            acknowledgementId: ack.id,
            acknowledgedAt: ack.acknowledgedAt,
            acknowledgedDriftAmount: ack.acknowledgedDriftAmount,
            currentDriftAmount: drift.toFixed(8),
          },
        );
      } else {
        if (ack) {
          // Ack exists but drift has moved materially — record why we are
          // re-paging despite the acknowledgement, so the audit trail makes
          // the decision auditable.
          notes = notes
            ? `${notes} Drift moved beyond MATCH_EPSILON since acknowledgement on ${ack.acknowledgedAt
                .toISOString()
                .slice(0, 10)} — re-paging.`
            : `Drift moved beyond MATCH_EPSILON since acknowledgement on ${ack.acknowledgedAt
                .toISOString()
                .slice(0, 10)} — re-paging.`;
          console.warn(
            "[wallet-ledger-reconciliation] re-paging despite acknowledgement (drift moved)",
            {
              userId,
              currency,
              acknowledgementId: ack.id,
              acknowledgedDriftAmount: ack.acknowledgedDriftAmount,
              currentDriftAmount: drift.toFixed(8),
              changeAbs: Math.abs(drift - Number(ack.acknowledgedDriftAmount)).toFixed(8),
            },
          );
        }
        try {
          await notifyOperator({
            source: "wallet-ledger-reconciliation",
            severity: opSeverity,
            title: `Wallet cache drift detected for user ${userId} (${currency})`,
            details: {
              userId,
              currency,
              walletCachedBalance: cached,
              ledgerSumBalance: ledgerSum,
              driftAmount: drift.toFixed(8),
            },
          });
          summary.operatorNotifications += 1;
        } catch (err) {
          // notifyOperator is designed to swallow its own errors; this
          // catch is belt-and-braces so a hypothetical synchronous throw
          // can never abort the loop and skip remaining pairs.
          console.error(
            "[wallet-ledger-reconciliation] notifyOperator threw unexpectedly",
            { userId, currency, err: (err as Error)?.message ?? err },
          );
        }
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

// =============================================================================
// SESSION 28 (Task #35) — DRIFT ACKNOWLEDGEMENT HELPERS
// =============================================================================
// Tiny service-layer helpers consumed by the admin route layer. The admin
// route layer is where authn/authz/audit happens; these helpers are pure
// data-layer operations so the same logic can be unit-tested in isolation.
// =============================================================================

export class DriftAckConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftAckConflictError";
  }
}

export class DriftAckNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftAckNotFoundError";
  }
}

export class DriftAckNoMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftAckNoMismatchError";
  }
}

/**
 * Acknowledge a drift case for (userId, currency).
 *
 * Snapshots the CURRENT drift (live-computed from `wallets` vs ledger sum,
 * not from the most recent reconciliation row — that row may be stale by
 * up to 24h) so the dispatcher can later decide whether the situation has
 * materially changed.
 *
 * Throws:
 *   - `DriftAckConflictError` when an active ack already exists for this pair
 *     (caller maps to 409). The partial unique index also prevents the insert
 *     at the DB level so this is a defence-in-depth check.
 *   - `DriftAckNoMismatchError` when the live drift is below MATCH_EPSILON —
 *     there is nothing to acknowledge.
 */
export async function acknowledgeWalletLedgerDrift(opts: {
  userId: number;
  currency: string;
  note: string | null;
  actorUserId: number;
}): Promise<WalletLedgerDriftAcknowledgement> {
  const { userId, currency, note, actorUserId } = opts;

  // Live-compute the drift right now so we snapshot the truth, not a stale
  // reconciliation row.
  const ledgerSum = await getUserCurrencyBalance(userId, currency);
  const [walletRow] = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(sql`${wallets.userId} = ${userId} AND ${wallets.currency} = ${currency}`);
  const cached = walletRow?.balance ?? "0";
  const drift = Number(cached) - Number(ledgerSum);

  if (Math.abs(drift) < MATCH_EPSILON) {
    throw new DriftAckNoMismatchError(
      `No drift to acknowledge for user ${userId} (${currency}); cached and ledger agree within tolerance.`,
    );
  }

  // Defence-in-depth: surface a friendly 409 before the partial unique index
  // would also reject the insert.
  const existing = await getActiveDriftAcknowledgement(userId, currency);
  if (existing) {
    throw new DriftAckConflictError(
      `Active acknowledgement #${existing.id} already exists for user ${userId} (${currency}).`,
    );
  }

  try {
    const [inserted] = await db
      .insert(walletLedgerDriftAcknowledgements)
      .values({
        userId,
        currency,
        acknowledgedDriftAmount: drift.toFixed(8),
        note,
        acknowledgedByUserId: actorUserId,
      })
      .returning();
    return inserted;
  } catch (err: any) {
    // 23505 = unique_violation. The partial unique index would only fire
    // if a concurrent ack snuck in between our SELECT and INSERT.
    if (err?.code === "23505") {
      throw new DriftAckConflictError(
        `Active acknowledgement already exists for user ${userId} (${currency}).`,
      );
    }
    throw err;
  }
}

/**
 * Clear the active acknowledgement for (userId, currency). Sets clearedAt /
 * clearedByUserId / clearReason on the row but does not delete it — the
 * audit trail of "this was acknowledged from X to Y" must persist.
 *
 * Throws `DriftAckNotFoundError` when there is no active ack to clear.
 */
export async function clearWalletLedgerDriftAcknowledgement(opts: {
  userId: number;
  currency: string;
  actorUserId: number;
  reason: string | null;
}): Promise<WalletLedgerDriftAcknowledgement> {
  const { userId, currency, actorUserId, reason } = opts;

  // Conditional UPDATE: target only the active row. If two admins race to
  // clear, the loser sees a 0-row update and gets a 404 — which is correct.
  const [updated] = await db
    .update(walletLedgerDriftAcknowledgements)
    .set({
      clearedAt: new Date(),
      clearedByUserId: actorUserId,
      clearReason: reason,
    })
    .where(
      and(
        eq(walletLedgerDriftAcknowledgements.userId, userId),
        eq(walletLedgerDriftAcknowledgements.currency, currency),
        isNull(walletLedgerDriftAcknowledgements.clearedAt),
      ),
    )
    .returning();

  if (!updated) {
    throw new DriftAckNotFoundError(
      `No active acknowledgement for user ${userId} (${currency}).`,
    );
  }
  return updated;
}
