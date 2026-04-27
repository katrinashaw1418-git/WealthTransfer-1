#!/usr/bin/env tsx
// =============================================================================
// scripts/record-offsite-backup-run.ts — persist the outcome of the offsite
// backup cron (`scripts/db-backup-offsite.sh`) into `background_job_runs`
// under jobName=`database-backup-offsite`.
//
// Why this exists:
//   The offsite-sync cron runs out-of-process on the production host (it's a
//   shell script around `aws s3 sync`). Without a hook back into the database
//   the application server has no way to tell whether the offsite half is
//   alive. Task #260 adds a watchdog (`checkBackupFreshness` →
//   getMostRecentSuccessfulOffsiteSync()) that pages an operator when the
//   most recent successful row is older than the configured threshold.
//   THIS script is what writes that row.
//
// Usage:
//   npx tsx scripts/record-offsite-backup-run.ts \
//     --status=success \
//     --started-at-ms=1745700000000 \
//     --finished-at-ms=1745700123456 \
//     --summary="src=/var/backups/amax-db dst=s3://amax-db-backups-prod/dumps/"
//
//   npx tsx scripts/record-offsite-backup-run.ts \
//     --status=error \
//     --started-at-ms=1745700000000 \
//     --finished-at-ms=1745700111111 \
//     --message="aws s3 sync exited 2"
//
// Exit codes:
//   0  row written
//   1  configuration / argument error
//   2  database write failed
//
// IMPORTANT: this script NEVER mutates dump files on disk and never touches
// the live application. The watchdog reads the row this script writes; if
// the write fails the watchdog will eventually page on offsite-stale, which
// is exactly the visibility we want.
// =============================================================================

import { recordBackgroundJobRun } from "../server/services/background-jobs";
import { OFFSITE_BACKUP_JOB_NAME } from "../server/services/database-backups";

interface ParsedArgs {
  status: "success" | "error";
  startedAtMs: number;
  finishedAtMs: number;
  summary: string | null;
  errorMessage: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    map.set(m[1], m[2]);
  }
  const status = map.get("status");
  if (status !== "success" && status !== "error") {
    throw new Error(
      `--status must be 'success' or 'error' (got ${JSON.stringify(status)})`,
    );
  }
  const startedAtMsRaw = map.get("started-at-ms");
  const finishedAtMsRaw = map.get("finished-at-ms");
  if (!startedAtMsRaw || !finishedAtMsRaw) {
    throw new Error(
      "--started-at-ms and --finished-at-ms are required (epoch ms integers).",
    );
  }
  const startedAtMs = Number.parseInt(startedAtMsRaw, 10);
  const finishedAtMs = Number.parseInt(finishedAtMsRaw, 10);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(finishedAtMs) ||
    startedAtMs <= 0 ||
    finishedAtMs <= 0
  ) {
    throw new Error(
      `--started-at-ms / --finished-at-ms must be positive integers (got ${startedAtMsRaw} / ${finishedAtMsRaw}).`,
    );
  }
  return {
    status,
    startedAtMs,
    finishedAtMs,
    summary: map.get("summary") ?? null,
    errorMessage: map.get("message") ?? null,
  };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `[record-offsite-backup-run] FAIL: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  try {
    const row = await recordBackgroundJobRun({
      jobName: OFFSITE_BACKUP_JOB_NAME,
      startedAt: new Date(args.startedAtMs),
      finishedAt: new Date(args.finishedAtMs),
      status: args.status,
      summary: args.summary,
      errorMessage: args.errorMessage,
      durationMs: Math.max(0, args.finishedAtMs - args.startedAtMs),
    });
    console.log(
      `[record-offsite-backup-run] OK id=${row.id} status=${args.status}`,
    );
    process.exit(0);
  } catch (err) {
    console.error(
      `[record-offsite-backup-run] DB write failed: ${(err as Error)?.message ?? String(err)}`,
    );
    process.exit(2);
  }
}

void main();
