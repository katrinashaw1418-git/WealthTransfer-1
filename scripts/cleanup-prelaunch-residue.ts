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
//   #325  Cut 4 — Task #325 Gate-B fee-deduction test fixtures left 11 adviser
//         user accounts (`t325-gate-b-{ts}-adv@test.local`, IDs 251, 256,
//         264, 268, 275, 288, 295, 302, 307, 315, 320) with a stale wallet
//         cache for AUD: `wallets.balance=0` while `SUM(ledger_entries)=0.80`.
//         The ledger entries are CORRECT — they are the platform-share legs
//         posted as part of legitimate balanced fee deductions during the
//         Gate-B test runs — only the wallet-cache write was missed. Cut 4
//         calls the sanctioned `refreshWalletCacheBalance(db, userId, 'AUD')`
//         per pair to snap each cache to the live ledger sum. No ledger
//         mutations, no acknowledgement rows, no other users touched.
//
// Idempotency:
//   - Each step checks "already done" before mutating, so re-running this
//     script after a successful run is a no-op (and exits 0).
//   - All mutations run inside a single db.transaction so a partial failure
//     leaves no half-written state.
//
// Usage:
//   npx tsx scripts/cleanup-prelaunch-residue.ts            # mutating run
//   npx tsx scripts/cleanup-prelaunch-residue.ts --dry-run  # preview only
//
// Verification:
//   npx tsx scripts/pre-launch-safety.ts --strict
//   Expected: 10 PASS / 0 FAIL / 0 SKIP after this script has run.
//
// =============================================================================
// OPERATOR PRE-FLIGHT CHECKLIST (REQUIRED before running on production)
// =============================================================================
// The hardcoded IDs below (PHANTOM_TX_IDS, ORPHAN_DEDUCTION_ID, SYSTEM_USER_ID,
// ADMIN_USER_ID) were captured against the failing pre-launch snapshot
// referenced in the Task #181 description. They are environment-specific.
// Before running this script against ANY database other than the dev DB
// these IDs were captured on, the operator MUST verify they still describe
// the residue that needs to be cleaned. Run the script with `--dry-run`
// FIRST — it prints the resolved residue without mutating, so a mismatch
// is obvious before any write.
//
// Pre-flight SQL (run against the target DB first):
//
//   -- Cut 2 (#159): confirm the phantom-tx ids are still single-leg fixtures
//   --              with no FK references that would block deletion.
//   SELECT id, user_id, type, description
//     FROM transactions
//    WHERE id IN (320, 1124);
//   SELECT transaction_id, COUNT(*) AS legs,
//          SUM(CASE WHEN direction='credit' THEN amount::numeric
//                   ELSE -amount::numeric END) AS net
//     FROM ledger_entries
//    WHERE transaction_id IN (320, 1124)
//    GROUP BY transaction_id;
//   SELECT COUNT(*) FROM audit_logs
//    WHERE entity_type='transaction' AND entity_id IN ('320','1124');
//   SELECT id FROM adviser_fee_deductions
//    WHERE settled_transaction_id IN (320, 1124)
//       OR reversal_transaction_id IN (320, 1124);
//
//   -- Cut 3 (#181): confirm the orphan deduction is still un-reversed
//   --              and its settled tx still has the expected balanced legs.
//   SELECT id, client_user_id, settled_transaction_id, reversal_transaction_id
//     FROM adviser_fee_deductions
//    WHERE id = 144;
//   SELECT user_id, currency, direction, amount
//     FROM ledger_entries
//    WHERE transaction_id = (SELECT settled_transaction_id
//                              FROM adviser_fee_deductions WHERE id = 144);
//
// If ANY of those queries returns unexpected rows (different counts,
// different users, no rows where rows were expected, etc.) DO NOT run
// this script — open a new task with the captured snapshot and update
// the constants below.
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
const AFFECTED_WALLET_USER_IDS = [43, 44, 45];

// Cut 4 (#325) — Task #325 Gate-B fee-deduction test fixtures. These 11
// adviser users (`t325-gate-b-{ts}-adv@test.local`) were created during a
// Gate-B test run and each ended up with `wallets.balance=0` for AUD while
// `SUM(ledger_entries)=0.80` (the platform-share leg from a balanced fee
// deduction whose accompanying `refreshWalletCacheBalance` write was never
// performed). The ledger is correct; only the cache is stale. Cut 4 calls
// the sanctioned cache-flush helper for each (id, 'AUD') pair.
const STALE_FEEGATE_FIXTURE_USER_IDS = [
  251, 256, 264, 268, 275, 288, 295, 302, 307, 315, 320,
];
const STALE_FEEGATE_FIXTURE_CURRENCY = "AUD";

// --dry-run: resolve and PRINT the residue these IDs currently point at,
// then exit WITHOUT mutating. Lets the operator confirm the hardcoded IDs
// still describe the residue they think they do — required as the
// pre-flight check before running this script against any database other
// than the dev DB the IDs were originally captured against (see
// "OPERATOR PRE-FLIGHT CHECKLIST" in the file header).
const DRY_RUN = process.argv.includes("--dry-run");

async function previewResidue(): Promise<void> {
  console.log("[cleanup] === DRY RUN — no mutations will be performed ===");
  console.log(
    `[cleanup] hardcoded constants: PHANTOM_TX_IDS=${JSON.stringify(
      PHANTOM_TX_IDS,
    )}, ORPHAN_DEDUCTION_ID=${ORPHAN_DEDUCTION_ID}, ` +
      `SYSTEM_USER_ID=${SYSTEM_USER_ID}, ADMIN_USER_ID=${ADMIN_USER_ID}, ` +
      `AFFECTED_WALLET_USER_IDS=${JSON.stringify(AFFECTED_WALLET_USER_IDS)}`,
  );

  // Cut 2 (#159) preview — phantom-tx legs + balance + FK refs.
  const phantomLegs = await db.execute<{
    transaction_id: number;
    legs: number;
    net: string;
  }>(sql`
    SELECT transaction_id, COUNT(*)::int AS legs,
           COALESCE(SUM(CASE WHEN direction='credit' THEN amount::numeric
                             ELSE -amount::numeric END), 0)::text AS net
      FROM ledger_entries
     WHERE transaction_id IN (${sql.join(
       PHANTOM_TX_IDS.map((id) => sql`${id}`),
       sql`, `,
     )})
     GROUP BY transaction_id
     ORDER BY transaction_id
  `);
  console.log("[cleanup] cut 2 preview — phantom-tx ledger_entries:");
  const phantomRows = (phantomLegs as any).rows ?? [];
  if (phantomRows.length === 0) {
    console.log("  (none — cut 2 already applied or IDs no longer point here)");
  } else {
    for (const r of phantomRows) {
      console.log(
        `  tx#${r.transaction_id}: legs=${r.legs} net=${r.net} (cleanup will DELETE)`,
      );
    }
  }
  const fkRefs = await db.execute<{ refs: number }>(sql`
    SELECT COUNT(*)::int AS refs
      FROM adviser_fee_deductions
     WHERE settled_transaction_id IN (${sql.join(
       PHANTOM_TX_IDS.map((id) => sql`${id}`),
       sql`, `,
     )})
        OR reversal_transaction_id IN (${sql.join(
          PHANTOM_TX_IDS.map((id) => sql`${id}`),
          sql`, `,
        )})
  `);
  const fkCount = (fkRefs as any).rows?.[0]?.refs ?? 0;
  console.log(
    `[cleanup] cut 2 preview — adviser_fee_deductions FKs to phantom-tx ids: ${fkCount} ` +
      `(must be 0 for safe delete; non-zero means STOP and update the constants)`,
  );

  // Cut 3 (#181) preview — orphan deduction + its settled-tx legs.
  const [deduction] = await db
    .select()
    .from(adviserFeeDeductions)
    .where(eq(adviserFeeDeductions.id, ORPHAN_DEDUCTION_ID));
  console.log("[cleanup] cut 3 preview — adviser_fee_deductions row:");
  if (!deduction) {
    console.log(
      `  deduction #${ORPHAN_DEDUCTION_ID} NOT FOUND (cut 3 will be skipped)`,
    );
  } else {
    console.log(
      `  id=${deduction.id} client_user_id=${deduction.clientUserId} ` +
        `settled_tx=${deduction.settledTransactionId ?? "null"} ` +
        `reversal_tx=${deduction.reversalTransactionId ?? "null"} ` +
        `total_accrued=${deduction.totalAccrued}`,
    );
    if (deduction.settledTransactionId && !deduction.reversalTransactionId) {
      const legs = await db
        .select({
          accountId: ledgerEntries.accountId,
          userId: ledgerEntries.userId,
          currency: ledgerEntries.currency,
          direction: ledgerEntries.direction,
          amount: ledgerEntries.amount,
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.transactionId, deduction.settledTransactionId));
      console.log(
        `  settled tx#${deduction.settledTransactionId} has ${legs.length} ledger leg(s) ` +
          `(cleanup will mirror these with FLIPPED direction):`,
      );
      for (const l of legs) {
        console.log(
          `    user=${l.userId} acct=${l.accountId} ${l.currency} ${l.direction} ${l.amount}`,
        );
      }
    } else if (deduction.reversalTransactionId) {
      console.log(`  (cut 3 already applied — reversal exists)`);
    } else {
      console.log(`  (cut 3 will be skipped — no settled_transaction_id)`);
    }
  }

  // Cut 4 (#325) preview — Gate-B fixture wallets with stale AUD cache.
  const fixtureDriftRows = await db.execute<{
    user_id: number;
    username: string;
    email: string;
    cached: string;
    ledger_sum: string;
    drift: string;
  }>(sql`
    SELECT u.id AS user_id,
           u.username,
           u.email,
           COALESCE(w.balance::text, '0') AS cached,
           COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount::numeric
                             ELSE -le.amount::numeric END), 0)::text AS ledger_sum,
           (COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount::numeric
                              ELSE -le.amount::numeric END), 0)
            - COALESCE(w.balance::numeric, 0))::text AS drift
      FROM users u
      LEFT JOIN wallets w
        ON w.user_id = u.id AND w.currency = ${STALE_FEEGATE_FIXTURE_CURRENCY}
      LEFT JOIN ledger_entries le
        ON le.user_id = u.id AND le.currency = ${STALE_FEEGATE_FIXTURE_CURRENCY}
     WHERE u.id IN (${sql.join(
       STALE_FEEGATE_FIXTURE_USER_IDS.map((id) => sql`${id}`),
       sql`, `,
     )})
     GROUP BY u.id, u.username, u.email, w.balance
     ORDER BY u.id
  `);
  console.log(
    "[cleanup] cut 4 preview — Gate-B fixture wallets (cache vs ledger):",
  );
  const fixtureRows = (fixtureDriftRows as any).rows ?? [];
  if (fixtureRows.length === 0) {
    console.log(
      `  no users matched IDs ${JSON.stringify(STALE_FEEGATE_FIXTURE_USER_IDS)} ` +
        "(cut 4 will be skipped)",
    );
  } else {
    for (const row of fixtureRows) {
      const inSync = Math.abs(Number(row.drift)) < 0.01;
      console.log(
        `  user=${row.user_id} ${row.email} ` +
          `cached=${row.cached} ledger=${row.ledger_sum} drift=${row.drift}` +
          (inSync ? "  [already in sync — refresh will be a no-op]" : ""),
      );
    }
  }

  console.log(
    "[cleanup] dry-run complete. Re-run WITHOUT --dry-run to apply, " +
      "or update the hardcoded constants if any of the above does not " +
      "match the residue you expected.",
  );
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    await previewResidue();
    return;
  }

  console.log("[cleanup] starting pre-launch residue cleanup");
  console.log(
    `[cleanup] target IDs (verify these match your target DB!): ` +
      `PHANTOM_TX_IDS=${JSON.stringify(PHANTOM_TX_IDS)}, ` +
      `ORPHAN_DEDUCTION_ID=${ORPHAN_DEDUCTION_ID}, ` +
      `SYSTEM_USER_ID=${SYSTEM_USER_ID}, ADMIN_USER_ID=${ADMIN_USER_ID}`,
  );

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
  for (const userId of AFFECTED_WALLET_USER_IDS) {
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

  // -----------------------------------------------------------------
  // Cut 4 (#325): Task #325 Gate-B fee-deduction test fixtures left 11
  // adviser users (`t325-gate-b-{ts}-adv@test.local`) with a stale wallet
  // cache for AUD — the platform-share leg of a balanced fee deduction
  // posted to ledger_entries without an accompanying refreshWalletCacheBalance
  // call. The ledger is correct (balanced postings, no unbalanced legs);
  // only the cache is stale. We DO NOT post reversals or modify any ledger
  // entry — we just call the sanctioned cache-recompute helper for each
  // (userId, 'AUD') pair. refreshWalletCacheBalance is itself idempotent
  // (computes from SUM(ledger_entries) and writes), so re-running this
  // script after Cut 4 has already snapped the caches is a no-op.
  //
  // Pre-flight assertion: every targeted user must still match the
  // expected fixture username pattern (`t325-gate-b-...`). If even one
  // does not, we abort Cut 4 entirely without touching any wallet — the
  // hardcoded ID list has drifted from the residue it was captured against
  // and the operator must update STALE_FEEGATE_FIXTURE_USER_IDS by hand.
  // -----------------------------------------------------------------
  const fixtureUsers = await db.execute<{
    id: number;
    username: string;
    email: string;
  }>(sql`
    SELECT id, username, email
      FROM users
     WHERE id IN (${sql.join(
       STALE_FEEGATE_FIXTURE_USER_IDS.map((id) => sql`${id}`),
       sql`, `,
     )})
     ORDER BY id
  `);
  const fixtureUserRows = (fixtureUsers as any).rows ?? [];
  const unexpected = fixtureUserRows.filter(
    (u: any) =>
      !u.username?.startsWith("t325-gate-b-") ||
      !u.email?.endsWith("@test.local"),
  );
  if (unexpected.length > 0) {
    console.error(
      "[cleanup] cut 4 ABORTED — one or more STALE_FEEGATE_FIXTURE_USER_IDS " +
        "no longer match the expected `t325-gate-b-{ts}-adv@test.local` " +
        "fixture pattern. Update the constant and re-run.",
    );
    for (const u of unexpected) {
      console.error(
        `  user=${u.id} username=${u.username} email=${u.email}`,
      );
    }
    process.exit(1);
  }
  if (fixtureUserRows.length !== STALE_FEEGATE_FIXTURE_USER_IDS.length) {
    console.warn(
      `[cleanup] cut 4 — expected ${STALE_FEEGATE_FIXTURE_USER_IDS.length} ` +
        `fixture user(s), found ${fixtureUserRows.length}. Missing IDs ` +
        "will simply be skipped (no wallet row → no-op).",
    );
  }
  let cut4Refreshed = 0;
  let cut4Skipped = 0;
  for (const userId of STALE_FEEGATE_FIXTURE_USER_IDS) {
    const result = await refreshWalletCacheBalance(
      db,
      userId,
      STALE_FEEGATE_FIXTURE_CURRENCY,
    );
    if (result) {
      console.log(
        `[cleanup] cut 4 refreshed wallet cache user=${userId} ` +
          `${STALE_FEEGATE_FIXTURE_CURRENCY} → balance=${result.balance}`,
      );
      cut4Refreshed += 1;
    } else {
      console.log(
        `[cleanup] cut 4 no wallet row for user=${userId} ` +
          `${STALE_FEEGATE_FIXTURE_CURRENCY} (skipped — cache=0 already)`,
      );
      cut4Skipped += 1;
    }
  }
  console.log(
    `[cleanup] cut 4 done — refreshed=${cut4Refreshed} skipped=${cut4Skipped}`,
  );

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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cleanup] crashed:", err);
    process.exit(1);
  });
