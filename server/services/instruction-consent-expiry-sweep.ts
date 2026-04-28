// =============================================================================
// TASK #309 — Auto-cancel investment instructions whose consent window has
// elapsed.
// -----------------------------------------------------------------------------
// Task #292 added an `expiresAt` deadline to every newly-raised investment
// instruction (default 7 days, configurable via the env var
// INVESTMENT_INSTRUCTION_CONSENT_TTL_DAYS — see
// `getInstructionConsentTtlMs()` in `adviser-access.ts`). Without a periodic
// sweep an instruction whose deadline has passed sits in the adviser table
// indefinitely with a stale "expired" date but a `pending_consent` status;
// worse, a client could still consent to a long-stale recommendation.
//
// What this sweep does (and ONLY does):
//   * SELECT every investment_instructions row in status='pending_consent'
//     whose `expiresAt` is non-null and not in the future.
//   * For each row, UPDATE status -> 'cancelled', stamp updatedAt, and
//     write ONE audit_logs row under
//     action='investment_instruction.auto_cancelled_expired' so a
//     regulator can trace the system action that touched the row.
//   * Returns a summary the cron wrapper turns into the dashboard line.
//
// Hard rules:
//   * No money movement. No wallet, ledger, transaction, fee-consent, or
//     execution-authorisation rows are touched. The only writes are to
//     `investment_instructions` (status flip + updatedAt) and `audit_logs`.
//   * Failure of one row must not block the rest of the sweep — each
//     row is wrapped in its own try/catch so a stray DB error on row N
//     still lets row N+1 process.
//   * Idempotent: a re-run picks up zero rows because the previous tick
//     flipped them out of `pending_consent`.
//   * The state-machine guard in `consentClientInstruction` /
//     `rejectClientInstruction` already rejects writes against any
//     non-`pending_consent` row, so a client racing the sweep gets a
//     clean 400 (not a silent overwrite of `cancelled`).
// =============================================================================

import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "../db";
import { investmentInstructions } from "../../shared/schema";
import { writeAuditLog } from "./audit";

export interface InstructionConsentExpirySweepSummary {
  /** Rows examined in this sweep (every expired pending_consent row). */
  checked: number;
  /** Rows successfully transitioned to `cancelled`. */
  cancelled: number;
  /** Rows whose UPDATE or audit insert threw — logged and skipped. */
  errors: number;
}

export interface RunInstructionConsentExpirySweepOpts {
  /**
   * Override the wall clock — used by tests so the candidate selection
   * is deterministic without time-travel. Production callers omit this
   * and the sweep uses `new Date()`.
   */
  now?: Date;
}

/**
 * Cancel every `pending_consent` investment instruction whose `expiresAt`
 * has passed. Safe to run on any cadence; idempotent across re-runs.
 *
 * Returns a small summary so the cron wrapper can build a one-line entry
 * for the admin Background Jobs dashboard.
 */
export async function runInstructionConsentExpirySweep(
  opts: RunInstructionConsentExpirySweepOpts = {},
): Promise<InstructionConsentExpirySweepSummary> {
  const now = opts.now ?? new Date();
  const summary: InstructionConsentExpirySweepSummary = {
    checked: 0,
    cancelled: 0,
    errors: 0,
  };

  // Snapshot the candidate set up-front so a row that races a client
  // consent / rejection mid-loop is still examined under the version we
  // saw at the start of the tick. The status transition guard inside the
  // UPDATE WHERE clause below catches any such race.
  const candidates = await db
    .select()
    .from(investmentInstructions)
    .where(
      and(
        eq(investmentInstructions.status, "pending_consent"),
        isNotNull(investmentInstructions.expiresAt),
        lte(investmentInstructions.expiresAt, now),
      ),
    );

  summary.checked = candidates.length;

  for (const row of candidates) {
    try {
      // Per-row transaction: the UPDATE and the audit insert land together,
      // so a failure on either side rolls BOTH back. Without this, an audit
      // failure would leave the row permanently `cancelled` with no audit
      // trail and no chance of retry on the next sweep tick (the row would
      // no longer match `status = 'pending_consent'`). `writeAuditLog`
      // itself is fail-closed, so a stuck audit table surfaces here as a
      // per-row error rather than a silent skip.
      //
      // The `lostRace` flag escapes the closure so we can distinguish
      // "the client beat us to it" (no audit row, not an error) from
      // "we successfully cancelled and audited" — the latter is the only
      // path that increments `summary.cancelled`.
      let lostRace = false;

      await db.transaction(async (tx) => {
        // The extra `status = 'pending_consent'` clause in the UPDATE WHERE
        // closes the race with `consentClientInstruction` /
        // `rejectClientInstruction`: if the client transitioned the row in
        // the gap between SELECT and UPDATE, zero rows are returned and we
        // skip the audit write — the client's terminal state stands.
        const updated = await tx
          .update(investmentInstructions)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(investmentInstructions.id, row.id),
              eq(investmentInstructions.status, "pending_consent"),
            ),
          )
          .returning();

        if (updated.length === 0) {
          lostRace = true;
          return;
        }

        await writeAuditLog({
          executor: tx,
          userId: null,
          action: "investment_instruction.auto_cancelled_expired",
          entityType: "investment_instruction",
          entityId: String(row.id),
          before: {
            status: row.status,
            expiresAt: row.expiresAt,
          },
          after: {
            status: updated[0].status,
            expiresAt: updated[0].expiresAt,
            updatedAt: updated[0].updatedAt,
          },
          extra: {
            adviserUserId: row.adviserUserId,
            clientUserId: row.clientUserId,
            productId: row.productId,
            action: row.action,
            amount: row.amount,
            trigger: "instruction_consent_expiry_sweep",
          },
          ipAddress: null,
        });
      });

      if (!lostRace) {
        summary.cancelled++;
      }
    } catch (err) {
      summary.errors++;
      console.error(
        `[instruction-consent-expiry-sweep] failed to cancel ` +
          `investment_instruction.id=${row.id}`,
        err,
      );
    }
  }

  return summary;
}
