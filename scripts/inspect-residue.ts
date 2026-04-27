import { db } from "../server/db";
import { sql } from "drizzle-orm";
async function main() {
  const r = await db.execute(sql`
    SELECT le.id, le.transaction_id, le.account_id, a.account_type,
           le.direction, le.amount, le.description,
           t.type as tx_type, t.description as tx_desc, t.user_id as tx_user, t.created_at as tx_created
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN transactions t ON t.id = le.transaction_id
     WHERE a.user_id = 11 AND le.currency = 'AUD'
     ORDER BY le.id DESC LIMIT 60;`);
  console.log("user11 AUD rows:");
  for (const row of (r as any).rows) console.log(JSON.stringify(row));
  const sumR = await db.execute(sql`
    SELECT COALESCE(SUM(CASE WHEN le.direction='credit' THEN le.amount ELSE -le.amount END), 0)::text AS s
      FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
     WHERE a.user_id = 11 AND le.currency = 'AUD';`);
  console.log("\nsum:", JSON.stringify((sumR as any).rows));
  const m = await db.execute(sql`
    SELECT le.transaction_id, COUNT(*) as legs, ARRAY_AGG(DISTINCT a.user_id) as user_ids,
           t.type as tx_type, t.description as tx_desc
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN ledger_postings lp ON lp.transaction_id = le.transaction_id
      LEFT JOIN transactions t ON t.id = le.transaction_id
     WHERE lp.transaction_id IS NULL
     GROUP BY le.transaction_id, t.type, t.description ORDER BY le.transaction_id;`);
  console.log("\nmissing receipts:");
  for (const row of (m as any).rows) console.log(JSON.stringify(row));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
