// =============================================================================
// CLEANUP — pre-launch residue blocking the wallet-ledger + posting-receipt
// gates from passing in --strict mode (Tasks #159, #158, #181)
// =============================================================================
//
// What this fixes:
//
//   #159  posting-receipt invariant gate failed with "ledger_postings missing
//         2 receipt(s)". The two offenders are transactions #320 (description
//         "feegate test top-up") and #1124 (description "task35-test-seed").
//         BOTH are old single-leg test fixtures — written directly into
//         ledger_entries without going through postLedgerEntries(), which is
//         why no `ledger_postings` receipt exists for either of them. They
//         are also UNBALANCED (single credit row, no offsetting debit) and
//         therefore violate the double-entry invariant in their own right.
//         No FK references exist (audit_logs entity_type='transaction' rows
//         for these ids: 0; adviser_fee_deductions FKs to these ids: 0).
//         Safe to delete outright.
//
//   #181  wallet-ledger drift gate failed with "user 11 AUD: wallet=0,
//         ledger=30". User 11 is the platform `system` user. Its AUD `fee`
//         account (account_id=6) holds +30 from one un-reversed adviser fee
//         deduction (deduction #144, settled by transaction #321 — the
//         platform-share leg of a balanced 3-leg posting:
//           - user 43 (client): -100 AUD
//           - user 44 (adviser): +70 AUD
//           - user 11 (system fee): +30 AUD
//         The other test deductions in the database (#273, #277) DO have
//         their matching reversals — #144 was simply missed by the original
//         fixture run. Because txn #321 is referenced by
//         adviser_fee_deductions.settled_transaction_id, deletion is unsafe
//         (FK violation + would damage the audit trail). The correct fix
//         per the ledger's append-only contract is to POST a balanced
//         reversal (the same pattern the production code already uses for
//         every other reversal), then refresh the affected wallet caches.
//
//   #158  As a consequence of the two cuts above, refresh wallet caches for
//         users 43, 44, and 45 so they reflect the post-cleanup ledger sums.
//         User 11 (system) has no `wallets` row — the system fee account is
//         ledger-only, and the wallet-ledger drift gate treats a missing
//         wallet row as cache=0, which now matches a ledger sum of 0.
//
// Idempotency:
//   - Each step checks "already done" before mutating, so re-running this
//     script after a successful run is a no-op (and exits 0).
//   - All mutations run inside a single db.transaction so a partial failure
//     leaves no half-written state.
//
// Usage:
//   npx tsx scripts/cleanup-prelaunch-residue.ts
//
// Verification:
//   npx tsx scripts/pre-launch-safety.ts --strict
//   Expected: 10 PASS / 0 FAIL / 0 SKIP after this script has run.
// =============================================================================

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  transactions,
  ledgerEntries,
  ledgerPostings,
  adviserFeeDeductions,
} from "../shared/schema";
import {
  postLedgerEntries,
  refreshWalletCacheBalance,
} from "../server/services/ledger";

const PHANTOM_TX_IDS = [320, 1124];
const ORPHAN_DEDUCTION_ID = 144;
const SYSTEM_USER_ID = 11;
const ADMIN_USER_ID = 13; // `wise` — used as the reversed_by_user_id actor

async function main(): Promise<void> {
  console.log("[cleanup] starting pre-launch residue cleanup");

  await db.transaction(async (tx) => {
    // -----------------------------------------------------------------
    // Cut 2 (#159): delete phantom half-leg test transactions.
    // -----------------------------------------------------------------
    const phantomEntries = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, PHANTOM_TX_IDS));

    if (phantomEntries.length === 0) {
      console.log(
        `[cleanup] cut 2 already applied — no ledger_entries for txns ${PHANTOM_TX_IDS.join(", ")}`,
      );
    } else {
      // Receipts should not exist for these (the whole point — that's WHY
      // the invariant was tripping) but defensively delete in case a
      // partial-state run added one.
      await tx
        .delete(ledgerPostings)
        .where(inArray(ledgerPostings.transactionId, PHANTOM_TX_IDS));
      await tx
        .delete(ledgerEntries)
        .where(inArray(ledgerEntries.transactionId, PHANTOM_TX_IDS));
      await tx
        .delete(transactions)
        .where(inArray(transactions.id, PHANTOM_TX_IDS));
      console.log(
        `[cleanup] cut 2 done — deleted ${phantomEntries.length} ledger entries + ${PHANTOM_TX_IDS.length} transactions (${PHANTOM_TX_IDS.join(", ")})`,
      );
    }

    // -----------------------------------------------------------------
    // Cut 3 (#181): reverse adviser fee deduction #144.
    // -----------------------------------------------------------------
    const [deduction] = await tx
      .select()
      .from(adviserFeeDeductions)
      .where(eq(adviserFeeDeductions.id, ORPHAN_DEDUCTION_ID));

    if (!deduction) {
      console.log(
        `[cleanup] cut 3 skipped — adviser_fee_deductions #${ORPHAN_DEDUCTION_ID} not found`,
      );
    } else if (deduction.reversalTransactionId !== null) {
      console.log(
        `[cleanup] cut 3 already applied — deduction #${ORPHAN_DEDUCTION_ID} reversed by tx #${deduction.reversalTransactionId}`,
      );
    } else if (!deduction.settledTransactionId) {
      console.log(
        `[cleanup] cut 3 skipped — deduction #${ORPHAN_DEDUCTION_ID} has no settled_transaction_id (nothing to reverse)`,
      );
    } else {
      // Re-read the original posting so we mirror its exact account ids,
      // user ids, and amounts. This guarantees the reversal lands on the
      // SAME accounts (no chance of drift if account creation has shifted
      // ids since the original posting).
      const originalLegs = await tx
        .select({
          accountId: ledgerEntries.accountId,
          userId: ledgerEntries.userId,
          currency: ledgerEntries.currency,
          direction: ledgerEntries.direction,
          amount: ledgerEntries.amount,
          description: ledgerEntries.description,
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, deduction.settledTransactionId));

      if (originalLegs.length === 0) {
        throw new Error(
          `Cannot reverse deduction #${ORPHAN_DEDUCTION_ID}: settled tx ` +
            `#${deduction.settledTransactionId} has no ledger entries`,
        );
      }

      const reversalDescription =
        `Reversal of adviser fee deduction #${ORPHAN_DEDUCTION_ID} ` +
        `(${deduction.periodStart.toISOString().slice(0, 10)} → ` +
        `${deduction.periodEnd.toISOString().slice(0, 10)}) — ` +
        `pre-launch residue cleanup`;

      const [reversalTx] = await tx
        .insert(transactions)
        .values({
          userId: deduction.clientUserId,
          type: "adviser_fee_deduction_reversal",
          fromCurrency: null,
          toCurrency: null,
          amount: deduction.totalAccrued,
          fee: "0.00000000",
          exchangeRate: null,
          status: "completed",
          settlementStatus: "internal_only",
          description: reversalDescription,
          sourceExchange: null,
          blockchainTxHash: null,
        })
        .returning();

      // Mirror each original leg with FLIPPED direction. postLedgerEntries
      // checks the balance invariant, writes the receipt (closing the
      // posting-receipt invariant for this new transaction), and inserts
      // the rows in one go.
      const reversalEntries = originalLegs.map((leg) => ({
        accountId: leg.accountId,
        userId: leg.userId,
        currency: leg.currency,
        direction: leg.direction === "credit"
          ? ("debit" as const)
          : ("credit" as const),
        amount: leg.amount,
        description:
          (leg.description ?? `tx#${deduction.settledTransactionId} leg`) +
          " — reversal",
      }));

      await postLedgerEntries(reversalTx.id, reversalEntries, tx);

      await tx
        .update(adviserFeeDeductions)
        .set({
          reversedAt: new Date(),
          reversedByUserId: ADMIN_USER_ID,
          reversedReason:
            `Pre-launch residue cleanup (Task #181) — orphan fee residue on ` +
            `system fee account caused wallet-ledger drift gate to fail in --strict mode.`,
          reversalTransactionId: reversalTx.id,
        })
        .where(eq(adviserFeeDeductions.id, ORPHAN_DEDUCTION_ID));

      console.log(
        `[cleanup] cut 3 done — reversed deduction #${ORPHAN_DEDUCTION_ID} via new tx #${reversalTx.id} (${reversalEntries.length} balanced legs)`,
      );
    }
  });

  // -----------------------------------------------------------------
  // Cut 3b: refresh wallet caches for affected users so the cache
  // matches the new ledger sum. Done OUTSIDE the transaction because
  // refreshWalletCacheBalance writes to the wallets table — keeping it
  // in the same tx would be fine too, but separating the cleanup
  // (transactional) from the cache refresh (idempotent recompute)
  // makes a partial failure easier to recover from manually.
  // -----------------------------------------------------------------
  for (const userId of [43, 44, 45]) {
    const result = await refreshWalletCacheBalance(db, userId, "AUD");
    if (result) {
      console.log(
        `[cleanup] refreshed wallet cache user=${userId} AUD → balance=${result.balance}`,
      );
    } else {
      console.log(
        `[cleanup] no wallet row for user=${userId} AUD (skipped cache refresh)`,
      );
    }
  }

  // Final state report so the operator can eyeball the result.
  const driftRows = await db.execute<{
    user_id: number;
    currency: string;
    ledger_sum: string;
  }>(sql`
    SELECT a.user_id, a.currency,
           COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount ELSE -le.amount END), 0)::text AS ledger_sum
      FROM accounts a
      LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.user_id IN (${SYSTEM_USER_ID}, 43, 44, 45)
     GROUP BY a.user_id, a.currency
     ORDER BY a.user_id, a.currency
  `);
  console.log("[cleanup] post-cleanup ledger sums:");
  for (const row of (driftRows as any).rows ?? []) {
    console.log(
      `  user=${row.user_id} ${row.currency}: ${row.ledger_sum}`,
    );
  }

  console.log("[cleanup] complete");
}

main().catch((err) => {
  console.error("[cleanup] crashed:", err);
  process.exit(1);
});
