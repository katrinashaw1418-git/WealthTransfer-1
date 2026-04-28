// =============================================================================
// TASK #79 — Background job health tracker
// =============================================================================
// Generic record-keeping for every scheduled background job in the server.
// Two consumers:
//
//   1. Cron wrappers in `server/index.ts` call `withBackgroundJobRunRecord`
//      to persist one row per invocation (success or failure) including a
//      short human summary, duration, and error message.
//
//   2. The admin "Background Jobs" page reads `getBackgroundJobsHealth()`
//      to render a single panel showing every job's last run, outcome, and
//      whether it is overdue (default: > 36h since last successful start).
//
// This sits ALONGSIDE the existing job-specific tables (`fee_accrual_runs`,
// `operator_alert_prune_runs`) — it is not a replacement. Those tables have
// rich job-specific columns that other features depend on (the prune
// watchdog, the fee-accrual admin page). This table answers ONE question
// uniformly across all jobs: did it run, when, did it succeed, is it stale.
// =============================================================================

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { backgroundJobRuns, type BackgroundJobRun } from "@shared/schema";

// ---------------------------------------------------------------------------
// `db.execute(sql\`...\`)` returns the underlying driver row shape, which
// Drizzle types only loosely. The runtime shape is "an object with `.rows`
// containing an array of row objects" for both the pg and neon-serverless
// drivers, but some Drizzle/driver combinations return the array directly.
// Centralising the row-extraction here (instead of an inline `as any` cast)
// mirrors the pattern used in `posting-receipt-invariant.ts` so a future
// driver-shape change touches one helper, not the call sites — and avoids
// the dashboard silently going blank if `.rows` is ever absent.
// ---------------------------------------------------------------------------
function extractRows<T>(result: unknown): T[] {
  const r = result as { rows?: unknown } | null | undefined;
  if (r && Array.isArray(r.rows)) {
    return r.rows as T[];
  }
  if (Array.isArray(result)) {
    return result as T[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Catalogue of jobs the server knows about. Listing them up-front means the
// admin UI can show a row for a job that has NEVER run (a strong signal of
// breakage) without having to wait for a successful tick to appear in the
// runs table. Adding a new cron requires adding it here too.
// ---------------------------------------------------------------------------
export interface KnownJob {
  /** Stable machine name; persisted in `background_job_runs.job_name`. */
  name: string;
  /** Short human-readable label for the UI. */
  label: string;
  /** One-line description shown in the UI tooltip. */
  description: string;
}

export const KNOWN_BACKGROUND_JOBS: readonly KnownJob[] = [
  {
    name: "wallet-ledger-reconciliation",
    label: "Wallet ↔ ledger reconciliation",
    description:
      "Daily check that every wallet cache balance matches SUM(ledger_entries) for that user/currency pair.",
  },
  {
    name: "ledger-reconciliation",
    label: "Ledger ↔ custodian reconciliation",
    description:
      "Daily check comparing internal ledger balances against external custodian balances.",
  },
  {
    name: "adviser-task-automation",
    label: "Adviser-task automation",
    description:
      "Daily sweep that creates open adviser_tasks rows for KYC follow-ups, fee-consent renewals, and portfolio reviews.",
  },
  {
    name: "fee-accruals",
    label: "Fee accruals (with backfill)",
    description:
      "Daily fee-rule accrual sweep, with automatic backfill of UTC days missed during outages.",
  },
  {
    // Task #294 — daily reconciliation between adviser_fee_rules and the
    // underlying feeConsents row. Expires rules whose consent has lapsed
    // and pauses rules whose consent has been withdrawn so the rule
    // surface (admin/adviser/client) cannot drift from the legal state.
    name: "fee-rules-consent-reconcile",
    label: "Fee-rules ↔ consent reconciliation",
    description:
      "Daily sweep that flips active fee rules to expired when their consent has lapsed and pauses rules whose consent was withdrawn. Idempotent. Toggle with FEE_RULES_CONSENT_RECONCILE_CRON_ENABLED.",
  },
  {
    name: "operator-alerts-prune",
    label: "Operator-alert retention prune",
    description:
      "Daily delete of operator_alerts rows older than the retention window (default 180 days).",
  },
  {
    name: "operator-alerts-prune-watchdog",
    label: "Operator-alert prune watchdog",
    description:
      "Daily check that the prune above has run successfully within the last 48 hours.",
  },
  {
    name: "insufficient-funds-sweep",
    label: "Insufficient-funds sweep",
    description:
      "Daily re-attempt of fee deductions parked in insufficient_funds, with client notifications when still short.",
  },
  {
    name: "posting-receipt-invariant",
    label: "Posting-receipt invariant guard",
    description:
      "Daily verification that every transaction with ledger entries also has a posting receipt row.",
  },
  {
    name: "stuck-pending-transactions",
    label: "Stuck pending transactions watch",
    description:
      "Hourly check that no transaction has been in 'pending' or 'processing' for longer than the configured threshold (default 60 minutes).",
  },
  {
    name: "database-backup",
    label: "Database backup (pg_dump)",
    description:
      "Daily pg_dump of DATABASE_URL into DB_BACKUP_DIR with retention pruning. See docs/runbooks/rollback.md.",
  },
  {
    name: "database-restore-drill",
    label: "Database restore drill",
    description:
      "Weekly automated restore of the latest dump into a scratch DB followed by an integrity check.",
  },
  {
    name: "database-backup-watchdog",
    label: "Database backup watchdog",
    description:
      "Daily check that both the daily backup and the weekly restore drill have run successfully within their freshness windows.",
  },
  {
    name: "database-backup-offsite",
    label: "Database backup offsite sync",
    description:
      "Daily aws s3 sync of $DB_BACKUP_DIR up to s3://$DB_BACKUP_OFFSITE_BUCKET/$DB_BACKUP_OFFSITE_PREFIX/, recorded by scripts/db-backup-offsite.sh + scripts/record-offsite-backup-run.ts so the watchdog can page when the offsite cron silently breaks.",
  },
  {
    name: "report-sweeper",
    label: "Report job sweeper",
    description:
      "Per-minute sweep that flips report_requests rows stuck in 'requested' or 'generating' for >10 minutes to 'failed' (failureReason='sweeper_timeout') so the UI can offer Retry. Audit row written per flip.",
  },
  {
    // Task #344 — hourly reminder for any still-undownloaded `ready` report
    // whose expiresAt is inside the next 24h. Idempotent on
    // report_requests.expiringSoonNotifiedAt so re-running the cron never
    // re-emails the adviser. Disable with REPORT_EXPIRING_SOON_DISABLED=1.
    name: "report-expiring-soon",
    label: "Report expiring-soon reminder",
    description:
      "Hourly sweep that emails the adviser a one-shot reminder for any 'ready' report still undownloaded and within 24h of expiresAt. Stamps report_requests.expiringSoonNotifiedAt for idempotency.",
  },
  {
    // Task #347 — daily sweep that deactivates fixture-pattern
    // adviser_clients rows pointing at real (non-fixture) advisers, so the
    // read-time fixture filter in `server/services/adviser-access.ts` can
    // become a defence-in-depth backstop instead of the primary line of
    // defence. One audit row per (adviserUserId, clientUserId) link.
    name: "fixture-adviser-clients-cleanup",
    label: "Fixture adviser_clients cleanup",
    description:
      "Daily sweep that flips active adviser_clients rows whose client email matches a known fixture pattern (and whose adviser does NOT) to is_active=false, with one audit row per deactivated (adviser, client) link.",
  },
  {
    // Task #309 — daily sweep that flips `pending_consent` investment
    // instruction rows to `cancelled` once their `expiresAt` deadline
    // has passed, with one audit row per cancellation.
    name: "instruction-consent-expiry-sweep",
    label: "Instruction consent expiry sweep",
    description:
      "Daily sweep that cancels investment_instructions rows in 'pending_consent' whose expiresAt deadline has passed. Writes one audit row per cancellation. Configure the deadline with INVESTMENT_INSTRUCTION_CONSENT_TTL_DAYS (default 7).",
  },
  {
    name: "nightly-go-no-go",
    label: "Nightly launch readiness gate",
    description:
      "Daily full run of scripts/go-no-go.ts against the production-equivalent environment. Pages on-call on NO-GO and persists the markdown report into operator_alerts so the dashboard always carries the latest verdict.",
  },
] as const;

const KNOWN_JOB_NAMES = new Set(KNOWN_BACKGROUND_JOBS.map((j) => j.name));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default overdue threshold per the task spec ("> 36h since last run"). */
export const DEFAULT_OVERDUE_AFTER_MS = 36 * 60 * 60 * 1000;

/** Cap stored summary / error length so a runaway log line cannot bloat the row. */
const MAX_SUMMARY_LEN = 500;
const MAX_ERROR_LEN = 1_000;

function truncate(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

export type JobRunStatus = "success" | "error";

export interface RecordJobRunArgs {
  jobName: string;
  startedAt: Date;
  finishedAt: Date;
  status: JobRunStatus;
  summary?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/**
 * Persist one `background_job_runs` row. The cron wrappers normally call
 * `withBackgroundJobRunRecord` instead — this is the lower-level primitive,
 * exported for tests and any future caller that wants to record a run
 * computed elsewhere.
 *
 * Throws if `jobName` is not in `KNOWN_BACKGROUND_JOBS` so a typo in a
 * wrapper produces a loud failure rather than a silently-orphan row that
 * never appears in the dashboard.
 */
export async function recordBackgroundJobRun(
  args: RecordJobRunArgs,
): Promise<BackgroundJobRun> {
  if (!KNOWN_JOB_NAMES.has(args.jobName)) {
    throw new Error(
      `recordBackgroundJobRun: unknown jobName='${args.jobName}'. ` +
        `Add it to KNOWN_BACKGROUND_JOBS in server/services/background-jobs.ts.`,
    );
  }
  if (args.status !== "success" && args.status !== "error") {
    throw new Error(
      `recordBackgroundJobRun: status must be 'success' or 'error' (got '${args.status}')`,
    );
  }
  const [row] = await db
    .insert(backgroundJobRuns)
    .values({
      jobName: args.jobName,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      status: args.status,
      summary: truncate(args.summary, MAX_SUMMARY_LEN),
      errorMessage: truncate(args.errorMessage, MAX_ERROR_LEN),
      durationMs: args.durationMs ?? null,
    })
    .returning();
  return row;
}

/**
 * Wrap a cron tick so its outcome lands in `background_job_runs`.
 *
 * The supplied `fn` may return a string summary (preferred — surfaces in
 * the dashboard) or void. Errors are caught, recorded as status='error',
 * AND re-thrown so the existing `try { ... } catch (e) { console.error }`
 * around each cron in `server/index.ts` keeps logging exactly as before.
 *
 * Persistence failures (DB write errors) are swallowed with a console.error
 * so a transient DB blip never crashes the cron itself.
 */
export async function withBackgroundJobRunRecord<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!KNOWN_JOB_NAMES.has(jobName)) {
    // Same loud-failure stance as `recordBackgroundJobRun`.
    throw new Error(
      `withBackgroundJobRunRecord: unknown jobName='${jobName}'. ` +
        `Add it to KNOWN_BACKGROUND_JOBS in server/services/background-jobs.ts.`,
    );
  }
  const startedAt = new Date();
  try {
    const result = await fn();
    const finishedAt = new Date();
    const summary = typeof result === "string" ? result : null;
    try {
      await recordBackgroundJobRun({
        jobName,
        startedAt,
        finishedAt,
        status: "success",
        summary,
        errorMessage: null,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (e) {
      // Don't let a bookkeeping failure break the cron.
      console.error(
        `[background-jobs] failed to record success row for ${jobName}`,
        e,
      );
    }
    return result;
  } catch (err) {
    const finishedAt = new Date();
    const message = err instanceof Error ? err.message : String(err);
    try {
      await recordBackgroundJobRun({
        jobName,
        startedAt,
        finishedAt,
        status: "error",
        summary: null,
        errorMessage: message,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (e2) {
      console.error(
        `[background-jobs] failed to record error row for ${jobName}`,
        e2,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read side — health snapshot
// ---------------------------------------------------------------------------

export interface JobHealth {
  name: string;
  label: string;
  description: string;
  /** Most recent run, regardless of outcome. Null if never recorded. */
  lastRun: {
    id: number;
    startedAt: string;
    finishedAt: string | null;
    status: JobRunStatus;
    summary: string | null;
    errorMessage: string | null;
    durationMs: number | null;
  } | null;
  /** Most recent SUCCESSFUL run. Null if never succeeded. */
  lastSuccessAt: string | null;
  /** Age (ms) of `lastRun.startedAt` relative to `now`. Null if never ran. */
  ageMs: number | null;
  /** True iff the job has NEVER recorded any run. */
  neverRan: boolean;
  /** True iff `ageMs` exceeds `overdueAfterMs` OR `neverRan` is true. */
  isOverdue: boolean;
}

export interface BackgroundJobsHealth {
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** Threshold (ms) used to flag a job as overdue. */
  overdueAfterMs: number;
  jobs: JobHealth[];
}

export interface GetBackgroundJobsHealthOptions {
  /** Override the overdue threshold. Defaults to `DEFAULT_OVERDUE_AFTER_MS`. */
  overdueAfterMs?: number;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * One-row-per-known-job health snapshot. Computed in a single round-trip
 * via `DISTINCT ON (jobName)` so it stays cheap even as the runs table
 * grows. The "last successful" timestamp is fetched in the same query as
 * the "last run" (success OR error) so the UI can distinguish "ran but
 * crashed" from "ran cleanly".
 */
export async function getBackgroundJobsHealth(
  options: GetBackgroundJobsHealthOptions = {},
): Promise<BackgroundJobsHealth> {
  const now = options.now ?? new Date();
  const overdueAfterMs = options.overdueAfterMs ?? DEFAULT_OVERDUE_AFTER_MS;

  // Fetch the most recent row per jobName via DISTINCT ON. Drizzle doesn't
  // expose DISTINCT ON cleanly, so we use a small hand-written SELECT.
  const lastRunResult = await db.execute(sql`
    SELECT DISTINCT ON (job_name)
      id,
      job_name AS "jobName",
      started_at AS "startedAt",
      finished_at AS "finishedAt",
      status,
      summary,
      error_message AS "errorMessage",
      duration_ms AS "durationMs"
    FROM background_job_runs
    ORDER BY job_name, started_at DESC, id DESC
  `);

  // Same shape, but limited to status='success' so we can show the last
  // CLEAN run independently of the last attempt.
  const lastSuccessResult = await db.execute(sql`
    SELECT DISTINCT ON (job_name)
      job_name AS "jobName",
      started_at AS "startedAt"
    FROM background_job_runs
    WHERE status = 'success'
    ORDER BY job_name, started_at DESC, id DESC
  `);

  const lastRunRows = extractRows<{
    id: number;
    jobName: string;
    startedAt: Date | string;
    finishedAt: Date | string | null;
    status: string;
    summary: string | null;
    errorMessage: string | null;
    durationMs: number | null;
  }>(lastRunResult);
  const lastSuccessRows = extractRows<{
    jobName: string;
    startedAt: Date | string;
  }>(lastSuccessResult);

  const lastRunByName = new Map(lastRunRows.map((r) => [r.jobName, r]));
  const lastSuccessByName = new Map(
    lastSuccessRows.map((r) => [r.jobName, r.startedAt]),
  );

  const jobs: JobHealth[] = KNOWN_BACKGROUND_JOBS.map((job) => {
    const lastRunRow = lastRunByName.get(job.name) ?? null;
    const lastSuccessAt = lastSuccessByName.get(job.name) ?? null;
    const ageMs = lastRunRow
      ? now.getTime() - new Date(lastRunRow.startedAt).getTime()
      : null;
    const neverRan = lastRunRow === null;
    const isOverdue = neverRan || (ageMs !== null && ageMs > overdueAfterMs);
    return {
      name: job.name,
      label: job.label,
      description: job.description,
      lastRun: lastRunRow
        ? {
            id: lastRunRow.id,
            startedAt: new Date(lastRunRow.startedAt).toISOString(),
            finishedAt: lastRunRow.finishedAt
              ? new Date(lastRunRow.finishedAt).toISOString()
              : null,
            status: lastRunRow.status as JobRunStatus,
            summary: lastRunRow.summary,
            errorMessage: lastRunRow.errorMessage,
            durationMs: lastRunRow.durationMs,
          }
        : null,
      lastSuccessAt: lastSuccessAt
        ? new Date(lastSuccessAt).toISOString()
        : null,
      ageMs,
      neverRan,
      isOverdue,
    };
  });

  return {
    generatedAt: now.toISOString(),
    overdueAfterMs,
    jobs,
  };
}
