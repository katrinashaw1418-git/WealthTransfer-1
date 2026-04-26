// =============================================================================
// POSTING-RECEIPT INVARIANT — Task #63
// =============================================================================
// Self-healing replacement for the manual "re-run scripts/backfill-ledger-postings.ts
// after every deploy" runbook step that has been required since Task #37
// introduced `ledger_postings` (the DB-level lock the double-post guard in
// `postLedgerEntries()` relies on).
//
// THE INVARIANT
//   For every distinct `transaction_id` that has rows in `ledger_entries`,
//   there MUST be a matching row in `ledger_postings`. A missing receipt
//   means a future `postLedgerEntries()` call against that transactionId
//   would silently slip past the guard and post a second balanced pair —
//   silently breaking the books. The backfill script writes the missing
//   receipts; this check catches the situation BEFORE the next bad post,
//   so ops can re-run it (or, in future, we can wire an auto-heal).
//
// HOW
//   - Compares `COUNT(DISTINCT transaction_id) FROM ledger_entries` (where
//     transaction_id IS NOT NULL) against `COUNT(*) FROM ledger_postings`.
//   - Alerts on ANY divergence — both directions. Missing receipts are the
//     primary failure mode (the runbook step everyone forgets), but
//     `receipts > txWithEntries` is also a real anomaly: it would mean the
//     receipt table contains rows whose corresponding ledger entries were
//     deleted out-of-band, which is its own audit problem.
//   - When receipts are missing, fetches a bounded sample of the offending
//     transaction ids (the LEFT JOIN finds them directly) so the alert is
//     actionable — operators can immediately tell which transactions are
//     unprotected.
//   - Dispatches a single operator alert via `notifyOperator()` so it lands
//     in the same audit table and webhook channel as the wallet/ledger
//     reconciliation alerts. Severity = "alert" — this is a real correctness
//     gap, not a transient warning.
//
// CALLED FROM
//   server/index.ts — once at boot (so a deploy that forgot the runbook
//   step is caught within seconds) and once per day (so a snapshot restore
//   or out-of-band data import is caught by the next tick).
// =============================================================================

import { sql } from "drizzle-orm";
import { db } from "../db";
import { notifyOperator } from "./operator-alerts";

// Cap the number of missing-tx ids we attach to the alert payload. We do
// not want the alert details blob to balloon if a fresh environment has
// thousands of historical transactions awaiting backfill — the count alone
// is enough to convey scope, the sample is enough to spot-check.
export const MISSING_TX_SAMPLE_LIMIT = 20;

export interface PostingReceiptInvariantResult {
  /** Distinct transactionIds present in ledger_entries (excluding NULLs). */
  txWithEntries: number;
  /** Total rows in ledger_postings. */
  receipts: number;
  /**
   * txWithEntries - receipts. Positive = receipts missing (the common case
   * the runbook step exists for). Negative = orphan receipts (entries were
   * deleted out-of-band — a different but equally alert-worthy anomaly).
   * Zero means the invariant holds.
   */
  missingCount: number;
  /** Bounded sample of the offending transactionIds (capped at MISSING_TX_SAMPLE_LIMIT). */
  missingSample: number[];
  /** True when an operator alert was dispatched this run. */
  alertDispatched: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Typed extraction helpers for db.execute() results
// ---------------------------------------------------------------------------
// `db.execute(sql\`...\`)` returns the underlying driver row shape, which
// Drizzle types only loosely. Rather than littering the invariant code with
// `as any` casts (which would be both an AI-slop signal and a real
// correctness risk for a money-correctness check), we centralise the
// row-extraction pattern here. The runtime shape is "an object with `.rows`
// containing an array of row objects" for both pg and neon-serverless
// drivers; if either ever changes we hit this helper, not five call sites.
// ---------------------------------------------------------------------------
function extractRows<T>(result: unknown): T[] {
  const r = result as { rows?: unknown } | null | undefined;
  if (r && Array.isArray(r.rows)) {
    return r.rows as T[];
  }
  // Some Drizzle/driver combinations return the array directly; tolerate
  // that shape so we do not regress when the driver layer changes.
  if (Array.isArray(result)) {
    return result as T[];
  }
  return [];
}

function readCount(result: unknown): number {
  const rows = extractRows<{ n: number | string | null }>(result);
  const raw = rows[0]?.n;
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Run the invariant check and, if it fails, page an operator. Returns a
 * structured summary so the caller (and tests) can assert on the outcome.
 *
 * Never throws on alert-dispatch failure — `notifyOperator` is fire-and-forget
 * by design, and so is this check (a flaky alert path must not crash the
 * boot sequence or the daily cron).
 */
export async function runPostingReceiptInvariantCheck(): Promise<PostingReceiptInvariantResult> {
  const startedAt = Date.now();

  // Two independent counts. Doing them as a single query would be marginally
  // cheaper but obscures intent; both tables are small relative to the work
  // already done at boot.
  const txRes = await db.execute(
    sql`SELECT COUNT(DISTINCT transaction_id)::int AS n
        FROM ledger_entries
        WHERE transaction_id IS NOT NULL`,
  );
  const receiptsRes = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM ledger_postings`,
  );

  const txWithEntries = readCount(txRes);
  const receipts = readCount(receiptsRes);
  const missingCount = txWithEntries - receipts;

  // The LEFT JOIN below is the source of truth for "which ids are missing"
  // — it identifies every transactionId that has entries but no receipt,
  // which is the strict superset of cases the count comparison can flag
  // when missingCount > 0. We only run it in that direction; for the
  // negative-divergence case (orphan receipts) the offending ids would
  // need a different LEFT JOIN, and that anomaly is rare enough that
  // sample collection can land in a follow-up.
  let missingSample: number[] = [];
  if (missingCount > 0) {
    const missingRes = await db.execute(sql`
      SELECT DISTINCT le.transaction_id AS "transactionId"
      FROM ledger_entries le
      LEFT JOIN ledger_postings lp ON lp.transaction_id = le.transaction_id
      WHERE le.transaction_id IS NOT NULL
        AND lp.transaction_id IS NULL
      ORDER BY le.transaction_id
      LIMIT ${MISSING_TX_SAMPLE_LIMIT}
    `);
    const rows = extractRows<{ transactionId: number | string }>(missingRes);
    missingSample = rows
      .map((r) => Number(r.transactionId))
      .filter((n) => Number.isFinite(n));
  }

  // Alert on ANY divergence (both directions), not just missing receipts.
  // The two cases are operationally distinct so we use different titles
  // and remediation strings — the runbook backfill only fixes one of them.
  const divergent = txWithEntries !== receipts;
  let alertDispatched = false;
  if (divergent) {
    const orphanReceipts = missingCount < 0;
    const title = orphanReceipts
      ? `ledger_postings has ${Math.abs(missingCount)} orphan receipt(s) — investigate`
      : `ledger_postings missing ${missingCount} receipt(s) — re-run scripts/backfill-ledger-postings.ts`;
    const remediation = orphanReceipts
      ? "Receipts exist for transactionIds that have NO ledger_entries rows. " +
        "Either ledger entries were deleted out-of-band (audit problem) or a " +
        "receipt was inserted without a posting. Investigate the orphan ids " +
        "directly in ledger_postings before deleting anything."
      : "Run `npx tsx scripts/backfill-ledger-postings.ts` against the affected database. The script is idempotent.";
    try {
      await notifyOperator({
        source: "posting-receipt-invariant",
        severity: "alert",
        title,
        details: {
          txWithEntries,
          receipts,
          missingCount,
          missingSample,
          missingSampleCapped:
            missingCount > 0 && missingCount > missingSample.length,
          divergenceDirection: orphanReceipts
            ? "orphan_receipts"
            : "missing_receipts",
          remediation,
        },
      });
      alertDispatched = true;
    } catch (err) {
      // notifyOperator already swallows its own failures, so reaching this
      // catch implies a synchronous throw before even the log channel ran.
      // Surface it loudly but do not propagate — the same fire-and-forget
      // contract the wallet-ledger reconciliation cron uses.
      console.error(
        "[posting-receipt-invariant] notifyOperator threw unexpectedly",
        (err as Error)?.message ?? err,
      );
    }
  }

  return {
    txWithEntries,
    receipts,
    missingCount,
    missingSample,
    alertDispatched,
    durationMs: Date.now() - startedAt,
  };
}
