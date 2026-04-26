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
  investmentProducts,
  userInvestments,
  transactions,
  investmentInstructions,
  executionAuthorisations,
  adviserNotificationDismissals,
  type AdviserTask,
  type InsertAdviserTask,
  type ReportRequest,
  type InsertReportRequest,
  type InvestmentProduct,
  type InvestmentInstruction,
} from "@shared/schema";
import { and, eq, desc, lte, gte, sql, inArray, notInArray } from "drizzle-orm";

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
// SESSION 10A — Investment product shelf (read-only).
//
// AMAX is the product issuer/platform. The investmentProducts table is the
// AMAX-controlled shelf advisers may reference in conversations with clients.
// Advisers cannot CREATE products and they cannot ALLOCATE on behalf of the
// client from this endpoint — this is purely the menu they see.
// -----------------------------------------------------------------------------
export async function listAdviserProducts(): Promise<InvestmentProduct[]> {
  return db
    .select()
    .from(investmentProducts)
    .where(eq(investmentProducts.isActive, true))
    .orderBy(desc(investmentProducts.createdAt));
}

// -----------------------------------------------------------------------------
// SESSION 10A — Client product holdings (read-only).
//
// Returns the client's current allocations across the AMAX product shelf,
// joined to the product record so the UI can show the product name + category
// without a second round trip. Link enforcement runs first.
// -----------------------------------------------------------------------------
export interface AdviserClientHoldingRow {
  id: number;
  productId: number;
  productName: string;
  productCategory: string;
  productSubCategory: string;
  investedAmount: string;
  currentValue: string;
  totalReturn: string;
  returnPercent: string;
  status: string;
  investmentDate: Date | null;
  maturityDate: Date | null;
}

export async function getAdviserClientHoldings(
  adviserUserId: number,
  clientUserId: number,
): Promise<AdviserClientHoldingRow[]> {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  return db
    .select({
      id: userInvestments.id,
      productId: userInvestments.productId,
      productName: investmentProducts.name,
      productCategory: investmentProducts.category,
      productSubCategory: investmentProducts.subCategory,
      investedAmount: userInvestments.investedAmount,
      currentValue: userInvestments.currentValue,
      totalReturn: userInvestments.totalReturn,
      returnPercent: userInvestments.returnPercent,
      status: userInvestments.status,
      investmentDate: userInvestments.investmentDate,
      maturityDate: userInvestments.maturityDate,
    })
    .from(userInvestments)
    .innerJoin(investmentProducts, eq(investmentProducts.id, userInvestments.productId))
    .where(eq(userInvestments.userId, clientUserId))
    .orderBy(desc(userInvestments.investmentDate));
}

// -----------------------------------------------------------------------------
// SESSION 10A.5 — Client transactions (read-only).
//
// Returns the client's transaction history (existing `transactions` table).
// This is the same data the client sees on their own dashboard, exposed to
// linked advisers in read-only form. Link enforcement runs first.
// -----------------------------------------------------------------------------
export interface AdviserClientTransactionRow {
  id: number;
  type: string;
  fromCurrency: string | null;
  toCurrency: string | null;
  amount: string;
  fee: string;
  status: string;
  description: string;
  createdAt: Date | null;
}

export async function getAdviserClientTransactions(
  adviserUserId: number,
  clientUserId: number,
  limit: number = 100,
): Promise<AdviserClientTransactionRow[]> {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  return db
    .select({
      id: transactions.id,
      type: transactions.type,
      fromCurrency: transactions.fromCurrency,
      toCurrency: transactions.toCurrency,
      amount: transactions.amount,
      fee: transactions.fee,
      status: transactions.status,
      description: transactions.description,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.userId, clientUserId))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
}

// -----------------------------------------------------------------------------
// SESSION 10B — Investment instructions (adviser write surface).
//
// Hard rules:
//   - Status defaults to "pending_consent" — adviser cannot bypass.
//   - createAdviserInstruction always validates assertAdviserClientLink before
//     insert (defence in depth).
//   - Product must be active (isActive=true) to be referenced.
//   - The route layer audits every create.
//   - There is NO execution path here — instructions in "consented" state are
//     terminal in this session. Cash movement is a separate later session.
// -----------------------------------------------------------------------------
export interface AdviserInstructionRow extends InvestmentInstruction {
  clientFirstName: string;
  clientLastName: string;
  clientEmail: string;
  productName: string;
  productCategory: string;
}

export async function listAdviserInstructions(
  adviserUserId: number,
): Promise<AdviserInstructionRow[]> {
  return db
    .select({
      id: investmentInstructions.id,
      adviserUserId: investmentInstructions.adviserUserId,
      clientUserId: investmentInstructions.clientUserId,
      productId: investmentInstructions.productId,
      action: investmentInstructions.action,
      amount: investmentInstructions.amount,
      status: investmentInstructions.status,
      adviceRecordId: investmentInstructions.adviceRecordId,
      feeConsentId: investmentInstructions.feeConsentId,
      executionAuthorisationId: investmentInstructions.executionAuthorisationId,
      notes: investmentInstructions.notes,
      rejectionReason: investmentInstructions.rejectionReason,
      consentedAt: investmentInstructions.consentedAt,
      rejectedAt: investmentInstructions.rejectedAt,
      createdAt: investmentInstructions.createdAt,
      updatedAt: investmentInstructions.updatedAt,
      clientFirstName: users.firstName,
      clientLastName: users.lastName,
      clientEmail: users.email,
      productName: investmentProducts.name,
      productCategory: investmentProducts.category,
    })
    .from(investmentInstructions)
    .innerJoin(users, eq(users.id, investmentInstructions.clientUserId))
    .innerJoin(
      investmentProducts,
      eq(investmentProducts.id, investmentInstructions.productId),
    )
    .where(eq(investmentInstructions.adviserUserId, adviserUserId))
    .orderBy(desc(investmentInstructions.createdAt));
}

export interface CreateAdviserInstructionInput {
  clientUserId: number;
  productId: number;
  action: "buy" | "sell" | "switch";
  amount: string; // decimal as string
  notes?: string | null;
  adviceRecordId?: number | null;
  feeConsentId?: number | null;
}

export async function createAdviserInstruction(
  adviserUserId: number,
  input: CreateAdviserInstructionInput,
): Promise<InvestmentInstruction> {
  // Defence in depth: assert link even though the route already requires it.
  await assertAdviserClientLink(adviserUserId, input.clientUserId);

  // Validate the product is on the active AMAX shelf.
  const [product] = await db
    .select({ id: investmentProducts.id, isActive: investmentProducts.isActive })
    .from(investmentProducts)
    .where(eq(investmentProducts.id, input.productId))
    .limit(1);
  if (!product) {
    throw Object.assign(new Error("Product not found"), { status: 404 });
  }
  if (!product.isActive) {
    throw Object.assign(new Error("Product is not active and cannot be referenced"), { status: 400 });
  }

  // If adviceRecordId provided, it must belong to the same client.
  if (input.adviceRecordId != null) {
    const [ar] = await db
      .select({ id: adviceRecords.id, clientId: adviceRecords.clientId })
      .from(adviceRecords)
      .where(eq(adviceRecords.id, input.adviceRecordId))
      .limit(1);
    if (!ar || ar.clientId !== input.clientUserId) {
      throw Object.assign(new Error("Advice record not valid for this client"), { status: 400 });
    }
  }

  // If feeConsentId provided, it must belong to the same client and be active.
  if (input.feeConsentId != null) {
    const [fc] = await db
      .select({ id: feeConsents.id, clientId: feeConsents.clientId, renewalStatus: feeConsents.renewalStatus })
      .from(feeConsents)
      .where(eq(feeConsents.id, input.feeConsentId))
      .limit(1);
    if (!fc || fc.clientId !== input.clientUserId) {
      throw Object.assign(new Error("Fee consent not valid for this client"), { status: 400 });
    }
    if (fc.renewalStatus !== "active") {
      throw Object.assign(new Error("Fee consent is not active"), { status: 400 });
    }
  }

  const [row] = await db
    .insert(investmentInstructions)
    .values({
      adviserUserId,
      clientUserId: input.clientUserId,
      productId: input.productId,
      action: input.action,
      amount: input.amount,
      // Hard-coded — adviser cannot set status; everything starts pending.
      status: "pending_consent",
      adviceRecordId: input.adviceRecordId ?? null,
      feeConsentId: input.feeConsentId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return row;
}

// -----------------------------------------------------------------------------
// SESSION 10B — Client-side instruction reads + state transitions.
//
// These functions are called from the CLIENT route layer (NOT adviser).
// Authorisation: the caller MUST be the client referenced on the instruction.
// State machine:
//   pending_consent -> consented   (client-only)
//   pending_consent -> rejected    (client-only)
//   any other transition -> 400
// No execution side-effect is performed here. "consented" is terminal in this
// session; downstream cash movement is a later session.
// -----------------------------------------------------------------------------
export interface ClientPendingInstructionRow extends InvestmentInstruction {
  productName: string;
  productCategory: string;
  productSubCategory: string;
  adviserFirstName: string | null;
  adviserLastName: string | null;
}

export async function listClientPendingInstructions(
  clientUserId: number,
): Promise<ClientPendingInstructionRow[]> {
  return db
    .select({
      id: investmentInstructions.id,
      adviserUserId: investmentInstructions.adviserUserId,
      clientUserId: investmentInstructions.clientUserId,
      productId: investmentInstructions.productId,
      action: investmentInstructions.action,
      amount: investmentInstructions.amount,
      status: investmentInstructions.status,
      adviceRecordId: investmentInstructions.adviceRecordId,
      feeConsentId: investmentInstructions.feeConsentId,
      executionAuthorisationId: investmentInstructions.executionAuthorisationId,
      notes: investmentInstructions.notes,
      rejectionReason: investmentInstructions.rejectionReason,
      consentedAt: investmentInstructions.consentedAt,
      rejectedAt: investmentInstructions.rejectedAt,
      createdAt: investmentInstructions.createdAt,
      updatedAt: investmentInstructions.updatedAt,
      productName: investmentProducts.name,
      productCategory: investmentProducts.category,
      productSubCategory: investmentProducts.subCategory,
      adviserFirstName: users.firstName,
      adviserLastName: users.lastName,
    })
    .from(investmentInstructions)
    .innerJoin(
      investmentProducts,
      eq(investmentProducts.id, investmentInstructions.productId),
    )
    .leftJoin(users, eq(users.id, investmentInstructions.adviserUserId))
    .where(
      and(
        eq(investmentInstructions.clientUserId, clientUserId),
        eq(investmentInstructions.status, "pending_consent"),
      ),
    )
    .orderBy(desc(investmentInstructions.createdAt));
}

async function loadClientInstruction(
  clientUserId: number,
  instructionId: number,
): Promise<InvestmentInstruction> {
  const [row] = await db
    .select()
    .from(investmentInstructions)
    .where(eq(investmentInstructions.id, instructionId))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Instruction not found"), { status: 404 });
  }
  if (row.clientUserId !== clientUserId) {
    throw Object.assign(new Error("Forbidden — not your instruction"), { status: 403 });
  }
  return row;
}

export async function consentClientInstruction(
  clientUserId: number,
  instructionId: number,
): Promise<InvestmentInstruction> {
  const existing = await loadClientInstruction(clientUserId, instructionId);
  if (existing.status !== "pending_consent") {
    throw Object.assign(
      new Error(`Cannot consent — instruction is in status "${existing.status}"`),
      { status: 400 },
    );
  }
  const now = new Date();
  const [row] = await db
    .update(investmentInstructions)
    .set({ status: "consented", consentedAt: now, updatedAt: now })
    .where(eq(investmentInstructions.id, instructionId))
    .returning();
  return row;
}

export async function rejectClientInstruction(
  clientUserId: number,
  instructionId: number,
  reason?: string | null,
): Promise<InvestmentInstruction> {
  const existing = await loadClientInstruction(clientUserId, instructionId);
  if (existing.status !== "pending_consent") {
    throw Object.assign(
      new Error(`Cannot reject — instruction is in status "${existing.status}"`),
      { status: 400 },
    );
  }
  const now = new Date();
  const [row] = await db
    .update(investmentInstructions)
    .set({
      status: "rejected",
      rejectedAt: now,
      rejectionReason: reason ?? null,
      updatedAt: now,
    })
    .where(eq(investmentInstructions.id, instructionId))
    .returning();
  return row;
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

// =============================================================================
// SESSION 11 — NOTIFICATIONS
// -----------------------------------------------------------------------------
// Single read-only aggregator that powers the adviser-topbar bell icon.
// Composes four counters + a recent-items list from existing tables. No new
// schema, no new mutations. All counts are scoped to the calling adviser via
// adviser_clients (same chokepoint as everything else in this file).
// =============================================================================

export type NotificationType =
  | "consent"
  | "task"
  | "fee_consent"
  | "report"
  | "kyc";

export type NotificationSeverity = "info" | "warning" | "urgent";

export interface AdviserNotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  severity: NotificationSeverity;
  deepLink: string;
  createdAt: string;
}

export interface AdviserNotificationsPayload {
  counts: {
    pendingClientConsents: number;
    openHighUrgentTasks: number;
    feeConsentsExpiring: number;
    pendingReports: number;
    kycPending: number;
  };
  totalCount: number;
  items: AdviserNotificationItem[];
}

const ITEM_LIMIT_PER_BUCKET = 5;
const FEE_EXPIRY_WINDOW_DAYS = 30;

export async function getAdviserNotifications(
  adviserUserId: number,
): Promise<AdviserNotificationsPayload> {
  const now = new Date();
  const expiryHorizon = new Date(now.getTime() + FEE_EXPIRY_WINDOW_DAYS * 86400_000);

  // Active linked clients only. EVERY bucket below is intersected with this
  // set — including buckets that already filter by adviserUserId — so that
  // deactivating a link immediately removes that client's data from the bell.
  // (Architect-flagged scoping rule. Without this intersect, an orphaned row
  // from a former client would still surface here.)
  const linkedClientIdRows = await db
    .select({ clientUserId: adviserClients.clientUserId })
    .from(adviserClients)
    .where(and(eq(adviserClients.adviserUserId, adviserUserId), eq(adviserClients.isActive, true)));
  const linkedClientIds = linkedClientIdRows.map((r) => r.clientUserId);

  // Hard short-circuit: an adviser with zero active links sees nothing,
  // regardless of what orphaned rows exist in the DB.
  if (linkedClientIds.length === 0) {
    return {
      counts: {
        pendingClientConsents: 0,
        openHighUrgentTasks: 0,
        feeConsentsExpiring: 0,
        pendingReports: 0,
        kycPending: 0,
      },
      totalCount: 0,
      items: [],
    };
  }

  // ---- SESSION 15B: dismissals (preference layer; no notifications stored) ----
  // Pre-fetch this adviser's dismissed (sourceType, sourceId) pairs once. Each
  // bucket below excludes its own dismissed source IDs from BOTH the items
  // query AND the count query, so the bell badge and the popover list agree.
  // Dismissals on rows that no longer exist as live source data are harmless:
  // they simply never match anything in the bucket queries.
  const dismissalRows = await db
    .select({
      sourceType: adviserNotificationDismissals.sourceType,
      sourceId: adviserNotificationDismissals.sourceId,
    })
    .from(adviserNotificationDismissals)
    .where(eq(adviserNotificationDismissals.adviserUserId, adviserUserId));
  const dismissedIds = {
    consent: dismissalRows.filter((d) => d.sourceType === "consent").map((d) => d.sourceId),
    task: dismissalRows.filter((d) => d.sourceType === "task").map((d) => d.sourceId),
    fee_consent: dismissalRows.filter((d) => d.sourceType === "fee_consent").map((d) => d.sourceId),
    report: dismissalRows.filter((d) => d.sourceType === "report").map((d) => d.sourceId),
    kyc: dismissalRows.filter((d) => d.sourceType === "kyc").map((d) => d.sourceId),
  };
  // Helper: only emit `notInArray(...)` when the dismissed-IDs list is non-empty.
  // Postgres `NOT IN ()` would be a syntax error and Drizzle's notInArray on []
  // is undefined behaviour — this guard keeps the existing queries unchanged
  // when no dismissals exist.
  const exclude = (col: any, ids: number[]) => (ids.length ? notInArray(col, ids) : undefined);

  // ---- 1. Pending client consents (instructions awaiting client action) ----
  const pendingConsentRows = await db
    .select({
      id: investmentInstructions.id,
      clientUserId: investmentInstructions.clientUserId,
      productId: investmentInstructions.productId,
      action: investmentInstructions.action,
      amount: investmentInstructions.amount,
      createdAt: investmentInstructions.createdAt,
    })
    .from(investmentInstructions)
    .where(
      and(
        eq(investmentInstructions.adviserUserId, adviserUserId),
        inArray(investmentInstructions.clientUserId, linkedClientIds),
        eq(investmentInstructions.status, "pending_consent"),
        exclude(investmentInstructions.id, dismissedIds.consent),
      ),
    )
    .orderBy(desc(investmentInstructions.createdAt))
    .limit(ITEM_LIMIT_PER_BUCKET);

  const [{ count: pendingClientConsentsCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(investmentInstructions)
    .where(
      and(
        eq(investmentInstructions.adviserUserId, adviserUserId),
        inArray(investmentInstructions.clientUserId, linkedClientIds),
        eq(investmentInstructions.status, "pending_consent"),
        exclude(investmentInstructions.id, dismissedIds.consent),
      ),
    );

  // ---- 2. Open high/urgent tasks ----
  const taskRows = await db
    .select({
      id: adviserTasks.id,
      clientUserId: adviserTasks.clientUserId,
      title: adviserTasks.title,
      priority: adviserTasks.priority,
      taskType: adviserTasks.taskType,
      dueAt: adviserTasks.dueAt,
      createdAt: adviserTasks.createdAt,
    })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        inArray(adviserTasks.clientUserId, linkedClientIds),
        eq(adviserTasks.status, "open"),
        inArray(adviserTasks.priority, ["high", "urgent"]),
        exclude(adviserTasks.id, dismissedIds.task),
      ),
    )
    .orderBy(desc(adviserTasks.createdAt))
    .limit(ITEM_LIMIT_PER_BUCKET);

  const [{ count: openHighUrgentTasksCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(adviserTasks)
    .where(
      and(
        eq(adviserTasks.adviserUserId, adviserUserId),
        inArray(adviserTasks.clientUserId, linkedClientIds),
        eq(adviserTasks.status, "open"),
        inArray(adviserTasks.priority, ["high", "urgent"]),
        exclude(adviserTasks.id, dismissedIds.task),
      ),
    );

  // ---- 3. Fee consents expiring within 30 days (active only) ----
  const feeRows = await db
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
        lte(feeConsents.consentExpiryDate, expiryHorizon),
        gte(feeConsents.consentExpiryDate, now),
        exclude(feeConsents.id, dismissedIds.fee_consent),
      ),
    )
    .orderBy(feeConsents.consentExpiryDate)
    .limit(ITEM_LIMIT_PER_BUCKET);

  const [{ count: feeConsentsExpiringCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(feeConsents)
    .where(
      and(
        inArray(feeConsents.clientId, linkedClientIds),
        eq(feeConsents.renewalStatus, "active"),
        lte(feeConsents.consentExpiryDate, expiryHorizon),
        gte(feeConsents.consentExpiryDate, now),
        exclude(feeConsents.id, dismissedIds.fee_consent),
      ),
    );

  // ---- 4. Pending reports (requested or generating) ----
  const reportRows = await db
    .select({
      id: reportRequests.id,
      clientUserId: reportRequests.clientUserId,
      reportType: reportRequests.reportType,
      status: reportRequests.status,
      requestedAt: reportRequests.requestedAt,
    })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.adviserUserId, adviserUserId),
        inArray(reportRequests.clientUserId, linkedClientIds),
        inArray(reportRequests.status, ["requested", "generating"]),
        exclude(reportRequests.id, dismissedIds.report),
      ),
    )
    .orderBy(desc(reportRequests.requestedAt))
    .limit(ITEM_LIMIT_PER_BUCKET);

  const [{ count: pendingReportsCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(reportRequests)
    .where(
      and(
        eq(reportRequests.adviserUserId, adviserUserId),
        inArray(reportRequests.clientUserId, linkedClientIds),
        inArray(reportRequests.status, ["requested", "generating"]),
        exclude(reportRequests.id, dismissedIds.report),
      ),
    );

  // ---- 5. KYC pending (linked clients with kycStatus != 'verified') ----
  // Note: KYC dismissals reference users.id (the client's user ID), not a
  // dedicated notification id. Item ids are emitted as `kyc:<userId>`.
  const kycRows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, linkedClientIds),
        eq(users.kycStatus, "pending"),
        exclude(users.id, dismissedIds.kyc),
      ),
    )
    .limit(ITEM_LIMIT_PER_BUCKET);

  const [{ count: kycPendingCount }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(users)
    .where(
      and(
        inArray(users.id, linkedClientIds),
        eq(users.kycStatus, "pending"),
        exclude(users.id, dismissedIds.kyc),
      ),
    );

  // ---- Resolve client display names for items in one shot ----
  const referencedClientIds = Array.from(
    new Set([
      ...pendingConsentRows.map((r) => r.clientUserId),
      ...taskRows.map((r) => r.clientUserId),
      ...feeRows.map((r) => r.clientId),
      ...reportRows.map((r) => r.clientUserId),
    ]),
  );
  const clientNameRows =
    referencedClientIds.length > 0
      ? await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, referencedClientIds))
      : [];
  const clientNameById = new Map<number, string>();
  for (const r of clientNameRows) {
    const name =
      [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email || `Client #${r.id}`;
    clientNameById.set(r.id, name);
  }

  const items: AdviserNotificationItem[] = [];

  for (const r of pendingConsentRows) {
    const client = clientNameById.get(r.clientUserId) ?? `Client #${r.clientUserId}`;
    items.push({
      id: `consent:${r.id}`,
      type: "consent",
      title: "Client consent required",
      description: `${client} — ${r.action} instruction for ${formatAud(r.amount)} awaiting consent.`,
      severity: "warning",
      deepLink: "/adviser/instructions",
      createdAt: (r.createdAt ?? new Date()).toISOString(),
    });
  }

  for (const r of taskRows) {
    const client = clientNameById.get(r.clientUserId) ?? `Client #${r.clientUserId}`;
    items.push({
      id: `task:${r.id}`,
      type: "task",
      title: r.title,
      description: `${client} — ${r.priority} priority ${r.taskType.replace(/_/g, " ")}.`,
      severity: r.priority === "urgent" ? "urgent" : "warning",
      deepLink: "/adviser/workflow",
      createdAt: (r.createdAt ?? new Date()).toISOString(),
    });
  }

  for (const r of feeRows) {
    const client = clientNameById.get(r.clientId) ?? `Client #${r.clientId}`;
    const daysToExpiry = Math.max(
      0,
      Math.ceil((r.consentExpiryDate.getTime() - now.getTime()) / 86400_000),
    );
    items.push({
      id: `fee_consent:${r.id}`,
      type: "fee_consent",
      title: "Fee consent expiring",
      description: `${client} — fee consent expires in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}.`,
      severity: daysToExpiry <= 7 ? "urgent" : "warning",
      deepLink: `/adviser/clients/${r.clientId}`,
      createdAt: r.consentExpiryDate.toISOString(),
    });
  }

  for (const r of reportRows) {
    const client = clientNameById.get(r.clientUserId) ?? `Client #${r.clientUserId}`;
    items.push({
      id: `report:${r.id}`,
      type: "report",
      title: r.status === "generating" ? "Report generating" : "Report requested",
      description: `${client} — ${r.reportType.replace(/_/g, " ")}.`,
      severity: "info",
      deepLink: "/adviser/reports",
      createdAt: (r.requestedAt ?? new Date()).toISOString(),
    });
  }

  for (const r of kycRows) {
    const name =
      [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email || `Client #${r.id}`;
    items.push({
      id: `kyc:${r.id}`,
      type: "kyc",
      title: "KYC pending",
      description: `${name} — KYC verification not yet complete.`,
      severity: "warning",
      deepLink: `/adviser/clients/${r.id}`,
      createdAt: new Date().toISOString(),
    });
  }

  // Sort items: urgent → warning → info, then most recent first within group.
  const severityRank: Record<NotificationSeverity, number> = { urgent: 0, warning: 1, info: 2 };
  items.sort((a, b) => {
    const s = severityRank[a.severity] - severityRank[b.severity];
    if (s !== 0) return s;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const totalCount =
    pendingClientConsentsCount +
    openHighUrgentTasksCount +
    feeConsentsExpiringCount +
    pendingReportsCount +
    kycPendingCount;

  return {
    counts: {
      pendingClientConsents: pendingClientConsentsCount,
      openHighUrgentTasks: openHighUrgentTasksCount,
      feeConsentsExpiring: feeConsentsExpiringCount,
      pendingReports: pendingReportsCount,
      kycPending: kycPendingCount,
    },
    totalCount,
    items,
  };
}

function formatAud(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}
