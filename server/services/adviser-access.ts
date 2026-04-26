// =============================================================================
// SESSION 9 — ADVISER-SCOPED DATA ACCESS
// -----------------------------------------------------------------------------
// All read/write paths used by the /api/adviser/* routes live here. Keeping
// them in one file makes the security review trivial: every adviser-facing DB
// touch is in this module, and every cross-user read goes through
// `assertAdviserClientLink` first.
//
// Hard rules (enforced here, not just in the routes):
//   - No method in this file mutates wallets, transactions, ledger entries,
//     KYC status, advice records, fee consents, execution authorisations,
//     or any other client-owned state. Read-only into client data.
//   - Every method that takes (adviserUserId, clientUserId) calls
//     assertAdviserClientLink BEFORE returning client-owned data.
//   - The only writes are to the adviser's OWN tables (adviser_tasks,
//     report_requests) — and those still validate the link before insert.
// =============================================================================

import { db } from "../db";
import {
  users,
  adviserClients,
  adviserTasks,
  reportRequests,
  feeConsents,
  adviceRecords,
  portfolios,
  wallets,
  type AdviserTask,
  type InsertAdviserTask,
  type ReportRequest,
  type InsertReportRequest,
} from "@shared/schema";
import { and, eq, desc, lte, gte, sql, inArray } from "drizzle-orm";

// -----------------------------------------------------------------------------
// Link enforcement — the single chokepoint for "can this adviser see this
// client?". Every cross-user read in this file calls this first.
// -----------------------------------------------------------------------------
export async function assertAdviserClientLink(
  adviserUserId: number,
  clientUserId: number,
): Promise<void> {
  const [link] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
        eq(adviserClients.isActive, true),
      ),
    )
    .limit(1);
  if (!link) {
    throw Object.assign(
      new Error("Forbidden — you are not linked to this client"),
      { status: 403 },
    );
  }
}

// -----------------------------------------------------------------------------
// Client list — joins adviser_clients to users and aggregates summary fields
// (active fee consent count, portfolio total) in a single round trip.
//
// CHOKEPOINT NOTE: this function does NOT call assertAdviserClientLink and
// must not. It is an *enumeration* query — "show me the links that exist
// for THIS adviser". The WHERE clause is itself the link enforcement
// (adviser_clients.adviser_user_id = adviserUserId AND is_active = true),
// and every aggregate downstream (feeConsents, portfolios) is constrained
// to the resulting `clientIds`. There is no per-client lookup to gate;
// adding a redundant assertAdviserClientLink call would have nothing to
// validate against because the link IS the result set.
// -----------------------------------------------------------------------------
export interface AdviserClientSummary {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
  userTier: string;
  linkedAt: Date | null;
  relationshipType: string;
  activeFeeConsents: number;
  portfolioValueAud: string; // decimal as string (preserves precision)
}

export async function listAdviserClients(
  adviserUserId: number,
): Promise<AdviserClientSummary[]> {
  // Pull links + user records in one query.
  const linkRows = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      kycStatus: users.kycStatus,
      userTier: users.userTier,
      linkedAt: adviserClients.linkedAt,
      relationshipType: adviserClients.relationshipType,
    })
    .from(adviserClients)
    .innerJoin(users, eq(users.id, adviserClients.clientUserId))
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.isActive, true),
      ),
    );

  if (linkRows.length === 0) return [];

  const clientIds = linkRows.map((r) => r.userId);

  // Active-fee-consent counts grouped by client.
  const feeRows = await db
    .select({
      clientId: feeConsents.clientId,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(feeConsents)
    .where(
      and(
        inArray(feeConsents.clientId, clientIds),
        eq(feeConsents.renewalStatus, "active"),
      ),
    )
    .groupBy(feeConsents.clientId);
  const feeByClient = new Map(feeRows.map((r) => [r.clientId, r.count]));

  // Portfolio totals (single query, all clients).
  const portfolioRows = await db
    .select({
      userId: portfolios.userId,
      totalValue: portfolios.totalValue,
    })
    .from(portfolios)
    .where(inArray(portfolios.userId, clientIds));
  const portfolioByClient = new Map(
    portfolioRows.map((r) => [r.userId, r.totalValue ?? "0"]),
  );

  return linkRows.map((r) => ({
    ...r,
    activeFeeConsents: feeByClient.get(r.userId) ?? 0,
    portfolioValueAud: portfolioByClient.get(r.userId) ?? "0",
  }));
}

// -----------------------------------------------------------------------------
// Single client detail — assertLink + return user record (selected fields
// only; no password/OTP/audit columns leak through).
// -----------------------------------------------------------------------------
export async function getAdviserClientDetail(
  adviserUserId: number,
  clientUserId: number,
) {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  const [client] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      kycStatus: users.kycStatus,
      userTier: users.userTier,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, clientUserId))
    .limit(1);
  return client ?? null;
}

// -----------------------------------------------------------------------------
// Client portfolio — read-only summary (portfolio row + wallet list).
// -----------------------------------------------------------------------------
export async function getAdviserClientPortfolio(
  adviserUserId: number,
  clientUserId: number,
) {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  const [portfolio] = await db
    .select()
    .from(portfolios)
    .where(eq(portfolios.userId, clientUserId))
    .limit(1);
  const walletRows = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, clientUserId));
  return { portfolio: portfolio ?? null, wallets: walletRows };
}

// -----------------------------------------------------------------------------
// Client fee consents — read-only.
// -----------------------------------------------------------------------------
export async function getAdviserClientFeeConsents(
  adviserUserId: number,
  clientUserId: number,
) {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  return db
    .select()
    .from(feeConsents)
    .where(eq(feeConsents.clientId, clientUserId))
    .orderBy(desc(feeConsents.createdAt));
}

// -----------------------------------------------------------------------------
// Client advice records — read-only metadata only (no payload mutation).
// -----------------------------------------------------------------------------
export async function getAdviserClientAdviceRecords(
  adviserUserId: number,
  clientUserId: number,
) {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  return db
    .select({
      id: adviceRecords.id,
      adviceType: adviceRecords.adviceType,
      status: adviceRecords.status,
      createdAt: adviceRecords.createdAt,
    })
    .from(adviceRecords)
    .where(eq(adviceRecords.clientId, clientUserId))
    .orderBy(desc(adviceRecords.createdAt))
    .limit(50);
}

// -----------------------------------------------------------------------------
// Adviser tasks — adviser-owned writes; client linkage validated on insert.
// -----------------------------------------------------------------------------
export async function listAdviserTasks(
  adviserUserId: number,
  filters?: { status?: string; clientUserId?: number },
): Promise<AdviserTask[]> {
  const conditions = [eq(adviserTasks.adviserUserId, adviserUserId)];
  if (filters?.status) conditions.push(eq(adviserTasks.status, filters.status));
  if (filters?.clientUserId)
    conditions.push(eq(adviserTasks.clientUserId, filters.clientUserId));
  return db
    .select()
    .from(adviserTasks)
    .where(and(...conditions))
    .orderBy(desc(adviserTasks.createdAt));
}

export async function createAdviserTask(
  adviserUserId: number,
  input: Omit<InsertAdviserTask, "adviserUserId">,
): Promise<AdviserTask> {
  // Defence in depth: even though the route validates the link, re-check here.
  await assertAdviserClientLink(adviserUserId, input.clientUserId);
  const [row] = await db
    .insert(adviserTasks)
    .values({ ...input, adviserUserId })
    .returning();
  return row;
}

export async function updateAdviserTask(
  adviserUserId: number,
  taskId: number,
  patch: Partial<Pick<AdviserTask, "title" | "notes" | "status" | "priority" | "dueAt" | "completedAt">>,
): Promise<AdviserTask | null> {
  // Adviser may only update their OWN tasks.
  const [existing] = await db
    .select()
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.id, taskId),
        eq(adviserTasks.adviserUserId, adviserUserId),
      ),
    )
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { ...patch, updatedAt: new Date() };
  // Auto-stamp completedAt when transitioning to "done".
  if (patch.status === "done" && !existing.completedAt) {
    update.completedAt = new Date();
  }

  const [row] = await db
    .update(adviserTasks)
    .set(update)
    .where(eq(adviserTasks.id, taskId))
    .returning();
  return row ?? null;
}

// -----------------------------------------------------------------------------
// Report requests — adviser-owned writes; client linkage validated on insert.
// -----------------------------------------------------------------------------
export async function listAdviserReportRequests(
  adviserUserId: number,
): Promise<ReportRequest[]> {
  return db
    .select()
    .from(reportRequests)
    .where(eq(reportRequests.adviserUserId, adviserUserId))
    .orderBy(desc(reportRequests.requestedAt));
}

export async function createReportRequest(
  adviserUserId: number,
  input: Omit<InsertReportRequest, "adviserUserId">,
): Promise<ReportRequest> {
  await assertAdviserClientLink(adviserUserId, input.clientUserId);
  const [row] = await db
    .insert(reportRequests)
    .values({ ...input, adviserUserId })
    .returning();
  return row;
}

// -----------------------------------------------------------------------------
// Dashboard summary — single round-trip aggregate for the landing page.
//
// CHOKEPOINT NOTE: same reasoning as listAdviserClients. Every count below is
// scoped by `adviser_user_id = adviserUserId` (or, for fee-consent counts,
// constrained to the explicit list of *this* adviser's linked clients via
// linkedClientIds). There is no individual-client read that would benefit
// from assertAdviserClientLink.
// -----------------------------------------------------------------------------
export interface AdviserDashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number; // ≤30 days from now
  pendingReports: number;
}

export async function getAdviserDashboardSummary(
  adviserUserId: number,
): Promise<AdviserDashboardSummary> {
  // Linked clients
  const [{ count: clientCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.isActive, true),
      ),
    );

  // Open tasks
  const [{ count: openTasks }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        inArray(adviserTasks.status, ["open", "in_progress"]),
      ),
    );

  // Fee consents expiring ≤30 days for any of this adviser's linked clients.
  // We compute the 30-day window in JS and pass timestamps so the SQL stays
  // portable.
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const linkedClientIdRows = await db
    .select({ clientUserId: adviserClients.clientUserId })
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.isActive, true),
      ),
    );
  let feeConsentsExpiringSoon = 0;
  if (linkedClientIdRows.length > 0) {
    const linkedClientIds = linkedClientIdRows.map((r) => r.clientUserId);
    const [{ count: feeCount }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(feeConsents)
      .where(
        and(
          inArray(feeConsents.clientId, linkedClientIds),
          eq(feeConsents.renewalStatus, "active"),
          lte(feeConsents.consentExpiryDate, in30Days),
          gte(feeConsents.consentExpiryDate, now),
        ),
      );
    feeConsentsExpiringSoon = feeCount;
  }

  // Pending reports
  const [{ count: pendingReports }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.adviserUserId, adviserUserId),
        inArray(reportRequests.status, ["requested", "generating"]),
      ),
    );

  return {
    linkedClients: clientCount,
    openTasks,
    feeConsentsExpiringSoon,
    pendingReports,
  };
}
