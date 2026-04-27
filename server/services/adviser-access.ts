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
import { calculatePortfolioTotalsAtDate } from "./portfolio-valuation";
import { clientDisplayName } from "@shared/display-name";
import {
  isTestFixtureEmail,
  matchTestFixtureEmail,
} from "./test-fixture-emails";

// -----------------------------------------------------------------------------
// Test-fixture email filter — defence in depth for adviser surfaces.
//
// Background (Task #286): a handful of fixture-pattern client accounts had
// leaked into `adviser_clients` rows pointed at real advisers, and were
// rendering on every adviser surface that enumerates linked clients (Top
// Clients table, KYC coverage denominator, AUM headline, tier mix, dashboard
// Client book, instructions/tasks/reports lists). The CI gates only block
// fixture leakage at write time; this layer ensures even pre-existing
// contamination can never render to a real adviser.
//
// Behaviour: the filter ONLY fires when the rendering adviser is itself a
// real (non-fixture) user. Test scripts that intentionally create
// fixture-on-fixture adviser-client links keep working unchanged.
//
// One structured warning per dropped (adviser, client) pair per request is
// emitted, naming the matched pattern, so future leakage is investigable
// without log spam (logs only fire when there's actual contamination).
// -----------------------------------------------------------------------------
function logFixtureFiltered(
  adviserUserId: number,
  clientUserId: number,
  email: string,
): void {
  // PII minimisation: log adviser/client ids and the matched-pattern name
  // only. The pattern alone is enough to investigate (it points back to
  // the originating fixture script), and the client id is an internal
  // surrogate — we never write the raw email to the warning channel.
  const result = matchTestFixtureEmail(email);
  const pattern = result.matched ? result.pattern : "unknown";
  console.warn(
    `[adviser-access] filtered fixture client from adviser surface: ` +
      `adviserUserId=${adviserUserId} clientUserId=${clientUserId} ` +
      `pattern=${pattern}`,
  );
}

/**
 * Cheap "is the rendering adviser themselves a fixture?" probe. Only runs
 * when the caller has already established there is at least one fixture
 * client to drop — most real advisers have zero contamination and never
 * trigger this lookup, so the typical request still issues exactly the same
 * SELECTs as before.
 */
async function isAdviserAFixture(adviserUserId: number): Promise<boolean> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, adviserUserId))
    .limit(1);
  return !!row && isTestFixtureEmail(row.email);
}

/**
 * Pre-filter (linkRow|email) tuples for any adviser surface that already
 * has emails in hand (e.g. listAdviserClients). Returns the input unchanged
 * when there are no fixture rows to drop or when the rendering adviser is
 * itself a fixture.
 */
async function filterFixtureClientRows<T extends { userId: number; email: string }>(
  adviserUserId: number,
  rows: T[],
): Promise<T[]> {
  const fixtureRows = rows.filter((r) => isTestFixtureEmail(r.email));
  if (fixtureRows.length === 0) return rows;
  if (await isAdviserAFixture(adviserUserId)) return rows;
  for (const r of fixtureRows) {
    logFixtureFiltered(adviserUserId, r.userId, r.email);
  }
  return rows.filter((r) => !isTestFixtureEmail(r.email));
}

export interface AdviserFixtureFilterContext {
  /** Client IDs the adviser is allowed to see, post-filter. */
  visibleClientIds: number[];
  /** Client IDs that were dropped because they look like test fixtures. */
  excludedClientIds: number[];
  /** True when the adviser themselves is a fixture (filter is a no-op). */
  adviserIsFixture: boolean;
}

/**
 * Compute the visible / excluded linked-client id partition for an adviser.
 * Used by every adviser read path that doesn't already enumerate the join
 * to users.email itself (instructions, tasks, reports, notifications,
 * dashboard summary). Logs one warning per dropped (adviser, client) pair.
 *
 * Cheap when the adviser has no linked clients (one SELECT, returns empty).
 * Cheap when no linked clients are fixture (one SELECT, returns full set).
 */
async function loadAdviserFixtureFilterContext(
  adviserUserId: number,
): Promise<AdviserFixtureFilterContext> {
  const linkedRows = await db
    .select({ id: users.id, email: users.email })
    .from(adviserClients)
    .innerJoin(users, eq(users.id, adviserClients.clientUserId))
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.isActive, true),
      ),
    );

  if (linkedRows.length === 0) {
    return { visibleClientIds: [], excludedClientIds: [], adviserIsFixture: false };
  }

  const fixtureRows = linkedRows.filter((r) => isTestFixtureEmail(r.email));
  if (fixtureRows.length === 0) {
    return {
      visibleClientIds: linkedRows.map((r) => r.id),
      excludedClientIds: [],
      adviserIsFixture: false,
    };
  }

  const adviserIsFixture = await isAdviserAFixture(adviserUserId);
  if (adviserIsFixture) {
    return {
      visibleClientIds: linkedRows.map((r) => r.id),
      excludedClientIds: [],
      adviserIsFixture: true,
    };
  }

  for (const r of fixtureRows) {
    logFixtureFiltered(adviserUserId, r.id, r.email);
  }
  const excludedSet = new Set(fixtureRows.map((r) => r.id));
  return {
    visibleClientIds: linkedRows
      .filter((r) => !excludedSet.has(r.id))
      .map((r) => r.id),
    excludedClientIds: fixtureRows.map((r) => r.id),
    adviserIsFixture: false,
  };
}

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
  const rawLinkRows = await db
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

  if (rawLinkRows.length === 0) return [];

  // Drop fixture-pattern client rows before any downstream aggregation, so
  // the post-filter set drives every count, total and "top N" the UI uses
  // (KYC denominator, AUM, tier mix, fee-consent counts). See Task #286.
  const linkRows = await filterFixtureClientRows(adviserUserId, rawLinkRows);
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

  // Portfolio totals — compute LIVE per client via the same valuation engine
  // the per-client portfolio detail endpoint uses. Reading the
  // `portfolios.totalValue` snapshot column directly would surface "$0" for
  // every client whose snapshot was never refreshed (nothing in the codebase
  // keeps it current), which makes the adviser's "Assets under advice" and
  // "Top portfolios" displays misleading under AFSL.
  //
  // Run valuations in parallel so the list endpoint stays responsive for
  // advisers with many linked clients. If a single client's valuation throws
  // OR returns hasUnpricedWallets (some balances couldn't be priced), fall
  // back to "0" for that one client and log enough detail to diagnose,
  // rather than surfacing a partial total to the adviser or failing the
  // whole list. This matches today's behaviour for clients with no snapshot
  // row at all.
  const now = new Date();
  const valuationResults = await Promise.all(
    clientIds.map(async (clientId) => {
      try {
        const totals = await calculatePortfolioTotalsAtDate(clientId, now);
        if (totals.hasUnpricedWallets) {
          console.error(
            `[adviser-access] live portfolio valuation has unpriced wallets for client ${clientId} (adviser ${adviserUserId}); falling back to 0. unpricedCurrencies=${JSON.stringify(totals.unpricedCurrencies)}`,
          );
          return { clientId, value: "0" };
        }
        return { clientId, value: totals.totalValue.toFixed(2) };
      } catch (err) {
        console.error(
          `[adviser-access] live portfolio valuation failed for client ${clientId} (adviser ${adviserUserId}); falling back to 0:`,
          err,
        );
        return { clientId, value: "0" };
      }
    }),
  );
  const portfolioByClient = new Map(
    valuationResults.map((r) => [r.clientId, r.value]),
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
//
// IMPORTANT: the `portfolios` table row is a stale snapshot — nothing in the
// codebase keeps `portfolios.totalValue` (or the per-bucket fields) refreshed
// after the row is first inserted, so reading it directly would surface "$0"
// or "—" to the adviser even when the client has live wallet balances and
// completed investments. Under AFSL that's a misleading display.
//
// This endpoint therefore computes a LIVE total via the same engine the
// client portfolio page uses (calculatePortfolioTotalsAtDate) and overlays
// the live numbers onto the snapshot shape so the frontend contract is
// preserved. The snapshot row's monthlyPnl / monthlyPnlPercent fields are
// kept as-is — they are out of scope for this read path.
// -----------------------------------------------------------------------------
export async function getAdviserClientPortfolio(
  adviserUserId: number,
  clientUserId: number,
) {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  const [snapshot] = await db
    .select()
    .from(portfolios)
    .where(eq(portfolios.userId, clientUserId))
    .limit(1);
  const walletRows = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, clientUserId));

  const live = await calculatePortfolioTotalsAtDate(clientUserId, new Date());

  // Build the live portfolio object. Reuse snapshot identifiers (id, userId,
  // updatedAt) when present so existing test fixtures and clients that key
  // off them keep working; fall back to a synthetic shape when there's no
  // snapshot row at all.
  const portfolio = {
    id: snapshot?.id ?? null,
    userId: clientUserId,
    totalValue: live.totalValue.toFixed(2),
    fiatValue: live.fiatValue.toFixed(2),
    cryptoValue: live.cryptoValue.toFixed(2),
    stablecoinValue: live.stablecoinValue.toFixed(2),
    investmentValue: live.investmentValue.toFixed(2),
    monthlyPnl: snapshot?.monthlyPnl ?? "0.00",
    monthlyPnlPercent: snapshot?.monthlyPnlPercent ?? "0.00",
    updatedAt: new Date(),
    hasUnpricedWallets: live.hasUnpricedWallets,
    unpricedCurrencies: live.unpricedCurrencies,
  };

  return { portfolio, wallets: walletRows };
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
  const rows = await db
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

  // Drop instructions whose client looks like a test fixture, so the
  // instructions list can never surface fixture-on-real-adviser rows
  // (Task #286). Each row already carries the joined client email.
  const tagged = rows.map((r) => ({
    row: r,
    userId: r.clientUserId,
    email: r.clientEmail,
  }));
  const kept = await filterFixtureClientRows(adviserUserId, tagged);
  return kept.map((k) => k.row);
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

  // Defence in depth (Task #286): a task pinned to a fixture client must
  // not appear on a real adviser's workflow page. Resolve the visible-
  // client whitelist once and constrain the query when there is anything
  // to drop.
  const fixtureCtx = await loadAdviserFixtureFilterContext(adviserUserId);
  if (fixtureCtx.excludedClientIds.length > 0) {
    conditions.push(
      notInArray(adviserTasks.clientUserId, fixtureCtx.excludedClientIds),
    );
  }

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
  // See Task #286: same defence as listAdviserTasks. A report request
  // pinned to a fixture client must not appear in the adviser reports
  // list; constrain the query when the visible-client set excludes any
  // ids.
  const conditions = [eq(reportRequests.adviserUserId, adviserUserId)];
  const fixtureCtx = await loadAdviserFixtureFilterContext(adviserUserId);
  if (fixtureCtx.excludedClientIds.length > 0) {
    conditions.push(
      notInArray(reportRequests.clientUserId, fixtureCtx.excludedClientIds),
    );
  }
  return db
    .select()
    .from(reportRequests)
    .where(and(...conditions))
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
export interface ExpiringFeeConsentDetail {
  feeConsentId: number;
  clientUserId: number;
  clientName: string;
  expiryDate: string; // ISO timestamp
}

export interface AdviserDashboardSummary {
  linkedClients: number;
  openTasks: number;
  feeConsentsExpiringSoon: number; // ≤30 days from now
  pendingReports: number;
  // Task #284 — currently in-force advice records (status issued or
  // accepted) for visible linked clients. The schema's status vocabulary
  // is draft|review_pending|issued|accepted|declined|superseded; "active"
  // in the task spec maps to issued+accepted (i.e. not draft, not retired).
  adviceRecordsActive: number;
  // Task #284 — detail rows for the same 30-day window the count uses,
  // so the UI can render a per-consent renew list without a second call.
  expiringFeeConsentDetail: ExpiringFeeConsentDetail[];
}

export async function getAdviserDashboardSummary(
  adviserUserId: number,
): Promise<AdviserDashboardSummary> {
  // Compute the post-fixture-filter set of linked clients ONCE and use it as
  // the basis for every count below. Without this, the headline "Linked
  // clients" would still include fixture rows the rest of the UI no longer
  // shows, and the "open tasks" / "pending reports" counts could include
  // tasks/reports for fixture clients. See Task #286.
  const fixtureCtx = await loadAdviserFixtureFilterContext(adviserUserId);
  const visibleClientIds = fixtureCtx.visibleClientIds;
  const hasExclusions = fixtureCtx.excludedClientIds.length > 0;

  // Open tasks — scoped to visible clients so a task on a fixture client
  // can never inflate the dashboard counter.
  const taskConditions = [
    eq(adviserTasks.adviserUserId, adviserUserId),
    inArray(adviserTasks.status, ["open", "in_progress"]),
  ];
  if (hasExclusions) {
    taskConditions.push(
      notInArray(adviserTasks.clientUserId, fixtureCtx.excludedClientIds),
    );
  }
  const [{ count: openTasks }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(adviserTasks)
    .where(and(...taskConditions));

  // Fee consents expiring ≤30 days for any of this adviser's visible
  // (post-filter) linked clients. We compute the 30-day window in JS and
  // pass timestamps so the SQL stays portable.
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  let feeConsentsExpiringSoon = 0;
  if (visibleClientIds.length > 0) {
    const [{ count: feeCount }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(feeConsents)
      .where(
        and(
          inArray(feeConsents.clientId, visibleClientIds),
          eq(feeConsents.renewalStatus, "active"),
          lte(feeConsents.consentExpiryDate, in30Days),
          gte(feeConsents.consentExpiryDate, now),
        ),
      );
    feeConsentsExpiringSoon = feeCount;
  }

  // Pending reports — also constrained to visible clients.
  const reportConditions = [
    eq(reportRequests.adviserUserId, adviserUserId),
    inArray(reportRequests.status, ["requested", "generating"]),
  ];
  if (hasExclusions) {
    reportConditions.push(
      notInArray(reportRequests.clientUserId, fixtureCtx.excludedClientIds),
    );
  }
  const [{ count: pendingReports }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(reportRequests)
    .where(and(...reportConditions));

  // Task #284 — count of currently in-force advice records for visible
  // linked clients. issued = SOA delivered; accepted = client accepted.
  let adviceRecordsActive = 0;
  if (visibleClientIds.length > 0) {
    const [{ count: adviceCount }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(adviceRecords)
      .where(
        and(
          inArray(adviceRecords.clientId, visibleClientIds),
          inArray(adviceRecords.status, ["issued", "accepted"]),
        ),
      );
    adviceRecordsActive = adviceCount;
  }

  // Task #284 — per-consent detail for the same 30-day window so the UI
  // can render a renew list. Joined to users for the display label.
  let expiringFeeConsentDetail: ExpiringFeeConsentDetail[] = [];
  if (visibleClientIds.length > 0) {
    const rows = await db
      .select({
        id: feeConsents.id,
        clientId: feeConsents.clientId,
        consentExpiryDate: feeConsents.consentExpiryDate,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(feeConsents)
      .innerJoin(users, eq(users.id, feeConsents.clientId))
      .where(
        and(
          inArray(feeConsents.clientId, visibleClientIds),
          eq(feeConsents.renewalStatus, "active"),
          lte(feeConsents.consentExpiryDate, in30Days),
          gte(feeConsents.consentExpiryDate, now),
        ),
      )
      .orderBy(feeConsents.consentExpiryDate);

    expiringFeeConsentDetail = rows.map((r) => ({
      feeConsentId: r.id,
      clientUserId: r.clientId,
      clientName: clientDisplayName(r, r.clientId),
      expiryDate: (r.consentExpiryDate ?? new Date()).toISOString(),
    }));
  }

  return {
    linkedClients: visibleClientIds.length,
    openTasks,
    feeConsentsExpiringSoon,
    pendingReports,
    adviceRecordsActive,
    expiringFeeConsentDetail,
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

  // Active linked clients only, with test-fixture clients dropped (Task
  // #286). EVERY bucket below is intersected with this set — including
  // buckets that already filter by adviserUserId — so that deactivating
  // a link, or contamination by a fixture-pattern client, immediately
  // removes that client's data from the bell.
  const fixtureCtx = await loadAdviserFixtureFilterContext(adviserUserId);
  const linkedClientIds = fixtureCtx.visibleClientIds;

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
    clientNameById.set(r.id, clientDisplayName(r, r.id));
  }

  const items: AdviserNotificationItem[] = [];

  for (const r of pendingConsentRows) {
    const client = clientNameById.get(r.clientUserId) ?? clientDisplayName({}, r.clientUserId);
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
    const client = clientNameById.get(r.clientUserId) ?? clientDisplayName({}, r.clientUserId);
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
    const client = clientNameById.get(r.clientId) ?? clientDisplayName({}, r.clientId);
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
    const client = clientNameById.get(r.clientUserId) ?? clientDisplayName({}, r.clientUserId);
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
    const name = clientDisplayName(r, r.id);
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
