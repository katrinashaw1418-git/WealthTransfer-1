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
} from "@shared/schema";
import { and, eq, gte, lte, inArray, sql } from "drizzle-orm";

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
import { clientDisplayName } from "@shared/display-name";

export function clientLabelForTask(input: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  clientUserId: number;
}): string {
  return clientDisplayName(input, input.clientUserId);
}

// ---------------------------------------------------------------------------
// Has this adviser already got an OPEN or IN_PROGRESS task of `taskType` for
// this client? If so, the cron should not create another.
// ---------------------------------------------------------------------------
async function hasOpenTask(
  adviserUserId: number,
  clientUserId: number,
  taskType: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: adviserTasks.id })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        eq(adviserTasks.clientUserId, clientUserId),
        eq(adviserTasks.taskType, taskType),
        inArray(adviserTasks.status, ["open", "in_progress"]),
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
// ---------------------------------------------------------------------------
async function createTask(input: {
  adviserUserId: number;
  clientUserId: number;
  taskType: string;
  title: string;
  notes: string;
  priority: "low" | "normal" | "high" | "urgent";
  dueAt: Date | null;
}): Promise<void> {
  await db.insert(adviserTasks).values({
    adviserUserId: input.adviserUserId,
    clientUserId: input.clientUserId,
    taskType: input.taskType,
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
  const links = await db
    .select({
      adviserUserId: adviserClients.adviserUserId,
      clientUserId: adviserClients.clientUserId,
      kycStatus: users.kycStatus,
      firstName: users.firstName,
      lastName: users.lastName,
      // Email is part of the label fallback chain (see clientLabelForTask).
      email: users.email,
    })
    .from(adviserClients)
    .innerJoin(users, eq(users.id, adviserClients.clientUserId))
    .where(eq(adviserClients.isActive, true));

  summary.linksScanned = links.length;
  if (links.length === 0) return summary;

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
        if (await hasOpenTask(link.adviserUserId, link.clientUserId, "kyc_followup")) {
          summary.idempotencySkips += 1;
        } else {
          await createTask({
            adviserUserId: link.adviserUserId,
            clientUserId: link.clientUserId,
            taskType: "kyc_followup",
            title: `Follow up KYC for ${clientLabel}`,
            notes: `Client: ${clientLabel}. KYC status is "${link.kycStatus ?? "unknown"}". Verify outstanding documentation and chase the client to complete identity verification.`,
            priority: "high",
            dueAt: new Date(now.getTime() + SEVEN_DAYS_MS),
          });
          summary.kycFollowupsCreated += 1;
        }
      }

      // Trigger B — Fee consent renewal (one task per expiring consent)
      const expiring = expiringByClient.get(link.clientUserId) ?? [];
      for (const consent of expiring) {
        if (await hasOpenTask(link.adviserUserId, link.clientUserId, "fee_consent_renewal")) {
          summary.idempotencySkips += 1;
          break; // one open renewal task per (adviser, client) is enough
        }
        const daysToExpiry = Math.max(
          0,
          Math.ceil((consent.consentExpiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        );
        await createTask({
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
          taskType: "fee_consent_renewal",
          title: `Renew fee consent for ${clientLabel}`,
          notes: `Client: ${clientLabel}. Fee consent #${consent.id} expires in ${daysToExpiry} day(s). Initiate the renewal conversation and re-sign before the expiry to avoid a fee-collection gap.`,
          priority: daysToExpiry <= 7 ? "urgent" : "high",
          dueAt: consent.consentExpiryDate,
        });
        summary.feeConsentRenewalsCreated += 1;
        break; // one task covers all expiring consents for this client
      }

      // Trigger C — Quarterly portfolio review
      if (await hasRecentPortfolioReview(link.adviserUserId, link.clientUserId, ninetyDaysAgo)) {
        summary.cadenceSkips += 1;
      } else {
        await createTask({
          adviserUserId: link.adviserUserId,
          clientUserId: link.clientUserId,
          taskType: "portfolio_review",
          title: `Quarterly portfolio review for ${clientLabel}`,
          notes: `Client: ${clientLabel}. It has been at least 90 days since the last portfolio review. Schedule a review meeting and document the discussion.`,
          priority: "normal",
          dueAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
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
