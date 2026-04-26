// =============================================================================
// Task #37 — one-shot backfill: ledger_postings receipts for historical entries
// =============================================================================
// The ledger_postings table introduced in Task #37 is the DB-level
// concurrency lock for the double-post guard in postLedgerEntries(). It
// must contain a row for every transactionId that already has any
// ledger_entries — otherwise the guard would see "no receipt yet" for a
// pre-existing transaction and silently allow a second balanced pair to
// be posted against it.
//
// This script is idempotent (ON CONFLICT DO NOTHING) and safe to run
// multiple times. After this script has run once on a database, all
// future postLedgerEntries() calls are protected by the receipt insert
// regardless of when the original entries were posted.
//
// Usage: npx tsx scripts/backfill-ledger-postings.ts
// =============================================================================
import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const before = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM ledger_postings`,
  );
  const txWithEntries = await db.execute(
    sql`SELECT COUNT(DISTINCT transaction_id)::int AS n FROM ledger_entries`,
  );
  console.log(`receipts before backfill: ${(before.rows as any)[0]?.n ?? 0}`);
  console.log(
    `distinct tx ids with entries: ${(txWithEntries.rows as any)[0]?.n ?? 0}`,
  );

  const result = await db.execute(sql`
    INSERT INTO ledger_postings (transaction_id, posted_at)
    SELECT le.transaction_id, COALESCE(MIN(le.created_at), NOW())
    FROM ledger_entries le
    WHERE le.transaction_id IS NOT NULL
    GROUP BY le.transaction_id
    ON CONFLICT (transaction_id) DO NOTHING
  `);
  console.log(`inserted rows: ${result.rowCount ?? 0}`);

  const after = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM ledger_postings`,
  );
  console.log(`receipts after backfill: ${(after.rows as any)[0]?.n ?? 0}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("backfill-ledger-postings crashed:", e);
  process.exit(1);
});
