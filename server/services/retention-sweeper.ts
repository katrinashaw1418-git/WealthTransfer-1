// =============================================================================
// Task #330 — Daily 7-year retention sweeper
// =============================================================================
// Companion to the schema default (`now() + interval '7 years'` on every
// regulatory `retention_until` column) and `evaluateRetentionLock` in
// `document-retention.ts`. With those two pieces alone the boolean
// `deletion_locked` flag would stay `true` forever — there was no automated
// path for a row to ever become delete-eligible once the 7-year window
// genuinely lapses.
//
// This sweeper closes the loop: once a day it scans every retention table
// for rows whose `retention_until < now()` AND `deletion_locked = true`,
// flips the flag to `false`, and writes a single `document.retention.expired`
// audit row per cleared row. The DELETE route's
// `evaluateRetentionLock` then naturally unblocks the row because both
// halves of the lock contract resolve to "unlocked".
//
// Hard rules:
//   1. The sweeper NEVER deletes data. It only flips a boolean and writes
//      an audit row. Actual deletion is an explicit adviser action through
//      the existing DELETE route, which still re-evaluates the lock at
//      request time (defence in depth).
//
//   2. Idempotent. A row already at `deletion_locked = false` is left
//      alone — no UPDATE, no audit row. Re-running the sweep on the same
//      day with no new expirations is a true no-op.
//
//   3. Per-row audit insert. We deliberately do NOT batch the audit
//      writes: an auditor reading the log must be able to see ONE row
//      per regulatory artefact that became delete-eligible on a given
//      sweep, not a single aggregate row that hides the per-row identity.
//      The volume is bounded by "rows expiring on this day", which is
//      tiny compared to a normal day's auditLogs traffic.
//
//   4. Failure of one row must not poison the whole sweep. We catch around
//      the per-row work, increment an error counter, log the offender, and
//      continue.
//
//   5. The sweep wraps the per-row UPDATE + audit insert in a single
//      `db.transaction` so we cannot end up in a state where the lock was
//      cleared but the audit row is missing (a regulator-visible
//      inconsistency).
// =============================================================================

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  factFindSnapshots,
  riskProfiles,
  adviceRecords,
  soaDocuments,
  roaDocuments,
  feeConsents,
  adviceAcknowledgements,
  executionAuthorisations,
  clientObjectives,
  clientDocuments,
  adviserNotes,
  adviceRecordVersions,
} from "../../shared/schema";
import { writeAuditLog } from "./audit";

// ---------------------------------------------------------------------------
// Catalogue of tables the sweeper operates on. Listing them in one place
// (instead of scattering twelve nearly-identical loops through this module)
// makes it impossible to add a new retention table without also wiring it
// into the sweeper — the function below iterates this array and a missing
// entry will simply be unreachable.
//
// `entityType` matches the snake_case table name so audit consumers can
// filter on it the same way they do for the `document.delete.blocked`
// rows already written by the DELETE routes.
// ---------------------------------------------------------------------------

interface RetentionTableSpec {
  /** Drizzle table reference. Typed as a structural shape so the iteration
   * loop can stay generic across all twelve tables. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Snake_case table name used in the audit row's `entityType` field. */
  entityType: string;
}

export const RETENTION_TABLES: readonly RetentionTableSpec[] = [
  { table: factFindSnapshots,        entityType: "fact_find_snapshot" },
  { table: riskProfiles,             entityType: "risk_profile" },
  { table: adviceRecords,            entityType: "advice_record" },
  { table: soaDocuments,             entityType: "soa_document" },
  { table: roaDocuments,             entityType: "roa_document" },
  { table: feeConsents,              entityType: "fee_consent" },
  { table: adviceAcknowledgements,   entityType: "advice_acknowledgement" },
  { table: executionAuthorisations,  entityType: "execution_authorisation" },
  { table: clientObjectives,         entityType: "client_objective" },
  { table: clientDocuments,          entityType: "client_document" },
  { table: adviserNotes,             entityType: "adviser_note" },
  { table: adviceRecordVersions,     entityType: "advice_record_version" },
];

export interface RetentionSweeperPerTableSummary {
  entityType: string;
  cleared: number;
  errors: number;
}

export interface RetentionSweeperSummary {
  /** Wall-clock start of the sweep — used so test fixtures can pin the
   * "now" comparison against a deterministic instant. */
  ranAt: Date;
  /** Total rows whose `deletion_locked` flag was flipped from true→false. */
  totalCleared: number;
  /** Total per-row failures. Always 0 in healthy operation. */
  totalErrors: number;
  perTable: RetentionSweeperPerTableSummary[];
}

export interface RunRetentionSweeperOpts {
  /** Override the wall clock — used by tests to drive deterministic
   * "this row has expired" boundaries without sleeping. */
  now?: Date;
}

/**
 * Sweep every retention table once and clear `deletion_locked` on rows
 * whose `retention_until` is now in the past.
 *
 * Returns a summary suitable for the cron wrapper's per-tick log line.
 * Never throws on per-row errors — those are tallied into the summary.
 * Throws only on a total infrastructure failure (e.g. DB unreachable),
 * matching the contract every other sweeper in this folder honours.
 */
export async function runRetentionSweeper(
  opts: RunRetentionSweeperOpts = {},
): Promise<RetentionSweeperSummary> {
  const ranAt = opts.now ?? new Date();
  const perTable: RetentionSweeperPerTableSummary[] = [];
  let totalCleared = 0;
  let totalErrors = 0;

  for (const spec of RETENTION_TABLES) {
    const t = spec.table;

    // Pull the candidates first, then process them one at a time. We do
    // NOT do "UPDATE … WHERE retention_until < now() AND deletion_locked
    // RETURNING id" because we still need to write a per-row audit row
    // inside the same transaction as the flip, and Drizzle's bulk RETURNING
    // doesn't fit cleanly with that requirement. The candidate set is
    // bounded by "rows expiring on this day", so the row-by-row loop stays
    // cheap in practice.
    let candidates: Array<{ id: number; retentionUntil: Date | null }>;
    try {
      candidates = await db
        .select({ id: t.id, retentionUntil: t.retentionUntil })
        .from(t)
        .where(
          and(
            eq(t.deletionLocked, true),
            lt(t.retentionUntil, ranAt),
          ),
        );
    } catch (err) {
      // A select failure is unusual enough that we want it loud. Tally it
      // as a single table-level error and move on — the next sweep tick
      // will retry.
      console.error(
        `[retention-sweeper] select failed for ${spec.entityType}:`,
        (err as Error).message,
      );
      perTable.push({ entityType: spec.entityType, cleared: 0, errors: 1 });
      totalErrors += 1;
      continue;
    }

    let cleared = 0;
    let errors = 0;

    for (const row of candidates) {
      try {
        await db.transaction(async (tx) => {
          // Defence-in-depth: re-check both predicates inside the tx so a
          // concurrent admin clearing the lock or extending retention
          // doesn't get clobbered. The UPDATE will be a no-op (0 rows
          // affected) in that race, which we surface by reading the
          // returned row count.
          const updated = await tx
            .update(t)
            .set({ deletionLocked: false })
            .where(
              and(
                eq(t.id, row.id),
                eq(t.deletionLocked, true),
                lt(t.retentionUntil, ranAt),
              ),
            )
            .returning({ id: t.id });
          if (updated.length === 0) {
            // Lost the race — another writer already cleared the lock
            // (or extended retention). Nothing to audit.
            return;
          }
          await writeAuditLog({
            executor: tx,
            // Sweeper is a system action — no human actor. Mirrors the
            // convention used by every other cron in this folder
            // (insufficient-funds-sweep, fee-engine reconcile, etc.).
            userId: null,
            action: "document.retention.expired",
            entityType: spec.entityType,
            entityId: String(row.id),
            // Capture both halves of the boolean transition + the
            // retention_until that triggered the flip so an auditor can
            // reconstruct exactly what the sweeper saw.
            before: { deletionLocked: true },
            after: { deletionLocked: false },
            extra: {
              retentionUntil: row.retentionUntil
                ? row.retentionUntil.toISOString()
                : null,
              sweptAt: ranAt.toISOString(),
              policy: "Corporations Act s912G — 7 year retention elapsed",
            },
            ipAddress: null,
          });
        });
        cleared += 1;
      } catch (err) {
        // Per-row failure must not stop the sweep — log loudly so the
        // operator surface (error-log + structured stdout) catches it,
        // tally into the summary, and move on.
        console.error(
          `[retention-sweeper] failed to clear ${spec.entityType} id=${row.id}:`,
          (err as Error).message,
        );
        errors += 1;
      }
    }

    perTable.push({ entityType: spec.entityType, cleared, errors });
    totalCleared += cleared;
    totalErrors += errors;
  }

  return { ranAt, totalCleared, totalErrors, perTable };
}

/**
 * Format a summary into the short string the cron wrapper persists into
 * `background_job_runs.summary`. Keeps the formatting in one place so the
 * dashboard line shape is stable across calls.
 */
export function formatRetentionSweeperSummary(
  s: RetentionSweeperSummary,
): string {
  // Keep the per-table breakdown only for tables that actually cleared
  // something — twelve "x=0" entries every day would just be noise.
  const breakdown = s.perTable
    .filter((p) => p.cleared > 0 || p.errors > 0)
    .map((p) =>
      p.errors > 0
        ? `${p.entityType}=${p.cleared}(${p.errors} err)`
        : `${p.entityType}=${p.cleared}`,
    )
    .join(", ");
  const head = `cleared=${s.totalCleared}, errors=${s.totalErrors}`;
  return breakdown ? `${head} [${breakdown}]` : head;
}

// Re-export the action string so call sites and tests reference one constant.
export const RETENTION_EXPIRED_AUDIT_ACTION = "document.retention.expired";
