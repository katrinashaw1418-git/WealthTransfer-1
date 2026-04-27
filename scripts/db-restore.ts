#!/usr/bin/env tsx
// =============================================================================
// scripts/db-restore.ts — manual restore CLI with live-DB safety guard
// =============================================================================
// Restores a pg_dump file into a Postgres database. The default behaviour
// REFUSES to restore into the live DATABASE_URL (or any URL whose host:port/db
// matches the live one). To intentionally restore over the live DB during a
// rollback, the operator MUST pass `--i-know-what-im-doing`.
//
// Usage:
//   npx tsx scripts/db-restore.ts \
//     --dump=/path/to/amax-db-backup-2026-04-27T01-23-45Z.dump \
//     --target=postgres://user:pass@host:5432/scratch_db
//
//   # Live restore during a rollback:
//   npx tsx scripts/db-restore.ts \
//     --dump=/path/to/dump.dump \
//     --target=$DATABASE_URL \
//     --i-know-what-im-doing
//
// Notes:
//   * The script does NOT write a row to `database_restore_drill_runs`; the
//     drill table is only for the automated weekly drill. Live restores are
//     audited via the rollback runbook (docs/runbooks/rollback.md).
//   * Uses pg_restore --clean --if-exists. Existing objects in the target
//     are dropped before being recreated.
// =============================================================================

import { spawn } from "child_process";
import { promises as fs } from "fs";
import {
  assertNotLiveTarget,
  describeDbTarget,
} from "../server/services/database-backups";

interface ParsedArgs {
  dump: string | null;
  target: string | null;
  iKnowWhatImDoing: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    dump: null,
    target: null,
    iKnowWhatImDoing: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--i-know-what-im-doing") out.iKnowWhatImDoing = true;
    else if (arg.startsWith("--dump=")) out.dump = arg.slice("--dump=".length);
    else if (arg.startsWith("--target=")) out.target = arg.slice("--target=".length);
  }
  return out;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npx tsx scripts/db-restore.ts --dump=<path> --target=<postgres-url> [--i-know-what-im-doing]",
      "",
      "  --dump=<path>            Path to a pg_dump custom-format dump (.dump).",
      "  --target=<postgres-url>  Postgres URL to restore INTO. Must NOT be the live",
      "                           DATABASE_URL unless --i-know-what-im-doing is set.",
      "  --i-know-what-im-doing   Override the live-DB safety guard. Required for",
      "                           rollback-time restores per docs/runbooks/rollback.md.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dump || !args.target) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  // Verify the dump file exists before we even attempt to spawn pg_restore;
  // a clearer error here saves the operator from a confusing libpq message.
  try {
    await fs.access(args.dump, fs.constants.R_OK);
  } catch {
    console.error(`FAIL: dump file not readable: ${args.dump}`);
    process.exit(1);
  }

  const targetKey = describeDbTarget(args.target);
  if (!targetKey) {
    console.error(`FAIL: --target is not a parseable postgres URL`);
    process.exit(1);
  }

  if (!args.iKnowWhatImDoing) {
    try {
      assertNotLiveTarget(args.target);
    } catch (err) {
      console.error(`FAIL: ${(err as Error).message}`);
      console.error(
        "If this is an intentional rollback restore, re-run with --i-know-what-im-doing.",
      );
      process.exit(2);
    }
  } else {
    console.warn(
      `[db-restore] !! BYPASSING live-DB safety guard. Target=${targetKey}.`,
    );
  }

  console.log(
    `[db-restore] restoring ${args.dump} → ${targetKey} (clean+if-exists)`,
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "--exit-on-error",
        "--dbname",
        args.target!,
        args.dump!,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    console.error(`[db-restore] FAIL: pg_restore exited ${exitCode}`);
    process.exit(exitCode);
  }
  console.log("[db-restore] OK");
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[db-restore] FAIL: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
