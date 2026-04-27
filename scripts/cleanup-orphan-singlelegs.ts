// One-shot cleanup of orphan single-leg transactions left by prior pre-launch
// runs (before the platform-user-tracking bug was fixed). After this runs once,
// the fix in pre-launch-safety.ts (the platform user is no longer pushed into
// `created.userIds`) prevents the same orphans from being created again.
import { db } from "../server/db";
import { sql, inArray } from "drizzle-orm";
import { ledgerEntries, transactions } from "../shared/schema";
async function main() {
  // Find every transaction that has a leg but no receipt — these are the
  // half-deleted residue (suspense leg + receipt were deleted by pre-launch's
  // overzealous FK-walk; client leg + transaction were left behind).
  const orphans = await db.execute<{ id: number; description: string | null }>(sql`
    SELECT t.id, t.description
      FROM transactions t
      JOIN ledger_entries le ON le.transaction_id = t.id
      LEFT JOIN ledger_postings lp ON lp.transaction_id = t.id
     WHERE lp.transaction_id IS NULL
     GROUP BY t.id, t.description
  `);
  const orphanIds = ((orphans as any).rows ?? []).map((r: any) => r.id);
  if (orphanIds.length === 0) {
    console.log("[cleanup-orphans] no orphans found");
    process.exit(0);
  }
  console.log(`[cleanup-orphans] found ${orphanIds.length} orphan transactions`);
  for (const r of (orphans as any).rows) console.log(`  #${r.id} — ${r.description}`);

  await db.transaction(async (tx) => {
    await tx.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, orphanIds));
    await tx.delete(transactions).where(inArray(transactions.id, orphanIds));
  });
  console.log(`[cleanup-orphans] deleted ${orphanIds.length} orphan transactions and their entries`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
