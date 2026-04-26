// =============================================================================
// INSUFFICIENT-FUNDS SWEEP (Task #64)
// =============================================================================
// Re-checks every adviser fee deduction parked in `insufficient_funds` and:
//
//   1. Re-attempts settlement via settleApprovedDeduction(). If the client's
//      ledger-derived balance now covers `totalAccrued`, the same settlement
//      path that runs in the admin "Approve" flow runs here, posts the
//      balanced 3-entry triple, and flips the row to `settled`. The
//      transaction's idempotency key (`fee_deduction_<id>`) guarantees we
//      cannot double-settle even if the cron and an admin click race.
//
//   2. If settlement still fails with InsufficientFundsError, sends the
//      client a "your fee couldn't be deducted" notification with the
//      required vs. available numbers — debounced via `clientNotifiedAt` so
//      a long-held insufficient row doesn't spam the client every day.
//
//   3. Bumps `lastRecheckedAt` on every visit (settled, still insufficient,
//      or unrelated error) so the admin UI can render "last re-checked Xh
//      ago" without grepping logs.
//
// Hard rules:
//   - NO money movement happens here directly. settleApprovedDeduction is
//     the single ledger-writing entry point; this service only orchestrates
//     it and writes notification/recheck bookkeeping columns.
//   - Failure of one deduction (email bounces, unrelated DB error, etc.)
//     must not prevent the sweep from continuing on remaining deductions.
//   - The cron caller wraps runInsufficientFundsSweep() in try/catch so a
//     thrown error here cannot crash the server process.
// =============================================================================

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  adviserFeeDeductions,
  auditLogs,
  users,
} from "../../shared/schema";
import {
  settleApprovedDeduction,
  InsufficientFundsError,
} from "./fee-engine";
import { sendInsufficientFundsEmail } from "../email";

// Default 7-day re-notification debounce. Override with the
// INSUFFICIENT_FUNDS_RENOTIFY_DAYS env var if a deployment wants tighter
// reminders (e.g. 3 days) — must be a positive integer or the default applies.
function getRenotifyIntervalMs(): number {
  const raw = process.env.INSUFFICIENT_FUNDS_RENOTIFY_DAYS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) {
      return n * 24 * 60 * 60 * 1000;
    }
  }
  return 7 * 24 * 60 * 60 * 1000;
}

export interface InsufficientFundsSweepSummary {
  checked: number;
  settled: number;
  stillInsufficient: number;
  errors: number;
  notificationsSent: number;
  notificationsSkippedDueToDebounce: number;
  notificationsFailed: number;
}

export interface RunInsufficientFundsSweepOpts {
  // Override the system actor recorded as `approvedByUserId` when a sweep
  // re-attempt succeeds. Defaults to the PLATFORM_USER_ID env var (the same
  // user that owns the platform_suspense account).
  approverUserId?: number;
  // Override the wall clock — used by tests to make debounce deterministic.
  now?: Date;
  // Override the re-notification debounce window — used by tests.
  renotifyIntervalMs?: number;
}

function resolveApproverUserId(override?: number): number {
  if (typeof override === "number" && Number.isInteger(override) && override > 0) {
    return override;
  }
  const raw = process.env.PLATFORM_USER_ID;
  if (!raw) {
    throw new Error(
      "PLATFORM_USER_ID env var is required for the insufficient-funds sweep " +
        "(it is recorded as approvedByUserId on auto-retried settlements).",
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `PLATFORM_USER_ID must be a positive integer; got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export async function runInsufficientFundsSweep(
  opts: RunInsufficientFundsSweepOpts = {},
): Promise<InsufficientFundsSweepSummary> {
  const now = opts.now ?? new Date();
  const approverUserId = resolveApproverUserId(opts.approverUserId);
  const renotifyIntervalMs =
    opts.renotifyIntervalMs ?? getRenotifyIntervalMs();

  const summary: InsufficientFundsSweepSummary = {
    checked: 0,
    settled: 0,
    stillInsufficient: 0,
    errors: 0,
    notificationsSent: 0,
    notificationsSkippedDueToDebounce: 0,
    notificationsFailed: 0,
  };

  // Snapshot the candidate set up-front so a row that gets settled mid-loop
  // (and therefore moves out of the insufficient_funds status) still has its
  // tracking columns updated by us. We deliberately skip rows already
  // marked as reversed so we don't try to settle a refunded row.
  const candidates = await db
    .select()
    .from(adviserFeeDeductions)
    .where(
      and(
        eq(adviserFeeDeductions.status, "insufficient_funds"),
        // reversedAt IS NULL — never re-attempt a row that was already reversed.
        // Drizzle's eq() can't express IS NULL directly, so we use sql template.
        sql`${adviserFeeDeductions.reversedAt} IS NULL`,
      ),
    );

  for (const d of candidates) {
    summary.checked++;

    let settleErr: unknown = null;
    try {
      const result = await settleApprovedDeduction({
        deductionId: d.id,
        approverUserId,
      });
      if (result.status === "settled") {
        summary.settled++;
        // The settle path doesn't touch lastRecheckedAt; record it now so the
        // admin UI shows "last re-checked: just now" alongside the new
        // settled state.
        await db
          .update(adviserFeeDeductions)
          .set({ lastRecheckedAt: now })
          .where(eq(adviserFeeDeductions.id, d.id));
        await db.insert(auditLogs).values({
          userId: approverUserId,
          action: "fee_deduction.auto_resettled",
          entityType: "adviser_fee_deduction",
          entityId: String(d.id),
          metadata: {
            clientUserId: d.clientUserId,
            adviserUserId: d.adviserUserId,
            totalAccrued: d.totalAccrued,
            currency: d.currency,
            settledTransactionId: result.settledTransactionId,
            trigger: "insufficient_funds_sweep",
          },
          ipAddress: null,
        });
        continue;
      }
      // Defensive: if settle returned something other than `settled` without
      // throwing, just bump lastRecheckedAt. Today this branch is unreachable
      // — settleApprovedDeduction either returns `settled` or throws.
      await db
        .update(adviserFeeDeductions)
        .set({ lastRecheckedAt: now })
        .where(eq(adviserFeeDeductions.id, d.id));
    } catch (err) {
      settleErr = err;
    }

    if (settleErr === null) continue;

    if (settleErr instanceof InsufficientFundsError) {
      summary.stillInsufficient++;

      const lastNotifiedMs = d.clientNotifiedAt
        ? new Date(d.clientNotifiedAt).getTime()
        : 0;
      const dueForNotification =
        lastNotifiedMs === 0 ||
        now.getTime() - lastNotifiedMs >= renotifyIntervalMs;

      if (!dueForNotification) {
        summary.notificationsSkippedDueToDebounce++;
        await db
          .update(adviserFeeDeductions)
          .set({ lastRecheckedAt: now })
          .where(eq(adviserFeeDeductions.id, d.id));
        continue;
      }

      // Look up the client's email + first name. Done outside the settle
      // try/catch so a failure here doesn't get mis-attributed.
      let dispatch: { sent: boolean; error?: string } = {
        sent: false,
        error: "client lookup failed",
      };
      try {
        const [client] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
          })
          .from(users)
          .where(eq(users.id, d.clientUserId));
        if (client?.email) {
          const required = Number(settleErr.required);
          const available = Number(settleErr.available);
          const shortfall = Math.max(0, required - available);
          dispatch = await sendInsufficientFundsEmail({
            to: client.email,
            firstName: client.firstName || "there",
            deductionId: d.id,
            required: settleErr.required,
            available: settleErr.available,
            currency: settleErr.currency,
            shortfall: shortfall.toFixed(2),
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
          });
        } else {
          dispatch = {
            sent: false,
            error: "client has no email address on file",
          };
        }
      } catch (notifyErr: any) {
        dispatch = {
          sent: false,
          error: notifyErr?.message || String(notifyErr),
        };
      }

      // Always bump lastRecheckedAt + clientNotifiedAt + count whenever we
      // were due for a notification — even if SMTP failed. The admin UI
      // shows "notification last attempted at ..." regardless of dispatch
      // success so operators can see *something* happened, and the audit
      // log carries the success/failure detail.
      await db
        .update(adviserFeeDeductions)
        .set({
          lastRecheckedAt: now,
          clientNotifiedAt: now,
          clientNotificationCount: sql`${adviserFeeDeductions.clientNotificationCount} + 1`,
        })
        .where(eq(adviserFeeDeductions.id, d.id));

      if (dispatch.sent) {
        summary.notificationsSent++;
      } else {
        summary.notificationsFailed++;
      }

      await db.insert(auditLogs).values({
        userId: approverUserId,
        action: dispatch.sent
          ? "fee_deduction.client_notified"
          : "fee_deduction.client_notification_failed",
        entityType: "adviser_fee_deduction",
        entityId: String(d.id),
        metadata: {
          clientUserId: d.clientUserId,
          adviserUserId: d.adviserUserId,
          required: settleErr.required,
          available: settleErr.available,
          currency: settleErr.currency,
          trigger: "insufficient_funds_sweep",
          ...(dispatch.error ? { error: dispatch.error } : {}),
        },
        ipAddress: null,
      });
      continue;
    }

    // Unknown error during settle — log it, bump lastRecheckedAt only, keep
    // going. This is the path that stops a single bad row from killing the
    // entire sweep.
    summary.errors++;
    const errMsg =
      settleErr instanceof Error ? settleErr.message : String(settleErr);
    console.error(
      `[insufficient-funds-sweep] settle failed for deduction #${d.id}:`,
      errMsg,
    );
    try {
      await db
        .update(adviserFeeDeductions)
        .set({ lastRecheckedAt: now })
        .where(eq(adviserFeeDeductions.id, d.id));
    } catch (updateErr: any) {
      console.error(
        `[insufficient-funds-sweep] failed to bump lastRecheckedAt for #${d.id}:`,
        updateErr?.message || updateErr,
      );
    }
  }

  console.log(
    `[insufficient-funds-sweep] checked=${summary.checked} ` +
      `settled=${summary.settled} stillInsufficient=${summary.stillInsufficient} ` +
      `notified=${summary.notificationsSent} ` +
      `debounced=${summary.notificationsSkippedDueToDebounce} ` +
      `notifyFailed=${summary.notificationsFailed} ` +
      `errors=${summary.errors}`,
  );

  return summary;
}
