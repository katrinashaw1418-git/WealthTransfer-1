// =============================================================================
// SESSION 9.1 — ADVISER TASK AUTOMATION (daily cron)
// -----------------------------------------------------------------------------
// Scans every active adviser-client link once per day and CREATES open
// adviser_tasks rows for three deterministic trigger conditions:
//
//   1. kyc_followup            — client.kycStatus !== 'verified'
//   2. fee_consent_renewal     — active feeConsents.consentExpiryDate ≤ 30 days
//   3. portfolio_review        — no portfolio_review created in last 90 days
//
// HARD RULES (defence in depth, on top of the route-layer guards):
//   - Writes ONLY to adviser_tasks. No mutation of users, wallets,
//     transactions, ledger_entries, kycStatus, advice_records, fee_consents,
//     execution authorisations, or any other client-owned state.
//   - Idempotent: for each (adviser, client, taskType) pair we skip the
//     insert if an OPEN/IN_PROGRESS task of the same type already exists.
//     This means the cron can run any number of times without duplicating.
//   - Operates only on clients that already have an ACTIVE adviser_clients
//     link. Unlinked clients are invisible to this module.
//   - No money movement. No KYC bypass. No advice execution. The cron is a
//     work-list generator for advisers, nothing more.
//
// CONCURRENCY ASSUMPTION (documented for the next reviewer):
//   The current AMAX deployment topology is a SINGLE Express process. The
//   idempotency guard is therefore check-then-insert against the live DB
//   without an explicit lock or partial unique index. This is race-safe in
//   the single-process model. If we ever scale to multiple replicas, or run
//   the cron from an out-of-process scheduler that overlaps with an
//   in-process invocation, the guard must be hardened — either with a
//   partial unique index on adviser_tasks (adviserUserId, clientUserId,
//   taskType) WHERE status IN ('open','in_progress'), or with a distributed
//   leader-election lock around runAdviserTaskAutomation.
// =============================================================================

import { db } from "../db";
import {
  users,
  adviserClients,
  adviserTasks,
  feeConsents,
  assertAllowedAdviserTaskType,
  buildAdviserTaskTriggerKey,
  type AdviserTaskAllowedType,
} from "@shared/schema";
import { and, desc, eq, gte, lte, inArray, isNull, or, sql } from "drizzle-orm";
import { clientDisplayName } from "@shared/display-name";
import { recheckAdviserTasksForAdvisers } from "./adviser-task-recheck";

export interface TaskAutomationSummary {
  linksScanned: number;
  kycFollowupsCreated: number;
  feeConsentRenewalsCreated: number;
  portfolioReviewsCreated: number;
  // Skipped because an OPEN/IN_PROGRESS task of the same type already
  // exists for this (adviser, client) — true duplicate suppression.
  idempotencySkips: number;
  // Skipped because a portfolio_review was created within the last
  // 90 days regardless of status — quarterly cadence suppression.
  cadenceSkips: number;
  // Backward-compatible aggregate of the two above. Kept so existing log
  // parsers / tests that read `skipped` keep working.
  skipped: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Adapter around the shared display-name helper so server and UI agree.
export function clientLabelForTask(input: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  clientUserId: number;
}): string {
  return clientDisplayName(input, input.clientUserId);
}

// ---------------------------------------------------------------------------
// Task #368 — suppression check, keyed on the per-condition triggerKey rather
// than the broader (adviser, client, taskType) tuple. Returns true when ANY
// of the following is true for the given triggerKey:
//
//   1. There is an OPEN/IN_PROGRESS task for this triggerKey
//      → the adviser has not yet acted; don't duplicate.
//
//   2. There is a task that the adviser explicitly dismissed
//      (status='done' or 'cancelled' AND dismissedByAdviser = true)
//      whose `autoCloseReason` is NULL
//      → the adviser said "no thanks" and the recheck pipeline has not yet
//        seen the underlying condition resolve. We therefore must NOT
//        recreate. Once the condition resolves, the recheck stamps an
//        `autoCloseReason` on the dismissed row, releasing the suppression
//        so a future flip back to unresolved produces a fresh task.
//
// Tasks that were auto-closed by the recheck (autoCloseReason set, but not
// dismissedByAdviser) DO NOT suppress — re-creating after an auto-close is
// the legitimate "condition flipped back" path.
// ---------------------------------------------------------------------------
async function hasSuppressionForTriggerKey(
  adviserUserId: number,
  clientUserId: number,
  triggerKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: adviserTasks.id })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        eq(adviserTasks.clientUserId, clientUserId),
        eq(adviserTasks.triggerKey, triggerKey),
        or(
          inArray(adviserTasks.status, ["open", "in_progress"]),
          and(
            inArray(adviserTasks.status, ["done", "cancelled"]),
            eq(adviserTasks.dismissedByAdviser, true),
            isNull(adviserTasks.autoCloseReason),
          ),
        ),
      ),
    )
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// For portfolio_review specifically we want to suppress creation if ANY
// portfolio_review task (open OR completed OR cancelled) was created within
// the last 90 days. Otherwise an adviser who completes a review on day 1
// would get a fresh review task on day 2. Quarterly cadence = ~90 days.
// ---------------------------------------------------------------------------
async function hasRecentPortfolioReview(
  adviserUserId: number,
  clientUserId: number,
  ninetyDaysAgo: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: adviserTasks.id })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        eq(adviserTasks.clientUserId, clientUserId),
        eq(adviserTasks.taskType, "portfolio_review"),
        gte(adviserTasks.createdAt, ninetyDaysAgo),
      ),
    )
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Single-row insert helper. We use the same write path as the manual
// createAdviserTask service function — just without the route-layer
// assertAdviserClientLink call, because the caller already iterated the
// link table to obtain (adviserUserId, clientUserId).
//
// Task #368 — every insert now carries a `triggerKey` and is gated by the
// shared allow-list (`assertAllowedAdviserTaskType`) so the storage layer
// rejects any future code path that tries to slip in a non-trigger task.
// ---------------------------------------------------------------------------
async function createTask(input: {
  adviserUserId: number;
  clientUserId: number;
  taskType: AdviserTaskAllowedType;
  triggerKey: string;
  title: string;
  notes: string;
  priority: "low" | "normal" | "high" | "urgent";
  dueAt: Date | null;
}): Promise<void> {
  assertAllowedAdviserTaskType(input.taskType);
  await db.insert(adviserTasks).values({
    adviserUserId: input.adviserUserId,
    clientUserId: input.clientUserId,
    taskType: input.taskType,
    triggerKey: input.triggerKey,
    title: input.title,
    notes: input.notes,
    priority: input.priority,
    status: "open",
    dueAt: input.dueAt,
  });
}

// ---------------------------------------------------------------------------
// Main entry point. Returns a structured summary so the cron caller can log
// a single line. Errors on individual links are caught and logged so one
// bad row never aborts the whole run.
// ---------------------------------------------------------------------------
export async function runAdviserTaskAutomation(): Promise<TaskAutomationSummary> {
  const summary: TaskAutomationSummary = {
    linksScanned: 0,
    kycFollowupsCreated: 0,
    feeConsentRenewalsCreated: 0,
    portfolioReviewsCreated: 0,
    idempotencySkips: 0,
    cadenceSkips: 0,
    skipped: 0,
  };

  const now = new Date();
  const in30Days = new Date(now.getTime() + THIRTY_DAYS_MS);
  const ninetyDaysAgo = new Date(now.getTime() - NINETY_DAYS_MS);

  // 1. Pull every active adviser-client link with the client's kycStatus.
  //    A single join keeps the query count constant regardless of how many
  //    links exist.
  // Task #285 — also pull `kycUpdatedAt` (per-client signal used to anchor
  // KYC follow-up due dates instead of cron-run + N days) and the link
  // `linkedAt` (used as the portfolio-review fallback when the client has
  // never had a completed review on file).
  const links = await db
    .select({
      adviserUserId: adviserClients.adviserUserId,
      clientUserId: adviserClients.clientUserId,
      kycStatus: users.kycStatus,
      kycUpdatedAt: users.kycUpdatedAt,
      firstName: users.firstName,
      lastName: users.lastName,
      // Email is part of the label fallback chain (see clientLabelForTask).
      email: users.email,
      linkedAt: adviserClients.linkedAt,
    })
    .from(adviserClients)
    .innerJoin(users, eq(users.id, adviserClients.clientUserId))
    .where(eq(adviserClients.isActive, true));

  summary.linksScanned = links.length;
  if (links.length === 0) return summary;

  // Task #368 — run the recheck/auto-close pipeline FIRST so that any
  // dismissed-but-now-resolved task gets its `autoCloseReason` stamped
  // before the suppression check runs below. Without this, an adviser
  // whose dismissed kyc_followup task pre-dates the client becoming
  // verified would never get a fresh prompt when the client's KYC later
  // reverted to pending. The recheck is per-adviser to keep its working
  // set bounded, but we batch all the advisers we're about to scan into a
  // single call so the heavy queries (kyc, consents, last reviews) only
  // touch each table once.
  const adviserIds = Array.from(new Set(links.map((l) => l.adviserUserId)));
  await recheckAdviserTasksForAdvisers(adviserIds);

  // 2. Pre-fetch all expiring fee consents in ONE query, then index by
  //    clientId for O(1) lookups inside the link loop.
  const linkedClientIds = Array.from(new Set(links.map((l) => l.clientUserId)));
  const expiringConsents = await db
    .select({
      id: feeConsents.id,
      clientId: feeConsents.clientId,
      consentExpiryDate: feeConsents.consentExpiryDate,
    })
    .from(feeConsents)
    .where(
      and(
        inArray(feeConsents.clientId, linkedClientIds),
        eq(feeConsents.renewalStatus, "active"),
        gte(feeConsents.consentExpiryDate, now),
        lte(feeConsents.consentExpiryDate, in30Days),
      ),
    );
  const expiringByClient = new Map<number, typeof expiringConsents>();
  for (const c of expiringConsents) {
    const list = expiringByClient.get(c.clientId) ?? [];
    list.push(c);
    expiringByClient.set(c.clientId, list);
  }

  // 3. Per-link processing. Errors on one link must never abort the rest.
  for (const link of links) {
    try {
      const clientLabel = clientLabelForTask(link);

      // Trigger A — KYC follow-up
      if (link.kycStatus !== "verified") {
        const kycTriggerKey = buildAdviserTaskTriggerKey({
          taskType: "kyc_followup",
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
        });
        if (
          await hasSuppressionForTriggerKey(
            link.adviserUserId,
            link.clientUserId,
            kycTriggerKey,
          )
        ) {
          summary.idempotencySkips += 1;
        } else {
          // Task #285 — anchor the due date on the per-client signal
          // (kycUpdatedAt + 30d) instead of cron-run + 7d, so a daily
          // batch can no longer produce a column of identical due dates
          // for a backlog of unverified clients. Fall back to
          // cron-run + 7d when the client has no kycUpdatedAt at all
          // (very old rows pre-Task #285).
          const kycAnchor = link.kycUpdatedAt ?? null;
          const dueAt = kycAnchor
            ? new Date(kycAnchor.getTime() + THIRTY_DAYS_MS)
            : new Date(now.getTime() + SEVEN_DAYS_MS);
          await createTask({
            adviserUserId: link.adviserUserId,
            clientUserId: link.clientUserId,
            taskType: "kyc_followup",
            triggerKey: kycTriggerKey,
            title: `Follow up KYC for ${clientLabel}`,
            notes: `Client: ${clientLabel}. KYC status is "${link.kycStatus ?? "unknown"}". Verify outstanding documentation and chase the client to complete identity verification.`,
            priority: "high",
            dueAt,
          });
          summary.kycFollowupsCreated += 1;
        }
      }

      // Trigger B — Fee consent renewal (one task per expiring consent).
      // Task #368 — suppression now keys on the SPECIFIC consent (via
      // triggerKey) so that an adviser who renewed consent #5 (releasing
      // its task) but still has consent #6 expiring will see a fresh task
      // for #6 instead of being silently skipped.
      const expiring = expiringByClient.get(link.clientUserId) ?? [];
      for (const consent of expiring) {
        const consentTriggerKey = buildAdviserTaskTriggerKey({
          taskType: "fee_consent_renewal",
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
          feeConsentId: consent.id,
        });
        if (
          await hasSuppressionForTriggerKey(
            link.adviserUserId,
            link.clientUserId,
            consentTriggerKey,
          )
        ) {
          summary.idempotencySkips += 1;
          continue;
        }
        const daysToExpiry = Math.max(
          0,
          Math.ceil((consent.consentExpiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        );
        await createTask({
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
          taskType: "fee_consent_renewal",
          triggerKey: consentTriggerKey,
          title: `Renew fee consent for ${clientLabel}`,
          notes: `Client: ${clientLabel}. Fee consent #${consent.id} expires in ${daysToExpiry} day(s). Initiate the renewal conversation and re-sign before the expiry to avoid a fee-collection gap.`,
          priority: daysToExpiry <= 7 ? "urgent" : "high",
          dueAt: consent.consentExpiryDate,
        });
        summary.feeConsentRenewalsCreated += 1;
      }

      // Trigger C — Quarterly portfolio review.
      // Task #368 — short-circuit on the per-condition triggerKey so a
      // dismissed (status='cancelled' / status='done' + dismissedByAdviser)
      // task with autoCloseReason still NULL keeps suppressing recreation.
      const reviewTriggerKey = buildAdviserTaskTriggerKey({
        taskType: "portfolio_review",
        adviserUserId: link.adviserUserId,
        clientUserId: link.clientUserId,
      });
      if (
        await hasSuppressionForTriggerKey(
          link.adviserUserId,
          link.clientUserId,
          reviewTriggerKey,
        )
      ) {
        summary.idempotencySkips += 1;
      } else if (await hasRecentPortfolioReview(link.adviserUserId, link.clientUserId, ninetyDaysAgo)) {
        summary.cadenceSkips += 1;
      } else {
        // Task #285 — anchor the due date on the per-client signal:
        // most-recent COMPLETED portfolio_review's `completedAt + 90d`
        // (i.e. quarterly cadence from the last actual review). Falls
        // back to the link `linkedAt + 90d` when no completed review
        // exists yet, then to cron-run + 14d as a final safety net.
        const [lastCompleted] = await db
          .select({ completedAt: adviserTasks.completedAt })
          .from(adviserTasks)
          .where(
            and(
              eq(adviserTasks.adviserUserId, link.adviserUserId),
              eq(adviserTasks.clientUserId, link.clientUserId),
              eq(adviserTasks.taskType, "portfolio_review"),
              eq(adviserTasks.status, "done"),
            ),
          )
          .orderBy(desc(adviserTasks.completedAt))
          .limit(1);
        const reviewAnchor =
          lastCompleted?.completedAt ?? link.linkedAt ?? null;
        const dueAt = reviewAnchor
          ? new Date(reviewAnchor.getTime() + NINETY_DAYS_MS)
          : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        await createTask({
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
          taskType: "portfolio_review",
          triggerKey: reviewTriggerKey,
          title: `Quarterly portfolio review for ${clientLabel}`,
          notes: `Client: ${clientLabel}. It has been at least 90 days since the last portfolio review. Schedule a review meeting and document the discussion.`,
          priority: "normal",
          dueAt,
        });
        summary.portfolioReviewsCreated += 1;
      }
    } catch (err) {
      console.error(
        `[adviser-task-automation] failed for adviserUserId=${link.adviserUserId} clientUserId=${link.clientUserId}`,
        err,
      );
    }
  }

  // Keep the backward-compatible aggregate in sync with the split counters
  // so `summary.skipped` always equals idempotencySkips + cadenceSkips.
  summary.skipped = summary.idempotencySkips + summary.cadenceSkips;
  return summary;
}
