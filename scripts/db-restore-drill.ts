#!/usr/bin/env tsx
// =============================================================================
// scripts/db-restore-drill.ts — manual restore-drill CLI
// =============================================================================
// Equivalent to the weekly cron drill: pick the latest dump in DB_BACKUP_DIR,
// restore it into a freshly-created scratch DB, run integrity checks, drop
// the scratch DB. Persists one row to `database_restore_drill_runs` so the
// admin dashboard sees manual drills next to scheduled ones.
//
// Usage:
//   DATABASE_URL=postgres://... DB_BACKUP_DIR=/var/backups/amax-db \
//     npx tsx scripts/db-restore-drill.ts
//
// Optional flags:
//   --keep-scratch   Leave the scratch DB in place after the drill (so the
//                    operator can poke around). Default: drops it.
//   --dump=<path>    Restore a specific dump rather than the latest.
// =============================================================================

import {
  runDatabaseRestoreDrill,
  getBackupDir,
} from "../server/services/database-backups";

interface ParsedArgs {
  keepScratch: boolean;
  dump: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { keepScratch: false, dump: null, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--keep-scratch") out.keepScratch = true;
    else if (arg.startsWith("--dump=")) out.dump = arg.slice("--dump=".length);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Usage: npx tsx scripts/db-restore-drill.ts [--dump=<path>] [--keep-scratch]",
        "",
        "  --dump=<path>     Restore a specific dump rather than the latest in DB_BACKUP_DIR.",
        "  --keep-scratch    Do not drop the scratch DB after the drill.",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (!getBackupDir()) {
    console.error("FAIL: DB_BACKUP_DIR is not set.");
    process.exit(1);
  }

  console.log("[restore-drill] starting drill");
  try {
    const result = await runDatabaseRestoreDrill({
      dumpPath: args.dump ?? undefined,
      keepScratchDb: args.keepScratch,
    });
    console.log(
      `[restore-drill] OK: dump=${result.dumpPath}, scratchDb=${result.scratchDbName}, ` +
        `duration=${result.durationMs}ms`,
    );
    for (const c of result.integrity.checks) {
      console.log(
        `  - ${c.ok ? "PASS" : "FAIL"}: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
      );
    }
    process.exit(0);
  } catch (err) {
    console.error(
      `[restore-drill] FAIL: ${(err as Error)?.message ?? String(err)}`,
    );
    process.exit(1);
  }
}

void main();
