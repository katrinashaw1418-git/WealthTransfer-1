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
  type AdviserTask,
  type InsertAdviserTask,
  type ReportRequest,
  type InsertReportRequest,
  type InvestmentProduct,
  type InvestmentInstruction,
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
