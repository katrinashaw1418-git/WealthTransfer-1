import { sql } from "drizzle-orm";
import { db } from "../server/db";

const TARGET_TRANSACTION_IDS = [1, 2, 4, 6] as const;

const CONFIRM_FLAG = "--confirm";
const isConfirmed = process.argv.includes(CONFIRM_FLAG);

type TxRow = {
  id: number;
  user_id: number;
  amount: string;
  to_currency: string | null;
  type: string;
  status: string;
  description: string;
  created_at: string;
};

type UserRow = {
  id: number;
  username: string;
  email: string;
};

type WalletRow = {
  id: number;
  user_id: number;
  currency: string;
  balance: string;
  available_balance: string;
};

type ReferenceCount = {
  source: string;
  count: number;
};

function ts(): string {
  return new Date().toISOString();
}

function log(line: string): void {
  console.log(`[${ts()}] ${line}`);
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadTargetTransactions(): Promise<TxRow[]> {
  const res = await db.execute<TxRow>(sql`
    SELECT id, user_id, amount::text, to_currency, type, status, description, created_at::text
      FROM transactions
     WHERE id IN (${sql.join(TARGET_TRANSACTION_IDS.map((id) => sql`${id}`), sql`, `)})
     ORDER BY id
  `);
  return res.rows ?? [];
}

async function loadUsers(userIds: number[]): Promise<UserRow[]> {
  if (userIds.length === 0) return [];
  const res = await db.execute<UserRow>(sql`
    SELECT id, username, email
      FROM users
     WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
     ORDER BY id
  `);
  return res.rows ?? [];
}

async function loadWallets(userIds: number[]): Promise<WalletRow[]> {
  if (userIds.length === 0) return [];
  const res = await db.execute<WalletRow>(sql`
    SELECT id, user_id, currency, balance::text, available_balance::text
      FROM wallets
     WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
     ORDER BY user_id, currency
  `);
  return res.rows ?? [];
}

async function collectReferenceCounts(
  userIds: number[],
): Promise<ReferenceCount[]> {
  const userIdsSql =
    userIds.length > 0 ? sql.join(userIds.map((id) => sql`${id}`), sql`, `) : sql`NULL`;
  const txIdsSql = sql.join(TARGET_TRANSACTION_IDS.map((id) => sql`${id}`), sql`, `);

  const refRows = await db.execute<ReferenceCount>(sql`
    SELECT source, count::int
    FROM (
      SELECT 'ledger_postings_tx'::text AS source, COUNT(*)::int AS count
        FROM ledger_postings
       WHERE transaction_id IN (${txIdsSql})

      UNION ALL
      SELECT 'ledger_entries_tx', COUNT(*)::int
        FROM ledger_entries
       WHERE transaction_id IN (${txIdsSql})

      UNION ALL
      SELECT 'ledger_entries_user', COUNT(*)::int
        FROM ledger_entries
       WHERE user_id IN (${userIdsSql})

      UNION ALL
      SELECT 'advice_records_user', COUNT(*)::int
        FROM advice_records
       WHERE client_id IN (${userIdsSql}) OR adviser_id IN (${userIdsSql})

      UNION ALL
      SELECT 'fee_consents_user', COUNT(*)::int
        FROM fee_consents
       WHERE client_id IN (${userIdsSql}) OR adviser_id IN (${userIdsSql})

      UNION ALL
      SELECT 'adviser_fee_deductions_user', COUNT(*)::int
        FROM adviser_fee_deductions
       WHERE client_user_id IN (${userIdsSql}) OR adviser_user_id IN (${userIdsSql})

      UNION ALL
      SELECT 'adviser_fee_deductions_tx', COUNT(*)::int
        FROM adviser_fee_deductions
       WHERE settled_transaction_id IN (${txIdsSql})
          OR reversal_transaction_id IN (${txIdsSql})

      UNION ALL
      SELECT 'reconciliations_user', COUNT(*)::int
        FROM reconciliations
       WHERE user_id IN (${userIdsSql})

      UNION ALL
      SELECT 'wallet_ledger_reconciliations_user', COUNT(*)::int
        FROM wallet_ledger_reconciliations
       WHERE user_id IN (${userIdsSql})

      UNION ALL
      SELECT 'audit_logs_user', COUNT(*)::int
        FROM audit_logs
       WHERE user_id IN (${userIdsSql})

      UNION ALL
      SELECT 'audit_logs_transaction_entity', COUNT(*)::int
        FROM audit_logs
       WHERE entity_type ILIKE '%transaction%'
         AND entity_id IN (${sql.join(TARGET_TRANSACTION_IDS.map((id) => sql`${String(id)}`), sql`, `)})

      UNION ALL
      SELECT 'audit_logs_metadata_transaction_id', COUNT(*)::int
        FROM audit_logs
       WHERE metadata::text ILIKE ANY (ARRAY[
         '%"transactionId":1%',
         '%"transactionId":2%',
         '%"transactionId":4%',
         '%"transactionId":6%'
       ])
    ) s
    ORDER BY source
  `);

  return refRows.rows ?? [];
}

function getCount(refs: ReferenceCount[], key: string): number {
  return refs.find((r) => r.source === key)?.count ?? 0;
}

async function runOrphanInvariantSnapshot(): Promise<{
  missingReceipts: number;
  orphanReceipts: number;
}> {
  const res = await db.execute<{ missing_receipts: number; orphan_receipts: number }>(sql`
    WITH
      entry_tx AS (
        SELECT DISTINCT transaction_id
          FROM ledger_entries
         WHERE transaction_id IS NOT NULL
      ),
      receipt_tx AS (
        SELECT transaction_id
          FROM ledger_postings
      )
    SELECT
      (
        SELECT COUNT(*)::int
          FROM entry_tx e
          LEFT JOIN receipt_tx r ON r.transaction_id = e.transaction_id
         WHERE r.transaction_id IS NULL
      ) AS missing_receipts,
      (
        SELECT COUNT(*)::int
          FROM receipt_tx r
          LEFT JOIN entry_tx e ON e.transaction_id = r.transaction_id
         WHERE e.transaction_id IS NULL
      ) AS orphan_receipts
  `);

  const row = res.rows?.[0];
  return {
    missingReceipts: row?.missing_receipts ?? 0,
    orphanReceipts: row?.orphan_receipts ?? 0,
  };
}

async function ensureSafePreflight(): Promise<{
  transactions: TxRow[];
  users: UserRow[];
  wallets: WalletRow[];
  refs: ReferenceCount[];
}> {
  log("Preflight: loading targeted transactions");
  const transactions = await loadTargetTransactions();

  assert(
    transactions.length === TARGET_TRANSACTION_IDS.length,
    `Expected ${TARGET_TRANSACTION_IDS.length} transactions, found ${transactions.length}. Aborting.`,
  );

  const missingIds = TARGET_TRANSACTION_IDS.filter(
    (id) => !transactions.some((tx) => tx.id === id),
  );
  assert(missingIds.length === 0, `Missing target transaction IDs: ${missingIds.join(", ")}`);

  const userIds = [...new Set(transactions.map((tx) => tx.user_id))];
  const users = await loadUsers(userIds);
  assert(users.length === userIds.length, "One or more transaction users were not found.");

  for (const user of users) {
    assert(
      user.username.startsWith("t476-"),
      `User ${user.id} username '${user.username}' does not match t476-* fixture pattern.`,
    );
    assert(
      user.email.endsWith("@test.local"),
      `User ${user.id} email '${user.email}' does not match *@test.local fixture pattern.`,
    );
  }

  const wallets = await loadWallets(userIds);
  for (const wallet of wallets) {
    const balance = toNumber(wallet.balance);
    const available = toNumber(wallet.available_balance);
    assert(
      Number.isFinite(balance) && Number.isFinite(available),
      `Wallet ${wallet.id} has non-numeric balances.`,
    );
    assert(
      balance === 0 && available === 0,
      `Wallet ${wallet.id} is non-zero (${wallet.currency}: balance=${wallet.balance}, available=${wallet.available_balance}).`,
    );
  }

  const refs = await collectReferenceCounts(userIds);

  // Required safety checks:
  assert(
    getCount(refs, "ledger_postings_tx") === TARGET_TRANSACTION_IDS.length,
    "Expected exactly 4 ledger_postings rows for target transactions.",
  );
  assert(getCount(refs, "ledger_entries_tx") === 0, "ledger_entries are linked to target transactions.");
  assert(getCount(refs, "ledger_entries_user") === 0, "ledger_entries are linked to fixture users.");
  assert(getCount(refs, "advice_records_user") === 0, "advice_records are linked to fixture users.");
  assert(getCount(refs, "fee_consents_user") === 0, "fee_consents are linked to fixture users.");
  assert(
    getCount(refs, "adviser_fee_deductions_user") === 0,
    "adviser_fee_deductions are linked to fixture users.",
  );
  assert(
    getCount(refs, "adviser_fee_deductions_tx") === 0,
    "adviser_fee_deductions are linked to target transactions.",
  );
  assert(getCount(refs, "reconciliations_user") === 0, "reconciliations are linked to fixture users.");
  assert(
    getCount(refs, "wallet_ledger_reconciliations_user") === 0,
    "wallet_ledger_reconciliations are linked to fixture users.",
  );
  assert(getCount(refs, "audit_logs_user") === 0, "audit_logs are linked to fixture users.");
  assert(
    getCount(refs, "audit_logs_transaction_entity") === 0,
    "audit_logs transaction entity rows reference target transactions.",
  );
  assert(
    getCount(refs, "audit_logs_metadata_transaction_id") === 0,
    "audit_logs metadata references target transactions.",
  );

  return { transactions, users, wallets, refs };
}

async function deleteFixtureRows(userIds: number[], wallets: WalletRow[]): Promise<void> {
  const txIdsSql = sql.join(TARGET_TRANSACTION_IDS.map((id) => sql`${id}`), sql`, `);

  await db.transaction(async (tx) => {
    // 1) ledger_postings for tx IDs
    const delPostings = await tx.execute(sql`
      DELETE FROM ledger_postings
       WHERE transaction_id IN (${txIdsSql})
    `);
    log(`Deleted ledger_postings rows: ${(delPostings.rowCount ?? 0).toString()}`);

    // 2) transactions for tx IDs
    const delTransactions = await tx.execute(sql`
      DELETE FROM transactions
       WHERE id IN (${txIdsSql})
    `);
    log(`Deleted transactions rows: ${(delTransactions.rowCount ?? 0).toString()}`);

    // 3) optional zero-balance wallet rows
    if (wallets.length > 0) {
      const walletIds = wallets.map((w) => w.id);
      const delWallets = await tx.execute(sql`
        DELETE FROM wallets
         WHERE id IN (${sql.join(walletIds.map((id) => sql`${id}`), sql`, `)})
      `);
      log(
        `Deleted optional zero-balance wallets: ${(delWallets.rowCount ?? 0).toString()}`,
      );
    } else {
      log("No wallet rows found; optional wallet deletion skipped.");
    }

    // 4) optional fixture users only if no dependencies remain
    const userRefs = await tx.execute<{ total_refs: number }>(sql`
      SELECT SUM(cnt)::int AS total_refs
      FROM (
        SELECT COUNT(*)::int AS cnt FROM advice_records
         WHERE client_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
            OR adviser_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM fee_consents
         WHERE client_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
            OR adviser_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM adviser_fee_deductions
         WHERE client_user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
            OR adviser_user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM reconciliations
         WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM wallet_ledger_reconciliations
         WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM audit_logs
         WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM accounts
         WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT COUNT(*)::int AS cnt FROM portfolio_snapshots
         WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
      ) x
    `);

    const remainingRefs = userRefs.rows?.[0]?.total_refs ?? 0;
    if (remainingRefs === 0) {
      const delUsers = await tx.execute(sql`
        DELETE FROM users
         WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
      `);
      log(`Deleted optional fixture users: ${(delUsers.rowCount ?? 0).toString()}`);
    } else {
      log(
        `Optional fixture user deletion skipped; remaining user dependencies: ${remainingRefs}`,
      );
    }
  });
}

async function main(): Promise<void> {
  log(
    `Starting t476 fixture cleanup script (dry-run=${(!isConfirmed).toString()}) for tx IDs: ${TARGET_TRANSACTION_IDS.join(", ")}`,
  );

  const snapshotBefore = await runOrphanInvariantSnapshot();
  log(
    `Invariant snapshot before: missing_receipts=${snapshotBefore.missingReceipts}, orphan_receipts=${snapshotBefore.orphanReceipts}`,
  );

  const preflight = await ensureSafePreflight();
  const userIds = preflight.users.map((u) => u.id);

  log(`Preflight OK. Fixture users: ${preflight.users.map((u) => u.username).join(", ")}`);
  log(`Wallet rows for fixture users: ${preflight.wallets.length}`);

  if (!isConfirmed) {
    log(
      `Dry-run complete. No data changed. Re-run with ${CONFIRM_FLAG} to perform deletion.`,
    );
    return;
  }

  log("Confirmed run: applying ordered cleanup steps.");
  await deleteFixtureRows(userIds, preflight.wallets);

  const snapshotAfter = await runOrphanInvariantSnapshot();
  log(
    `Invariant snapshot after: missing_receipts=${snapshotAfter.missingReceipts}, orphan_receipts=${snapshotAfter.orphanReceipts}`,
  );
  log("Cleanup execution finished.");
}

main().catch((error) => {
  log(`ABORTED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

