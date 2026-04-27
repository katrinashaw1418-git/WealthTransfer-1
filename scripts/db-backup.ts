#!/usr/bin/env tsx
// =============================================================================
// scripts/db-backup.ts — manual / cron-equivalent database backup CLI
// =============================================================================
// Thin CLI wrapper around `runDatabaseBackup()` so the same code path the
// daily cron uses is exercised end-to-end from the shell. All real logic
// (pg_dump invocation, retention prune, audit-row insert) lives in
// server/services/database-backups.ts.
//
// Usage:
//   DATABASE_URL=postgres://... DB_BACKUP_DIR=/var/backups/amax-db \
//     npx tsx scripts/db-backup.ts
//
// Optional env:
//   DB_BACKUP_RETENTION  Number of dailies to keep (default 14).
//
// Exits 0 on success, 1 on failure. The audit row is recorded in
// `database_backup_runs` regardless of outcome so the admin dashboard can
// see manual runs alongside scheduled ones.
// =============================================================================

import { runDatabaseBackup, getBackupDir, getRetentionCount } from "../server/services/database-backups";

async function main(): Promise<void> {
  const dir = getBackupDir();
  if (!dir) {
    console.error(
      "FAIL: DB_BACKUP_DIR is not set. Set it to the path where dumps should be written (e.g. /var/backups/amax-db) and retry.",
    );
    process.exit(1);
  }
  console.log(
    `[db-backup] starting backup → dir=${dir}, retention=${getRetentionCount()}`,
  );
  try {
    const result = await runDatabaseBackup();
    const sizeMb = (result.dumpSizeBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `[db-backup] OK: dumpPath=${result.dumpPath}, size=${sizeMb} MiB, ` +
        `pruned=${result.prunedCount} (kept=${result.retainedDumps.length}), ` +
        `duration=${result.durationMs}ms`,
    );
    process.exit(0);
  } catch (err) {
    console.error(
      `[db-backup] FAIL: ${(err as Error)?.message ?? String(err)}`,
    );
    process.exit(1);
  }
}

void main();
