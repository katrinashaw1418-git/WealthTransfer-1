import { pgTable, text, serial, integer, boolean, decimal, timestamp, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  kycStatus: text("kyc_status").notNull().default("pending"), // pending, verified, rejected
  userTier: text("user_tier").notNull().default("standard"), // standard, premium, hnwi
  // Session 3 — Phase 1: role-based access for B2B adviser overlay.
  // "client" (default) = retail/wholesale account holder; "adviser" = authorised rep linked to clients via adviserClients.
  role: text("role").notNull().default("client"),
  // Email verification — set on signup; required before login is allowed
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationTokenExpiry: timestamp("email_verification_token_expiry"),
  emailOtp: text("email_otp"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const portfolios = pgTable("portfolios", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  totalValue: decimal("total_value", { precision: 15, scale: 2 }).notNull(),
  cryptoValue: decimal("crypto_value", { precision: 15, scale: 2 }).notNull(),
  stablecoinValue: decimal("stablecoin_value", { precision: 15, scale: 2 }).default("0.00"),
  fiatValue: decimal("fiat_value", { precision: 15, scale: 2 }).notNull(),
  investmentValue: decimal("investment_value", { precision: 15, scale: 2 }).default("0.00"),
  monthlyPnl: decimal("monthly_pnl", { precision: 15, scale: 2 }).notNull(),
  monthlyPnlPercent: decimal("monthly_pnl_percent", { precision: 5, scale: 2 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  totalValue: decimal("total_value", { precision: 15, scale: 2 }).notNull(),
  cryptoValue: decimal("crypto_value", { precision: 15, scale: 2 }).notNull(),
  stablecoinValue: decimal("stablecoin_value", { precision: 15, scale: 2 }).notNull(),
  fiatValue: decimal("fiat_value", { precision: 15, scale: 2 }).notNull(),
  investmentValue: decimal("investment_value", { precision: 15, scale: 2 }).notNull(),
  snapshotDate: timestamp("snapshot_date").notNull(),
  source: text("source").notNull().default("actual"), // "actual" | "historical_estimate"
  createdAt: timestamp("created_at").defaultNow(),
});

export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  currency: text("currency").notNull(), // USD, CAD, EUR, GBP, CNY, BTC, ETH
  balance: decimal("balance", { precision: 15, scale: 8 }).notNull(),
  availableBalance: decimal("available_balance", { precision: 15, scale: 8 }).notNull(),
  walletType: text("wallet_type").notNull(), // fiat, crypto
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  // One wallet per user per currency — enforced at DB level
  userCurrencyIdx: uniqueIndex("wallets_user_currency_uidx").on(table.userId, table.currency),
  // Non-negative balance safety rails
  balanceNonNeg: check("wallets_balance_non_negative", sql`${table.balance} >= 0`),
  availableBalanceNonNeg: check("wallets_available_balance_non_negative", sql`${table.availableBalance} >= 0`),
}));

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  type: text("type").notNull(), // deposit, withdrawal, exchange, transfer, crypto_buy, crypto_sell
  fromCurrency: text("from_currency"),
  toCurrency: text("to_currency"),
  amount: decimal("amount", { precision: 15, scale: 8 }).notNull(),
  fee: decimal("fee", { precision: 15, scale: 8 }).notNull(),
  exchangeRate: decimal("exchange_rate", { precision: 15, scale: 8 }),
  // Legacy status vocabulary (pending|completed|failed|cancelled) is preserved for existing
  // wallet routes. New ledger-aware money-movement code paths use the Track B state machine
  // (pending → processing → settled → failed → reversed) — see server/services/transaction-state.ts.
  status: text("status").notNull(),
  // Explicit labeling — prevents UI/regulator confusion. "internal_only" = no external settlement.
  settlementStatus: text("settlement_status").notNull().default("internal_only"),
  description: text("description").notNull(),
  sourceExchange: text("source_exchange"), // binance, coinbase, etc.
  blockchainTxHash: text("blockchain_tx_hash"), // transaction hash for blockchain transfers
  createdAt: timestamp("created_at").defaultNow(),

  // --- Track B (Session 7): production-safety fields ---
  // Per-transaction idempotency key supplied by the client (or webhook). UNIQUE so duplicate
  // submissions return the original transaction instead of creating a second one. Distinct from
  // the per-user/per-route `idempotencyKeys` table below — that one is route-level dedup, this
  // is transaction-level dedup that survives even if the request hits a different route.
  idempotencyKey: text("idempotency_key").unique(),
  // External partner / custodian reference — populated when funds are confirmed by the partner.
  externalRef: text("external_ref"),
  externalProvider: text("external_provider"),
  externalStatus: text("external_status"),
  failureReason: text("failure_reason"),
  // Lifecycle timestamps for the Track B state machine. Each one is set when the corresponding
  // state transition occurs and is never updated afterwards (audit-safe).
  settledAt: timestamp("settled_at"),
  failedAt: timestamp("failed_at"),
  reversedAt: timestamp("reversed_at"),
  // Free-form structured metadata for audit/diagnostics — settlement model, partner correlation
  // ids, retry counts, etc. NEVER store balances or money amounts here — those go in ledger_entries.
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const fxRates = pgTable("fx_rates", {
  id: serial("id").primaryKey(),
  baseCurrency: text("base_currency").notNull(),
  targetCurrency: text("target_currency").notNull(),
  rate: decimal("rate", { precision: 15, scale: 8 }).notNull(),
  spread: decimal("spread", { precision: 5, scale: 4 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const aiRecommendations = pgTable("ai_recommendations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  type: text("type").notNull(), // rebalancing, opportunity, risk_warning
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull(), // info, warning, alert
  isRead: boolean("is_read").default(false),
  // Session 3 — Phase 1: marks a recommendation as replaced by a newer generation.
  // Set to true by supersedeAiRecommendations() before inserting fresh rows so the
  // active recommendation set is always (isSuperseded = false).
  isSuperseded: boolean("is_superseded").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const investmentProducts = pgTable("investment_products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // real_estate, corporate_credit, venture_capital
  subCategory: text("sub_category").notNull(), // equity_fund, credit_fund, first_mortgage, etc.
  investmentStrategy: text("investment_strategy").notNull(),
  targetNetIrr: text("target_net_irr").notNull(),
  grossIrr: text("gross_irr"),
  moic: text("moic"), // Multiple of Invested Capital
  term: text("term").notNull(),
  structure: text("structure").notNull(),
  distributions: text("distributions").notNull(),
  liquidity: text("liquidity").notNull(),
  minimumInvestment: decimal("minimum_investment", { precision: 15, scale: 2 }).notNull(),
  riskProfile: text("risk_profile").notNull(), // conservative, moderate, high
  returnType: text("return_type").notNull(), // income, capital_gains, blended
  lvr: text("lvr"), // Loan-to-Value Ratio
  annualReturn: decimal("annual_return", { precision: 10, scale: 4 }), // explicit rate e.g. 0.1100 = 11%
  returnMethod: text("return_method").notNull().default("fixed_annual_compound"), // fixed_annual_compound | fixed_annual_simple
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userInvestments = pgTable("user_investments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  productId: integer("product_id").references(() => investmentProducts.id).notNull(),
  investedAmount: decimal("invested_amount", { precision: 15, scale: 2 }).notNull(),
  currentValue: decimal("current_value", { precision: 15, scale: 2 }).notNull(),
  totalReturn: decimal("total_return", { precision: 15, scale: 2 }).notNull(),
  returnPercent: decimal("return_percent", { precision: 5, scale: 2 }).notNull(),
  status: text("status").notNull().default("active"), // active, matured, withdrawn
  investmentDate: timestamp("investment_date").defaultNow(),
  maturityDate: timestamp("maturity_date"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id).notNull(),
    route: text("route").notNull(),
    key: text("key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    responseJson: jsonb("response_json").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    uniqUserRouteKey: uniqueIndex("idempotency_user_route_key_idx").on(
      table.userId,
      table.route,
      table.key
    ),
  })
);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertPortfolioSchema = createInsertSchema(portfolios).omit({
  id: true,
  updatedAt: true,
});

export const insertWalletSchema = createInsertSchema(wallets).omit({
  id: true,
  updatedAt: true,
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
  createdAt: true,
});

export const insertFxRateSchema = createInsertSchema(fxRates).omit({
  id: true,
  updatedAt: true,
});

export const insertAiRecommendationSchema = createInsertSchema(aiRecommendations).omit({
  id: true,
  createdAt: true,
});

export const insertInvestmentProductSchema = createInsertSchema(investmentProducts).omit({
  id: true,
  createdAt: true,
});

export const insertUserInvestmentSchema = createInsertSchema(userInvestments).omit({
  id: true,
  investmentDate: true,
  updatedAt: true,
});

export const insertPortfolioSnapshotSchema = createInsertSchema(portfolioSnapshots).omit({
  id: true,
  createdAt: true,
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Portfolio = typeof portfolios.$inferSelect;
export type InsertPortfolio = z.infer<typeof insertPortfolioSchema>;
export type Wallet = typeof wallets.$inferSelect;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Transaction = typeof transactions.$inferSelect;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type FxRate = typeof fxRates.$inferSelect;
export type InsertFxRate = z.infer<typeof insertFxRateSchema>;
export type AiRecommendation = typeof aiRecommendations.$inferSelect;
export type InsertAiRecommendation = z.infer<typeof insertAiRecommendationSchema>;
export type InvestmentProduct = typeof investmentProducts.$inferSelect;
export type InsertInvestmentProduct = z.infer<typeof insertInvestmentProductSchema>;
export type UserInvestment = typeof userInvestments.$inferSelect;
export type InsertUserInvestment = z.infer<typeof insertUserInvestmentSchema>;
export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = z.infer<typeof insertPortfolioSnapshotSchema>;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

// Password reset tokens — ephemeral, expire after 1 hour, single-use
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  country: text("country").notNull(),
  accountType: text("account_type").notNull(),
  entityName: text("entity_name"),
  abn: text("abn"),
  intendedUse: text("intended_use").notNull(),
  consentOwnBehalf: boolean("consent_own_behalf").notNull().default(false),
  consentAmlCtf: boolean("consent_aml_ctf").notNull().default(false),
  consentContact: boolean("consent_contact").notNull().default(false),
  // ASIC general-advice disclaimer acknowledgement — collected on the apply page
  // so we have an attested record that the user understands this is not personal advice.
  consentGeneralAdvice: boolean("consent_general_advice").notNull().default(false),
  // status: email_unverified → submitted → under_review → approved | rejected
  status: text("status").notNull().default("email_unverified"),
  reviewNote: text("review_note"),
  // Email verification at the application step (before review/approval)
  emailVerified: boolean("email_verified").notNull().default(false),
  // Stores SHA-256 hash of the 6-digit OTP, never the plaintext code.
  emailOtp: text("email_otp"),
  emailOtpExpiry: timestamp("email_otp_expiry"),
  // Per-application failed-attempt counter. Locked at 5; user must request a new code.
  emailOtpAttempts: integer("email_otp_attempts").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
});

export const insertApplicationSchema = createInsertSchema(applications).omit({ id: true, createdAt: true, reviewedAt: true });
export type Application = typeof applications.$inferSelect;
export type InsertApplication = z.infer<typeof insertApplicationSchema>;

// Leads — captured from the public Flow A wizard before account creation.
// Stores wizard answers + recommendation snapshot + email capture.
export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  profileType: text("profile_type").notNull(),       // individual | family_office | corporate | international
  goals: text("goals").array().notNull(),            // multi-select
  riskTolerance: text("risk_tolerance").notNull(),   // conservative | balanced | growth | high_growth
  timeHorizon: text("time_horizon").notNull(),       // short | medium | long
  capitalRange: text("capital_range").notNull(),     // under_10k | 10k_100k | 100k_500k | 500k_plus
  recommendedStrategy: text("recommended_strategy").notNull(),
  privateAccess: boolean("private_access").notNull().default(false),
  source: text("source").notNull().default("flow_a"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leads).omit({ id: true, createdAt: true, updatedAt: true });
export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;

// Funnel events — minimal product analytics for Flow A → /apply conversion.
// One row per discrete user action. No PII beyond optional email hash; the
// session_id is a client-generated random id stored in sessionStorage.
export const funnelEvents = pgTable("funnel_events", {
  id: serial("id").primaryKey(),
  event: text("event").notNull(),
  sessionId: text("session_id").notNull(),
  path: text("path"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  eventIdx: index("funnel_events_event_idx").on(t.event),
  sessionIdx: index("funnel_events_session_idx").on(t.sessionId),
  createdIdx: index("funnel_events_created_idx").on(t.createdAt),
}));

export const insertFunnelEventSchema = createInsertSchema(funnelEvents).omit({ id: true, createdAt: true });
export type FunnelEvent = typeof funnelEvents.$inferSelect;
export type InsertFunnelEvent = z.infer<typeof insertFunnelEventSchema>;

// ===========================================================================
// Session 3 — Phase 1: Wealth onboarding + adviser overlay (B2B foundation)
// ---------------------------------------------------------------------------
// These three tables are scaffolding only. The advice-engine surface (SOA, ROA,
// fact-find, fee-consents, risk-profiles) is intentionally NOT created yet —
// they belong to a later phase. Integer FKs to users.id throughout.
// ===========================================================================

// Wealth onboarding application — distinct from the public /apply leads-style
// application. This captures a logged-in user's intent to onboard onto the
// wealth platform after their initial account is approved.
export const wealthApplications = pgTable("wealth_applications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  entityType: text("entity_type").notNull(), // individual | joint | company | trust | smsf
  entityName: text("entity_name"),
  abn: text("abn"),
  intendedUse: text("intended_use"),
  // Acknowledgement that AMAX general-advice disclaimer was shown at submit.
  consentGeneralAdvice: boolean("consent_general_advice").notNull().default(false),
  status: text("status").notNull().default("pending"), // pending | under_review | approved | rejected
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertWealthApplicationSchema = createInsertSchema(wealthApplications).omit({ id: true, createdAt: true });
export type WealthApplication = typeof wealthApplications.$inferSelect;
export type InsertWealthApplication = z.infer<typeof insertWealthApplicationSchema>;

// Adviser profile — extra fields for users with role = "adviser".
// One row per adviser user (enforced by .unique() on userId).
export const adviserProfiles = pgTable("adviser_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull().unique(),
  adviserCode: text("adviser_code").unique(),
  fullName: text("full_name"),
  email: text("email"),
  afslNumber: text("afsl_number"),
  authorisedRepNumber: text("authorised_rep_number"),
  status: text("status").notNull().default("active"), // active | suspended | terminated
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAdviserProfileSchema = createInsertSchema(adviserProfiles).omit({ id: true, createdAt: true });
export type AdviserProfile = typeof adviserProfiles.$inferSelect;
export type InsertAdviserProfile = z.infer<typeof insertAdviserProfileSchema>;

// Adviser <-> client link table. Both sides reference users.id (integer).
// Composite unique index prevents duplicate active links between the same
// adviser and client.
export const adviserClients = pgTable("adviser_clients", {
  id: serial("id").primaryKey(),
  adviserUserId: integer("adviser_user_id").references(() => users.id).notNull(),
  clientUserId: integer("client_user_id").references(() => users.id).notNull(),
  relationshipType: text("relationship_type").notNull().default("servicing"), // servicing | introducing | review_only
  isActive: boolean("is_active").notNull().default(true),
  linkedAt: timestamp("linked_at").defaultNow(),
  unlinkedAt: timestamp("unlinked_at"),
}, (table) => ({
  adviserClientUniq: uniqueIndex("adviser_clients_uidx").on(table.adviserUserId, table.clientUserId),
}));

export const insertAdviserClientSchema = createInsertSchema(adviserClients).omit({ id: true, linkedAt: true, unlinkedAt: true });
export type AdviserClient = typeof adviserClients.$inferSelect;
export type InsertAdviserClient = z.infer<typeof insertAdviserClientSchema>;

// ===========================================================================
// Phase 2.1 — Fact find + risk profile (advice-engine foundation)
// ---------------------------------------------------------------------------
// These two tables capture the structured fact-find snapshot and the resulting
// risk-profile scoring outcome. They are the bottom layer of the advice engine.
// SOA, fee consents, advice acks, execution auths and the DB triggers for the
// execution gate / 7-year retention lock are NOT created here — they belong to
// later phases (2.2 → 2.5).
//
// Both tables include retentionUntil + deletionLocked columns up front so the
// later DB trigger work can enforce the 7-year retention without an additional
// ALTER. retentionUntil currently defaults to now() — the actual now()+7y rule
// is enforced by the DB trigger added in a later phase.
//
// Decimal columns use the existing `decimal()` helper (Drizzle alias of
// `numeric()`) for consistency with the rest of the schema.
// ===========================================================================

export const factFindSnapshots = pgTable("fact_find_snapshots", {
  id: serial("id").primaryKey(),

  clientId: integer("client_id").references(() => users.id).notNull(),
  adviserId: integer("adviser_id").references(() => users.id),

  // Section A — Personal & Household
  employmentStatus: text("employment_status"), // full_time | part_time | self_employed | retired | unemployed
  incomeStability: text("income_stability"),    // stable | variable | unstable
  annualIncome: decimal("annual_income", { precision: 14, scale: 2 }),
  annualExpenses: decimal("annual_expenses", { precision: 14, scale: 2 }),

  // Section B — Financial Position (assets)
  cashAssets: decimal("cash_assets", { precision: 14, scale: 2 }),
  investmentAssets: decimal("investment_assets", { precision: 14, scale: 2 }),
  propertyAssets: decimal("property_assets", { precision: 14, scale: 2 }),
  superAssets: decimal("super_assets", { precision: 14, scale: 2 }),
  otherAssets: decimal("other_assets", { precision: 14, scale: 2 }),

  // Section B — Financial Position (liabilities)
  mortgageDebt: decimal("mortgage_debt", { precision: 14, scale: 2 }),
  personalDebt: decimal("personal_debt", { precision: 14, scale: 2 }),
  creditCardDebt: decimal("credit_card_debt", { precision: 14, scale: 2 }),
  otherDebt: decimal("other_debt", { precision: 14, scale: 2 }),

  // Dependants + liquidity
  dependantsCount: integer("dependants_count").notNull().default(0),
  liquidityBufferMonths: integer("liquidity_buffer_months"),
  liquidityNeeds: text("liquidity_needs"), // low | medium | high

  // Section C — Objectives & Time Horizon
  primaryObjective: text("primary_objective"),     // wealth_accumulation | income_generation | capital_preservation | speculative_growth
  investmentHorizon: text("investment_horizon"),   // <2 | 2-5 | 5-10 | 10+
  incomeReliance: text("income_reliance"),         // full | partial | none

  // Section F — Existing investments
  existingAllocation: jsonb("existing_allocation").$type<{
    cash?: number;
    bonds?: number;
    equities?: number;
    property?: number;
    alternatives?: number;
    crypto?: number;
  }>(),

  // Raw answers payload — preserved verbatim for audit defensibility.
  rawAnswers: jsonb("raw_answers").notNull(),

  isComplete: boolean("is_complete").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),

  // Retention scaffolding — DB trigger in a later phase will enforce
  // retentionUntil = createdAt + 7 years and block deletes while
  // deletionLocked = true. Defaults are placeholders until the trigger lands.
  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),
});

export const insertFactFindSnapshotSchema = createInsertSchema(factFindSnapshots).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  deletionLocked: true,
});
export type FactFindSnapshot = typeof factFindSnapshots.$inferSelect;
export type InsertFactFindSnapshot = z.infer<typeof insertFactFindSnapshotSchema>;

export const riskProfiles = pgTable("risk_profiles", {
  id: serial("id").primaryKey(),

  clientId: integer("client_id").references(() => users.id).notNull(),
  factFindSnapshotId: integer("fact_find_snapshot_id")
    .references(() => factFindSnapshots.id)
    .notNull(),

  behaviouralScore: integer("behavioural_score").notNull(),
  capacityAdjustment: integer("capacity_adjustment").notNull(),
  finalScore: integer("final_score").notNull(),

  riskBand: text("risk_band").notNull(),               // conservative | moderate | balanced | growth | high_growth
  recommendedPortfolio: text("recommended_portfolio").notNull(),

  overrideApplied: boolean("override_applied").notNull().default(false),
  overrideReasons: jsonb("override_reasons").$type<string[]>().notNull().default([]),

  allocation: jsonb("allocation").$type<{
    cash: number;
    bonds: number;
    equities: number;
    alternatives: number;
    crypto: number;
  }>().notNull(),

  // Full set of inputs that produced this scoring decision — stored as-is for
  // audit (so the decision can be exactly reproduced on demand).
  scoringInputs: jsonb("scoring_inputs").notNull(),

  createdAt: timestamp("created_at").defaultNow(),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),
});

export const insertRiskProfileSchema = createInsertSchema(riskProfiles).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  deletionLocked: true,
});
export type RiskProfile = typeof riskProfiles.$inferSelect;
export type InsertRiskProfile = z.infer<typeof insertRiskProfileSchema>;

// ===========================================================================
// Phase 2.2 — Advice records + SOA + ROA documents
// ---------------------------------------------------------------------------
// Three new tables, schema only. NO routes, NO services, NO UI added in this
// phase. Fee consents, advice acknowledgements, execution authorisations and
// the DB triggers (execution gate + 7-year retention) are explicitly deferred
// to later phases.
//
// All FKs are integer references to users.id (matching the rest of the repo).
// retentionUntil currently defaults to now() — the actual now()+7y rule will
// be enforced by a DB trigger in a later phase.
// ===========================================================================

export const adviceRecords = pgTable("advice_records", {
  id: serial("id").primaryKey(),

  clientId: integer("client_id").references(() => users.id).notNull(),
  adviserId: integer("adviser_id").references(() => users.id),

  factFindSnapshotId: integer("fact_find_snapshot_id")
    .references(() => factFindSnapshots.id),

  riskProfileId: integer("risk_profile_id")
    .references(() => riskProfiles.id),

  adviceType: text("advice_type").notNull().default("personal"),
  adviceSource: text("advice_source").notNull().default("hybrid"),
  // ai | adviser | hybrid

  status: text("status").notNull().default("draft"),
  // draft | review_pending | issued | accepted | declined | superseded

  scope: jsonb("scope").$type<string[]>().notNull().default([]),
  excludedScope: jsonb("excluded_scope").$type<string[]>().notNull().default([]),

  objectivesSummary: text("objectives_summary"),
  financialSituationSummary: text("financial_situation_summary"),
  strategySummary: text("strategy_summary"),
  recommendationRationale: text("recommendation_rationale"),

  recommendedPortfolio: text("recommended_portfolio"),
  recommendedAllocation: jsonb("recommended_allocation").$type<{
    cash: number;
    bonds: number;
    equities: number;
    alternatives: number;
    crypto: number;
  }>(),

  incompleteInfoWarningRequired: boolean("incomplete_info_warning_required")
    .notNull()
    .default(false),
  incompleteInfoWarningText: text("incomplete_info_warning_text"),

  switchingAdviceRequired: boolean("switching_advice_required")
    .notNull()
    .default(false),
  switchingAdviceDetails: jsonb("switching_advice_details").$type<{
    existingProduct?: string;
    recommendedProduct?: string;
    reasons?: string;
    benefits?: string;
    disadvantages?: string;
    costs?: string;
  }>(),

  // Execution-gate flags. These are populated by later-phase routes when the
  // SOA is issued, viewed, downloaded, accepted or declined. They are NOT the
  // execution gate itself — the gate is recomputed live from these + fee
  // consent state in a later phase.
  soaIssued: boolean("soa_issued").notNull().default(false),
  soaIssuedAt: timestamp("soa_issued_at"),

  soaViewed: boolean("soa_viewed").notNull().default(false),
  soaViewedAt: timestamp("soa_viewed_at"),

  soaDownloaded: boolean("soa_downloaded").notNull().default(false),
  soaDownloadedAt: timestamp("soa_downloaded_at"),

  // Cooling-off — earliest moment the client may accept the advice (e.g.
  // soaViewedAt + 10 minutes). Computed and persisted by later-phase routes.
  earliestAcceptAt: timestamp("earliest_accept_at"),

  adviceAccepted: boolean("advice_accepted").notNull().default(false),
  acceptedAt: timestamp("accepted_at"),

  adviceDeclined: boolean("advice_declined").notNull().default(false),
  declinedAt: timestamp("declined_at"),
  declineReason: text("decline_reason"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),
});

export const soaDocuments = pgTable("soa_documents", {
  id: serial("id").primaryKey(),

  adviceRecordId: integer("advice_record_id")
    .references(() => adviceRecords.id)
    .notNull(),

  clientId: integer("client_id").references(() => users.id).notNull(),
  adviserId: integer("adviser_id").references(() => users.id),

  version: integer("version").notNull().default(1),

  documentUrl: text("document_url"),
  documentHash: text("document_hash"),

  generatedBy: text("generated_by").notNull().default("system"),
  // ai | adviser | system

  documentStatus: text("document_status").notNull().default("draft"),
  // draft | issued | superseded | void

  // RG221-mandated opening screen acknowledgement (set when the client first
  // views the SOA in the viewer). Phase 2.2 only persists the columns; the
  // setter route is added in a later phase.
  openingScreenShown: boolean("opening_screen_shown").notNull().default(false),
  openingScreenShownAt: timestamp("opening_screen_shown_at"),

  fsgDelivered: boolean("fsg_delivered").notNull().default(false),
  fsgDeliveredAt: timestamp("fsg_delivered_at"),

  isLocked: boolean("is_locked").notNull().default(false),

  issuedAt: timestamp("issued_at"),

  createdAt: timestamp("created_at").defaultNow(),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),
});

// ROA = Record of Advice (used for review-and-confirm cycles after the
// initial SOA). Table added now per spec even though no ROA UI is built yet.
export const roaDocuments = pgTable("roa_documents", {
  id: serial("id").primaryKey(),

  adviceRecordId: integer("advice_record_id")
    .references(() => adviceRecords.id)
    .notNull(),

  // Self-reference into adviceRecords for the prior advice this ROA updates.
  previousAdviceRecordId: integer("previous_advice_record_id")
    .references(() => adviceRecords.id),

  clientId: integer("client_id").references(() => users.id).notNull(),
  adviserId: integer("adviser_id").references(() => users.id),

  version: integer("version").notNull().default(1),

  documentUrl: text("document_url"),
  documentHash: text("document_hash"),

  reasonForRoa: text("reason_for_roa"),

  documentStatus: text("document_status").notNull().default("draft"),
  // draft | issued | superseded | void

  isLocked: boolean("is_locked").notNull().default(false),

  issuedAt: timestamp("issued_at"),

  createdAt: timestamp("created_at").defaultNow(),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),
});

export const insertAdviceRecordSchema = createInsertSchema(adviceRecords).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  retentionUntil: true,
  deletionLocked: true,
});
export type AdviceRecord = typeof adviceRecords.$inferSelect;
export type InsertAdviceRecord = z.infer<typeof insertAdviceRecordSchema>;

export const insertSoaDocumentSchema = createInsertSchema(soaDocuments).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  deletionLocked: true,
});
export type SoaDocument = typeof soaDocuments.$inferSelect;
export type InsertSoaDocument = z.infer<typeof insertSoaDocumentSchema>;

export const insertRoaDocumentSchema = createInsertSchema(roaDocuments).omit({
  id: true,
  createdAt: true,
  retentionUntil: true,
  deletionLocked: true,
});
export type RoaDocument = typeof roaDocuments.$inferSelect;
export type InsertRoaDocument = z.infer<typeof insertRoaDocumentSchema>;

// ============================================================================
// Phase 2.3 — Fee Consents, Advice Acknowledgements, Execution Authorisations
// (schema-only; no routes, services, UI, triggers, or ledger work in this phase)
// ============================================================================

export const feeConsents = pgTable("fee_consents", {
  id: serial("id").primaryKey(),

  adviceRecordId: integer("advice_record_id")
    .references(() => adviceRecords.id)
    .notNull(),

  clientId: integer("client_id")
    .references(() => users.id)
    .notNull(),

  adviserId: integer("adviser_id")
    .references(() => users.id),

  feeType: text("fee_type").notNull(),
  // ongoing_service_fee | advice_fee | platform_fee

  amountType: text("amount_type").notNull(),
  // fixed | percentage | calculation_method

  amount: decimal("amount", { precision: 14, scale: 4 }),

  calculationMethod: text("calculation_method"),

  accountNumber: text("account_number").notNull(),
  accountName: text("account_name"),

  deductionFrequency: text("deduction_frequency").notNull(),
  // monthly | quarterly | annually

  referenceDay: timestamp("reference_day").notNull(),

  renewalWindowStart: timestamp("renewal_window_start").notNull(),
  renewalWindowEnd: timestamp("renewal_window_end").notNull(),
  consentExpiryDate: timestamp("consent_expiry_date").notNull(),

  renewalStatus: text("renewal_status").notNull().default("active"),
  // active | renewal_due | expired | withdrawn | renewed

  clientSignatureName: text("client_signature_name").notNull(),

  consentedAt: timestamp("consented_at").defaultNow(),

  withdrawnAt: timestamp("withdrawn_at"),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const adviceAcknowledgements = pgTable("advice_acknowledgements", {
  id: serial("id").primaryKey(),

  adviceRecordId: integer("advice_record_id")
    .references(() => adviceRecords.id)
    .notNull(),

  soaDocumentId: integer("soa_document_id")
    .references(() => soaDocuments.id),

  clientId: integer("client_id")
    .references(() => users.id)
    .notNull(),

  adviserId: integer("adviser_id")
    .references(() => users.id),

  confirmPersonalDetails: boolean("confirm_personal_details").notNull().default(false),
  confirmFinancialInfo: boolean("confirm_financial_info").notNull().default(false),
  confirmObjectives: boolean("confirm_objectives").notNull().default(false),
  confirmRiskProfile: boolean("confirm_risk_profile").notNull().default(false),
  confirmScopeUnderstood: boolean("confirm_scope_understood").notNull().default(false),
  confirmSoaViewed: boolean("confirm_soa_viewed").notNull().default(false),
  confirmFeesUnderstood: boolean("confirm_fees_understood").notNull().default(false),
  confirmFeesConsented: boolean("confirm_fees_consented").notNull().default(false),
  confirmValuesMayFall: boolean("confirm_values_may_fall").notNull().default(false),
  confirmReturnsNotGuaranteed: boolean("confirm_returns_not_guaranteed").notNull().default(false),
  confirmFsgReceived: boolean("confirm_fsg_received").notNull().default(false),

  signatureName: text("signature_name").notNull(),

  acceptedAt: timestamp("accepted_at").defaultNow(),

  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),

  createdAt: timestamp("created_at").defaultNow(),
});

export const executionAuthorisations = pgTable("execution_authorisations", {
  id: serial("id").primaryKey(),

  adviceRecordId: integer("advice_record_id")
    .references(() => adviceRecords.id)
    .notNull(),

  clientId: integer("client_id")
    .references(() => users.id)
    .notNull(),

  adviserId: integer("adviser_id")
    .references(() => users.id),

  authorised: boolean("authorised").notNull().default(false),

  executionScope: jsonb("execution_scope")
    .$type<string[]>()
    .notNull()
    .default([]),

  signatureName: text("signature_name").notNull(),

  // Snapshot of compliance gate at the moment of authorisation.
  // The actual gate must still be recalculated live before allowing execution.
  gateSoaIssued: boolean("gate_soa_issued").notNull().default(false),
  gateSoaViewed: boolean("gate_soa_viewed").notNull().default(false),
  gateAdviceAccepted: boolean("gate_advice_accepted").notNull().default(false),
  gateFeeConsentValid: boolean("gate_fee_consent_valid").notNull().default(false),

  authorisedAt: timestamp("authorised_at").defaultNow(),

  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  retentionUntil: timestamp("retention_until").defaultNow(),
  deletionLocked: boolean("deletion_locked").notNull().default(true),

  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFeeConsentSchema = createInsertSchema(feeConsents).omit({
  id: true,
  retentionUntil: true,
  deletionLocked: true,
  createdAt: true,
  updatedAt: true,
});
export type FeeConsent = typeof feeConsents.$inferSelect;
export type InsertFeeConsent = z.infer<typeof insertFeeConsentSchema>;

export const insertAdviceAcknowledgementSchema = createInsertSchema(adviceAcknowledgements).omit({
  id: true,
  retentionUntil: true,
  deletionLocked: true,
  createdAt: true,
});
export type AdviceAcknowledgement = typeof adviceAcknowledgements.$inferSelect;
export type InsertAdviceAcknowledgement = z.infer<typeof insertAdviceAcknowledgementSchema>;

export const insertExecutionAuthorisationSchema = createInsertSchema(executionAuthorisations).omit({
  id: true,
  retentionUntil: true,
  deletionLocked: true,
  createdAt: true,
});
export type ExecutionAuthorisation = typeof executionAuthorisations.$inferSelect;
export type InsertExecutionAuthorisation = z.infer<typeof insertExecutionAuthorisationSchema>;

// =============================================================================
// SESSION 7 — TRACK B: PRODUCTION-SAFETY LEDGER (idempotency + double-entry)
// =============================================================================
// Foundation for non-custodial money movement. Core principles:
//   1. Transaction creation ≠ balance change. Balances change ONLY when ledger
//      entries are posted after settlement confirmation from the partner.
//   2. Balances are DERIVED (SUM(credit) - SUM(debit)) — never stored, never
//      mutated. The ledger is append-only.
//   3. Every money endpoint requires an Idempotency-Key header.
// =============================================================================

// Accounts — one row per (userId, currency, accountType). Distinct from `wallets`
// (which is a fast/cached display balance for the existing UX layer). Accounts back
// the new ledger; wallets remain in place for legacy code paths.
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  currency: text("currency").notNull(),
  // client | platform_suspense | fee | adjustment
  accountType: text("account_type").notNull().default("client"),
  // active | frozen | closed
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  // One account per (user, currency, type) — prevents accidental duplicates that would
  // silently split a user's balance across two rows.
  userCurrencyTypeIdx: uniqueIndex("accounts_user_currency_type_uidx").on(
    table.userId, table.currency, table.accountType
  ),
}));

// Ledger entries — append-only double-entry. Every settlement event posts a
// matching debit + credit pair (or more) that sum to zero per currency.
export const ledgerEntries = pgTable("ledger_entries", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").references(() => transactions.id).notNull(),
  accountId: integer("account_id").references(() => accounts.id).notNull(),
  userId: integer("user_id").references(() => users.id).notNull(),
  currency: text("currency").notNull(),
  // debit | credit
  direction: text("direction").notNull(),
  // 18,8 supports both fiat (e.g. AUD) and crypto (e.g. BTC) precisions.
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // Reviewer fix #3 — index on accountId so the SUM(...) balance query stays fast as the
  // ledger grows. Without this, every getAccountBalance() becomes a full table scan.
  accountIdx: index("ledger_entries_account_idx").on(table.accountId),
  // Per-user/per-currency balance roll-up index — used by /api/ledger/balances/:currency.
  userCurrencyIdx: index("ledger_entries_user_currency_idx").on(table.userId, table.currency),
  // Transaction → entries lookup (for displaying a transaction's posting detail).
  transactionIdx: index("ledger_entries_transaction_idx").on(table.transactionId),
}));

export const insertAccountSchema = createInsertSchema(accounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Account = typeof accounts.$inferSelect;
export type InsertAccount = z.infer<typeof insertAccountSchema>;

export const insertLedgerEntrySchema = createInsertSchema(ledgerEntries).omit({
  id: true,
  createdAt: true,
});
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type InsertLedgerEntry = z.infer<typeof insertLedgerEntrySchema>;

// =============================================================================
// SESSION 8 — RECONCILIATION
// =============================================================================
// Periodic verification that internal ledger balances match external custodian
// balances. Each row is a point-in-time snapshot of (internal vs external)
// for a single (userId, currency) pair, plus the computed difference.
//
// Why a table (not just logs):
//   - Auditors need a queryable history of every reconciliation outcome
//   - Trends (recurring drift on the same (user, currency) pair) need analysis
//   - "When did this match last go red?" is a forensic question we must answer
// =============================================================================
export const reconciliations = pgTable("reconciliations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  currency: text("currency").notNull(),
  // Internal = SUM(ledger_entries) for this (user, currency). External = whatever
  // the custodian reports. Both stored as decimal strings to preserve precision.
  internalBalance: decimal("internal_balance", { precision: 18, scale: 8 }).notNull(),
  externalBalance: decimal("external_balance", { precision: 18, scale: 8 }),
  difference: decimal("difference", { precision: 18, scale: 8 }),
  // match | mismatch | external_unavailable
  // We added a third state because "no custodian data" is operationally distinct
  // from "data shows mismatch" — the former means our verification *failed*,
  // not that we found a discrepancy. Conflating the two would silently hide
  // outages of the custodian feed.
  status: text("status").notNull(),
  // info | warning | alert | critical | none — drives PagerDuty/Sentry routing
  // when we wire alerting. "none" for matches; informational severities for
  // small drift; harder severities for larger gaps.
  severity: text("severity").notNull().default("none"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // Lookup the latest reconciliation for a (user, currency) pair
  userCurrencyIdx: index("reconciliations_user_currency_idx").on(table.userId, table.currency),
  // "Show me all mismatches in the last 24h" — common ops query
  statusCreatedIdx: index("reconciliations_status_created_idx").on(table.status, table.createdAt),
}));

export const insertReconciliationSchema = createInsertSchema(reconciliations).omit({
  id: true,
  createdAt: true,
});
export type Reconciliation = typeof reconciliations.$inferSelect;
export type InsertReconciliation = z.infer<typeof insertReconciliationSchema>;

// =============================================================================
// SESSION 9 — ADVISER ACCESS LAYER (read-only overlay for retail-AFSL partner)
// =============================================================================
// Purpose: let `role='adviser'` users (planners working under a partnered
// retail-AFSL licensee) see their LINKED clients' state, manage internal
// workflow tasks, and request reports.
//
// Hard limits (enforced at the route layer, NOT here — but documented here for
// the next reader):
//   - Advisers cannot move money (no debit/credit/transfer routes accept
//     adviser tokens; existing money routes are scoped to the calling user)
//   - Advisers cannot edit balances, override KYC, or execute advice
//   - Adviser visibility is scoped strictly through the existing
//     `adviser_clients` link table (uniq on adviser+client). No row, no read.
//
// What stays out of this session (deferred until the AFSL partner operating
// model is confirmed): commission tier engine, fact-find automation, retail
// SOA pipeline, retail-AFSL execution authorisation flow, programmatic advice
// workflow. The Path B (wholesale) advice engine from Sessions 1-7 is left
// completely untouched.
// =============================================================================

export const adviserTasks = pgTable("adviser_tasks", {
  id: serial("id").primaryKey(),
  adviserUserId: integer("adviser_user_id").references(() => users.id).notNull(),
  // The client this task is about. Adviser MUST be linked to the client at the
  // time of insert (enforced in the route via assertAdviserClientLink).
  clientUserId: integer("client_user_id").references(() => users.id).notNull(),
  // portfolio_review | fee_consent_renewal | kyc_followup | document_request |
  // meeting_prep | other — kept as text rather than enum so we can extend
  // without a migration; route validates with zod.
  taskType: text("task_type").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  // open | in_progress | done | cancelled
  status: text("status").notNull().default("open"),
  // low | normal | high | urgent
  priority: text("priority").notNull().default("normal"),
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  // "show me this adviser's open tasks" — the most common dashboard query
  adviserStatusIdx: index("adviser_tasks_adviser_status_idx").on(table.adviserUserId, table.status),
  // "show me all tasks for this client" — used on client-detail
  clientIdx: index("adviser_tasks_client_idx").on(table.clientUserId),
}));

export const insertAdviserTaskSchema = createInsertSchema(adviserTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
});
export type AdviserTask = typeof adviserTasks.$inferSelect;
export type InsertAdviserTask = z.infer<typeof insertAdviserTaskSchema>;

export const reportRequests = pgTable("report_requests", {
  id: serial("id").primaryKey(),
  adviserUserId: integer("adviser_user_id").references(() => users.id).notNull(),
  clientUserId: integer("client_user_id").references(() => users.id).notNull(),
  // portfolio_summary | fee_summary | transaction_history | full_statement
  reportType: text("report_type").notNull(),
  // Currently only "pdf" is supported, but kept extensible for csv/xlsx.
  format: text("format").notNull().default("pdf"),
  // requested | generating | ready | failed | expired
  // PDF generation itself is OUT OF SCOPE for this session — rows will sit at
  // 'requested' until a future generator worker picks them up. The audit trail
  // (who asked for what, when) is the immediate value.
  status: text("status").notNull().default("requested"),
  // Optional natural-language note ("for the Q2 review meeting on Friday")
  notes: text("notes"),
  // Set by the generator when ready; null while generating.
  downloadUrl: text("download_url"),
  failureReason: text("failure_reason"),
  requestedAt: timestamp("requested_at").defaultNow(),
  generatedAt: timestamp("generated_at"),
  expiresAt: timestamp("expires_at"),
}, (table) => ({
  // "show me all my report requests" / "show me all reports for this client"
  adviserCreatedIdx: index("report_requests_adviser_created_idx").on(table.adviserUserId, table.requestedAt),
  clientCreatedIdx: index("report_requests_client_created_idx").on(table.clientUserId, table.requestedAt),
}));

export const insertReportRequestSchema = createInsertSchema(reportRequests).omit({
  id: true,
  requestedAt: true,
  generatedAt: true,
  downloadUrl: true,
  failureReason: true,
  expiresAt: true,
  status: true,
});
export type ReportRequest = typeof reportRequests.$inferSelect;
export type InsertReportRequest = z.infer<typeof insertReportRequestSchema>;
