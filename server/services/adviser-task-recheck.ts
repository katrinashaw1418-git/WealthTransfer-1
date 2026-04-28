// =============================================================================
// Task #368 — ADVISER TASK RECHECK & AUTO-CLOSE
// -----------------------------------------------------------------------------
// Re-evaluates the underlying condition for every open or
// dismissed-but-unconsumed adviser task and:
//
//   • For OPEN/IN_PROGRESS tasks whose condition is now resolved, sets
//     status='done', completedAt=NOW, autoCloseReason='resolved automatically'.
//     These tasks are filtered out of the adviser's list response (see
//     listAdviserTasks) — the adviser never sees the now-stale row.
//
//   • For DISMISSED tasks (status='done'|'cancelled', dismissedByAdviser=true,
//     autoCloseReason IS NULL) whose condition is now resolved, stamps
//     autoCloseReason='resolved automatically' on the existing closed row
//     WITHOUT touching status / completedAt / dismissedByAdviser. This
//     "consumes" the suppression so a later flip back from resolved →
//     unresolved produces a fresh task instead of being silently swallowed
//     by the prior dismissal. (Spec: "the automation does not re-create a
//     task that the adviser explicitly dismissed unless the underlying
//     condition flips back from resolved to unresolved.")
//
// The function is idempotent: it never re-stamps a row that already has
// autoCloseReason set, and it never reopens a row the adviser closed.
//
// CALLERS:
//   - listAdviserTasks() runs it for the requesting adviser before reading,
//     so the GET /api/adviser/tasks response never contains a stale row.
//   - runAdviserTaskAutomation() runs it for every active adviser at the
//     top of the cron pass so the suppression check downstream sees a
//     fresh state.
// =============================================================================

import { db } from "../db";
import {
  users,
  adviserTasks,
  feeConsents,
  parseFeeConsentTriggerKey,
} from "@shared/schema";
import { and, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const AUTO_CLOSE_REASON = "resolved automatically";

interface RecheckRow {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  taskType: string;
  triggerKey: string;
  status: string;
  dismissedByAdviser: boolean;
}

/**
 * Recheck and auto-close stale tasks for a single adviser. Convenience wrapper
 * around the multi-adviser version below; almost all on-demand callers (the
 * GET /api/adviser/tasks handler) use this form.
 */
export async function recheckAdviserTasks(adviserUserId: number): Promise<void> {
  await recheckAdviserTasksForAdvisers([adviserUserId]);
}

/**
 * Multi-adviser variant. Fetches all candidate tasks (open + dismissed-not-
 * consumed) for the given advisers in ONE query, then issues at most two
 * UPDATE statements (one for open→done, one for dismissed-consumed). Cheap
 * and safe to run on every cron tick.
 */
export async function recheckAdviserTasksForAdvisers(
  adviserUserIds: number[],
): Promise<void> {
  if (adviserUserIds.length === 0) return;

  // Pull every task that *could* be auto-closed or consumed:
  //   - open / in_progress (will be auto-closed if condition resolved)
  //   - dismissedByAdviser AND status closed AND autoCloseReason still NULL
  //     (will be consumed if condition resolved)
  // Tasks without a triggerKey (legacy rows) are ignored — we have no
  // recheckable condition to evaluate.
  const candidates = (await db
    .select({
      id: adviserTasks.id,
      adviserUserId: adviserTasks.adviserUserId,
      clientUserId: adviserTasks.clientUserId,
      taskType: adviserTasks.taskType,
      triggerKey: adviserTasks.triggerKey,
      status: adviserTasks.status,
      dismissedByAdviser: adviserTasks.dismissedByAdviser,
    })
    .from(adviserTasks)
    .where(
      and(
        inArray(adviserTasks.adviserUserId, adviserUserIds),
        isNotNull(adviserTasks.triggerKey),
        or(
          inArray(adviserTasks.status, ["open", "in_progress"]),
          and(
            inArray(adviserTasks.status, ["done", "cancelled"]),
            eq(adviserTasks.dismissedByAdviser, true),
            isNull(adviserTasks.autoCloseReason),
          ),
        ),
      ),
    )) as RecheckRow[];

  if (candidates.length === 0) return;

  // Build lookup maps for cheap condition evaluation.
  const clientIds = Array.from(new Set(candidates.map((r) => r.clientUserId)));
  const consentIds = Array.from(
    new Set(
      candidates
        .filter((r) => r.taskType === "fee_consent_renewal")
        .map((r) => parseFeeConsentTriggerKey(r.triggerKey))
        .filter((id): id is number => id != null),
    ),
  );

  // 1. KYC status per client.
  const userRows = clientIds.length
    ? await db
        .select({ id: users.id, kycStatus: users.kycStatus })
        .from(users)
        .where(inArray(users.id, clientIds))
    : [];
  const kycByClient = new Map<number, string | null>(
    userRows.map((u) => [u.id, u.kycStatus ?? null]),
  );

  // 2. Fee-consent rows by id (only the columns we need).
  const consentRows = consentIds.length
    ? await db
        .select({
          id: feeConsents.id,
          renewalStatus: feeConsents.renewalStatus,
          consentExpiryDate: feeConsents.consentExpiryDate,
        })
        .from(feeConsents)
        .where(inArray(feeConsents.id, consentIds))
    : [];
  const consentById = new Map(consentRows.map((c) => [c.id, c]));

  // 3. Most-recent COMPLETED portfolio_review per (adviser, client). We
  //    deliberately exclude the *candidate* dismissed rows themselves from
  //    this lookup if they were cancelled (no completedAt) — the
  //    `status='done'` filter naturally takes care of that.
  const reviewCandidates = candidates.filter(
    (r) => r.taskType === "portfolio_review",
  );
  const reviewKeys = new Set(
    reviewCandidates.map((r) => `${r.adviserUserId}:${r.clientUserId}`),
  );
  const lastReviewByPair = new Map<string, Date | null>();
  if (reviewKeys.size > 0) {
    const reviewRows = await db
      .select({
        adviserUserId: adviserTasks.adviserUserId,
        clientUserId: adviserTasks.clientUserId,
        lastCompletedAt: sql<Date | null>`max(${adviserTasks.completedAt})`,
      })
      .from(adviserTasks)
      .where(
        and(
          inArray(adviserTasks.adviserUserId, adviserUserIds),
          inArray(
            adviserTasks.clientUserId,
            reviewCandidates.map((r) => r.clientUserId),
          ),
          eq(adviserTasks.taskType, "portfolio_review"),
          eq(adviserTasks.status, "done"),
        ),
      )
      .groupBy(adviserTasks.adviserUserId, adviserTasks.clientUserId);
    for (const r of reviewRows) {
      lastReviewByPair.set(
        `${r.adviserUserId}:${r.clientUserId}`,
        r.lastCompletedAt ? new Date(r.lastCompletedAt) : null,
      );
    }
  }

  const now = new Date();
  const nowMs = now.getTime();

  const idsToAutoClose: number[] = []; // open/in_progress → done + autoCloseReason
  const idsToConsume: number[] = []; // dismissed → autoCloseReason only

  for (const row of candidates) {
    const resolved = isConditionResolved({
      row,
      kycByClient,
      consentById,
      lastReviewByPair,
      nowMs,
    });
    if (!resolved) continue;

    const isOpen = row.status === "open" || row.status === "in_progress";
    if (isOpen) {
      idsToAutoClose.push(row.id);
    } else {
      // status closed AND dismissedByAdviser AND autoCloseReason IS NULL
      idsToConsume.push(row.id);
    }
  }

  if (idsToAutoClose.length > 0) {
    await db
      .update(adviserTasks)
      .set({
        status: "done",
        completedAt: now,
        autoCloseReason: AUTO_CLOSE_REASON,
        updatedAt: now,
      })
      .where(inArray(adviserTasks.id, idsToAutoClose));
  }

  if (idsToConsume.length > 0) {
    await db
      .update(adviserTasks)
      .set({
        autoCloseReason: AUTO_CLOSE_REASON,
        updatedAt: now,
      })
      .where(inArray(adviserTasks.id, idsToConsume));
  }
}

interface ConditionInput {
  row: RecheckRow;
  kycByClient: Map<number, string | null>;
  consentById: Map<
    number,
    { id: number; renewalStatus: string; consentExpiryDate: Date }
  >;
  lastReviewByPair: Map<string, Date | null>;
  nowMs: number;
}

/**
 * Returns true when the row's underlying triggering condition is no
 * longer true. The three conditions match the three creation triggers in
 * `runAdviserTaskAutomation`:
 *
 *   kyc_followup        — resolved iff client.kycStatus === 'verified'
 *   fee_consent_renewal — resolved iff the specific fee_consents row is
 *                          gone, no longer 'active', already past expiry,
 *                          or no longer expiring within the 30-day window
 *   portfolio_review    — resolved iff a completed portfolio_review for
 *                          this (adviser, client) is on file within the
 *                          last 90 days
 *
 * The same logic is reused for both auto-closing OPEN tasks and consuming
 * DISMISSED suppression — there is exactly one definition of "resolved".
 */
function isConditionResolved(input: ConditionInput): boolean {
  const { row, kycByClient, consentById, lastReviewByPair, nowMs } = input;

  switch (row.taskType) {
    case "kyc_followup": {
      const status = kycByClient.get(row.clientUserId) ?? null;
      return status === "verified";
    }
    case "fee_consent_renewal": {
      const consentId = parseFeeConsentTriggerKey(row.triggerKey);
      if (consentId == null) return true; // malformed key — treat as resolved
      const consent = consentById.get(consentId);
      if (!consent) return true; // row gone — nothing to chase
      if (consent.renewalStatus !== "active") return true;
      const expiryMs = consent.consentExpiryDate.getTime();
      // Resolved when the row is no longer in the (now, now+30d] window —
      // either it has slipped into the past (a different code path will
      // handle that) or it has been pushed beyond 30 days (renewal extended
      // the expiry).
      const inWindow = expiryMs >= nowMs && expiryMs <= nowMs + THIRTY_DAYS_MS;
      return !inWindow;
    }
    case "portfolio_review": {
      const key = `${row.adviserUserId}:${row.clientUserId}`;
      const lastReview = lastReviewByPair.get(key) ?? null;
      if (!lastReview) return false;
      return nowMs - lastReview.getTime() <= NINETY_DAYS_MS;
    }
    default:
      // Unknown task type — leave it alone (we never created it ourselves).
      return false;
  }
}
