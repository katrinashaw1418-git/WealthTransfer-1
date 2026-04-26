import { pgTable, text, serial, integer, boolean, decimal, timestamp, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Email normalisation — single source of truth.
//
// Hard rule: every code path that reads an email from request input or stores
// one in the DB MUST run it through normalizeEmail() first. Combined with the
// case-insensitive unique indexes below (users_email_lower_unique +
// registration_invites_email_lower_active_unique), this collapses the
// "User@x.com vs user@x.com" duplicate-account hazard at both the
// application layer and the DB layer (defence in depth).
// ---------------------------------------------------------------------------
export function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

export const users = pgTable(
  "users",
  {
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
  },
  (table) => ({
    // Case-insensitive uniqueness on email. The plain `.unique()` on the column
    // above catches exact duplicates; this functional index catches case-only
    // collisions (User@x.com vs user@x.com) so we cannot end up with two rows
    // that resolve to the same identity. Application code MUST normalise on
    // write (see normalizeEmail above) — this index is the safety net.
    emailLowerUnique: uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
  }),
);

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

// Session 14 — Registration tokens (account registration after admin approval).
// Single-use, 48h expiry. Stores SHA-256(token) — raw token returned ONCE on creation.
// Email + role come from this table (admin-approved), NEVER from the activation form input.
// `relatedEntityType` is 'application' when the invite was minted off an approved
// application; 'invite' when an admin issued a direct invite. `adviserUserId` is
// only set when role='client' and the inviter wants the new client auto-linked to
// that adviser via adviser_clients on activation.
export const registrationInvites = pgTable(
  "registration_invites",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role").notNull(), // 'client' | 'adviser' | 'admin'
    relatedEntityType: text("related_entity_type"), // 'application' | 'invite' | null
    relatedEntityId: integer("related_entity_id"),
    adviserUserId: integer("adviser_user_id").references(() => users.id),
    inviteHash: text("invite_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdBy: integer("created_by").references(() => users.id).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    emailActiveIdx: index("registration_invites_email_active_idx").on(table.email),
    // Partial unique index: at most ONE live (unused) invite per email at any time.
    // The DB enforces the "only newest invite is valid" invariant — if two issuers
    // race, one of them gets a 23505 unique-violation and the surrounding
    // transaction rolls back. Mappers translate this to a 409.
    emailActiveUnique: uniqueIndex("registration_invites_email_active_unique")
      .on(table.email)
      .where(sql`${table.usedAt} IS NULL`),
    // Case-insensitive twin of the above. Belt-and-braces against any code path
    // that forgets to normalise the email before insert: User@x.com and
    // user@x.com cannot both have a live invite, even if some legacy caller
    // skips normalizeEmail().
    emailLowerActiveUnique: uniqueIndex("registration_invites_email_lower_active_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.usedAt} IS NULL`),
  }),
);

export const insertRegistrationInviteSchema = createInsertSchema(registrationInvites).omit({
  id: true,
  createdAt: true,
  usedAt: true,
});
export type InsertRegistrationInvite = z.infer<typeof insertRegistrationInviteSchema>;
export type RegistrationInvite = typeof registrationInvites.$inferSelect;

// =============================================================================
// SESSION 15B — Adviser notification dismissals (preference layer only).
// -----------------------------------------------------------------------------
// IMPORTANT: This table does NOT store notifications. Notifications are still
// derived in real time by getAdviserNotifications() from the source-of-truth
// tables (investmentInstructions, adviserTasks, feeConsents, reportRequests,
// users.kycStatus). This table only records "this adviser chose to hide this
// item from their bell". The aggregator LEFT JOINs against this table and
// filters dismissed rows out of items[] (counts unaffected — accuracy first).
// Re-firing the same source row (e.g. a renewed pending instruction) does NOT
// resurrect a dismissal because the (sourceType, sourceId) pair is unchanged.
// To "undo dismiss", we DELETE the row (POST and DELETE endpoints).
// =============================================================================
export const adviserNotificationDismissals = pgTable(
  "adviser_notification_dismissals",
  {
    id: serial("id").primaryKey(),
    adviserUserId: integer("adviser_user_id")
      .references(() => users.id)
      .notNull(),
    sourceType: text("source_type").notNull(), // consent | task | fee_consent | report | kyc
    sourceId: integer("source_id").notNull(),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  },
  (table) => ({
    // Idempotent dismiss: re-POSTing the same (adviser, sourceType, sourceId)
    // hits the unique index → we treat 23505 as success in the route handler.
    uniqDismissal: uniqueIndex("adviser_notification_dismissals_uidx").on(
      table.adviserUserId,
      table.sourceType,
      table.sourceId,
    ),
    adviserIdx: index("adviser_notification_dismissals_adviser_idx").on(table.adviserUserId),
  }),
);

export const insertAdviserNotificationDismissalSchema = createInsertSchema(
  adviserNotificationDismissals,
).omit({
  id: true,
  dismissedAt: true,
});
export type InsertAdviserNotificationDismissal = z.infer<
  typeof insertAdviserNotificationDismissalSchema
>;
export type AdviserNotificationDismissal = typeof adviserNotificationDismissals.$inferSelect;

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

// =============================================================================
// SESSION 20 — DBFO live fee-consent REQUESTS
// -----------------------------------------------------------------------------
// `feeConsents` represents a SIGNED, executed consent (clientSignatureName is
// notNull, consentedAt defaults to now()). It cannot represent the
// "adviser asked, client hasn't responded" state.
//
// `feeConsentRequests` is the pre-signature lifecycle row. Adviser POSTs the
// proposed terms here; client signs (transition to "consented" + insert a
// row into `feeConsents`) or declines. Withdraw and supersede states cover
// the corner cases where the adviser pulls the request or sends a fresh one.
//
// State machine: pending -> consented | declined | withdrawn_by_adviser | superseded
//
// Hard rules baked in:
//   - clientUserId always notNull (cannot request a consent without a client).
//   - signedFeeConsentId is the link back to the executed consent row, set
//     atomically with the status transition to "consented".
//   - All money-movement is OUT OF SCOPE — this table is request-and-sign
//     only. The fee engine (Session 23A/B) is gated separately.
// =============================================================================
export const feeConsentRequests = pgTable(
  "fee_consent_requests",
  {
    id: serial("id").primaryKey(),

    adviserUserId: integer("adviser_user_id")
      .references(() => users.id)
      .notNull(),
    clientUserId: integer("client_user_id")
      .references(() => users.id)
      .notNull(),

    // Optional — request can pre-date a fresh advice record. When the client
    // signs, the executed feeConsents row will reference whichever advice
    // record was active at sign time.
    adviceRecordId: integer("advice_record_id").references(() => adviceRecords.id),

    // Mirror of feeConsents fee shape. Numeric stored as text-decimal.
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

    // Proposed reference day (the DBFO renewal anchor). Renewal window is
    // proposed too: per RG175/Netwealth, opens 60 days before reference and
    // closes 150 days after — server validates this on POST.
    proposedReferenceDay: timestamp("proposed_reference_day").notNull(),
    proposedRenewalWindowStart: timestamp("proposed_renewal_window_start").notNull(),
    proposedRenewalWindowEnd: timestamp("proposed_renewal_window_end").notNull(),
    proposedConsentExpiryDate: timestamp("proposed_consent_expiry_date").notNull(),

    // Adviser-supplied justification (shown to client at sign time).
    requestNote: text("request_note"),

    status: text("status").notNull().default("pending"),
    // pending | consented | declined | withdrawn_by_adviser | superseded

    // Reason captured on decline (client) or withdraw (adviser).
    declineReason: text("decline_reason"),

    // Set atomically when the client signs — points to the executed consent.
    signedFeeConsentId: integer("signed_fee_consent_id").references(
      () => feeConsents.id,
    ),

    respondedAt: timestamp("responded_at"),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    clientStatusIdx: index("fee_consent_request_client_status_idx").on(
      table.clientUserId,
      table.status,
    ),
    adviserStatusIdx: index("fee_consent_request_adviser_status_idx").on(
      table.adviserUserId,
      table.status,
    ),
    // One executed consent can only ever be linked to one request — prevents
    // a race from creating two requests both pointing at the same consent row.
    signedConsentUnique: uniqueIndex("fee_consent_request_signed_unique_idx")
      .on(table.signedFeeConsentId)
      .where(sql`signed_fee_consent_id IS NOT NULL`),
    // DB-level state-machine invariant:
    //   status='consented' iff signedFeeConsentId IS NOT NULL.
    // Stops any code path from leaving an orphan partial state.
    statusSignedConsistency: check(
      "fee_consent_request_status_signed_chk",
      sql`(status = 'consented' AND signed_fee_consent_id IS NOT NULL)
          OR (status <> 'consented' AND signed_fee_consent_id IS NULL)`,
    ),
  }),
);

export const insertFeeConsentRequestSchema = createInsertSchema(
  feeConsentRequests,
).omit({
  id: true,
  status: true,
  declineReason: true,
  signedFeeConsentId: true,
  respondedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type FeeConsentRequest = typeof feeConsentRequests.$inferSelect;
export type InsertFeeConsentRequest = z.infer<typeof insertFeeConsentRequestSchema>;

export const insertAdviceAcknowledgementSchema = createInsertSchema(adviceAcknowledgements).omit({
  id: true,
  retentionUntil: true,
  deletionLocked: true,
  createdAt: true,
});
export type AdviceAcknowledgement = typeof adviceAcknowledgements.$inferSelect;
export type InsertAdviceAcknowledgement = z.infer<typeof insertAdviceAcknowledgementSchema>;

// =============================================================================
// SESSION 10B — Investment Instructions
// -----------------------------------------------------------------------------
// Lightweight per-instruction lifecycle table. Adviser creates a row in
// status="pending_consent"; client transitions to "consented" or "rejected".
// References (all nullable so an early MVP instruction can be created without
// requiring a full SOA + fee consent stack):
//   - adviceRecordId         -> the SOA/ROA that justifies this instruction
//   - feeConsentId           -> the active DBFO fee consent covering this
//   - executionAuthorisationId -> the formal RG 175 execution authorisation
// In a later session, the "consented -> processing -> completed" transitions
// will require all three references to be populated and live.
// =============================================================================
export const investmentInstructions = pgTable("investment_instructions", {
  id: serial("id").primaryKey(),

  adviserUserId: integer("adviser_user_id")
    .references(() => users.id)
    .notNull(),

  clientUserId: integer("client_user_id")
    .references(() => users.id)
    .notNull(),

  productId: integer("product_id")
    .references(() => investmentProducts.id)
    .notNull(),

  // buy | sell | switch
  action: text("action").notNull(),

  // Decimal AUD amount. Precision matches userInvestments.investedAmount.
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),

  // pending_consent | consented | processing | completed | rejected | cancelled
  status: text("status").notNull().default("pending_consent"),

  // Optional compliance gate references — populated as the instruction matures.
  adviceRecordId: integer("advice_record_id").references(() => adviceRecords.id),
  feeConsentId: integer("fee_consent_id").references(() => feeConsents.id),
  executionAuthorisationId: integer("execution_authorisation_id").references(
    () => executionAuthorisations.id,
  ),

  notes: text("notes"),
  rejectionReason: text("rejection_reason"),

  consentedAt: timestamp("consented_at"),
  rejectedAt: timestamp("rejected_at"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertInvestmentInstructionSchema = createInsertSchema(investmentInstructions).omit({
  id: true,
  status: true, // server-controlled — adviser cannot bypass pending_consent
  consentedAt: true,
  rejectedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InvestmentInstruction = typeof investmentInstructions.$inferSelect;
export type InsertInvestmentInstruction = z.infer<typeof insertInvestmentInstructionSchema>;

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

// ---------------------------------------------------------------------------
// Task #37 — ledger posting receipts (DB-enforced double-post lock)
// ---------------------------------------------------------------------------
// One row per settlement transaction that has had its ledger pair posted.
// Inserted in the SAME database transaction as the matching ledger_entries
// rows by postLedgerEntries(). Because transaction_id is the PRIMARY KEY,
// Postgres itself refuses a second posting against the same transactionId —
// even when the two posters are concurrent connections at the default
// READ COMMITTED isolation level, where the previous COUNT-then-INSERT
// guard left a TOCTOU window open.
//
// The application never reads from this table; its only role is to give the
// database a unique key to lock on so that the second concurrent
// postLedgerEntries() call can never silently succeed. Keeping the receipt
// in its own table (rather than e.g. a unique index on
// ledger_entries.transactionId) preserves the schema invariant that a single
// transactionId may carry N entries — a balanced pair today, more for FX
// flows tomorrow — while still enforcing one-posting-per-transaction at the
// database level.
// ---------------------------------------------------------------------------
export const ledgerPostings = pgTable("ledger_postings", {
  transactionId: integer("transaction_id")
    .primaryKey()
    .references(() => transactions.id),
  postedAt: timestamp("posted_at").defaultNow().notNull(),
});

export type LedgerPosting = typeof ledgerPostings.$inferSelect;

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
// SESSION 25 (Task #17) — WALLET ↔ LEDGER RECONCILIATION
// =============================================================================
// The other half of the verification picture from `reconciliations` (which
// compares ledger ↔ external custodian). This table compares the cached
// wallet display balance against `SUM(ledger_entries)` for each
// (userId, currency) — i.e. it watches for drift between the source of truth
// (the ledger) and the cache (the wallets row).
//
// After Task #17, every settlement path posts ledger entries first and then
// refreshes the wallet cache from the ledger sum in the same transaction, so
// any non-zero drift recorded here is a SYMPTOM OF A BUG (or of a historical
// transaction that pre-dates ledger enforcement) and must be investigated.
// =============================================================================
export const walletLedgerReconciliations = pgTable("wallet_ledger_reconciliations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  currency: text("currency").notNull(),
  // Cached value the UI / API layer was about to serve.
  walletCachedBalance: decimal("wallet_cached_balance", { precision: 18, scale: 8 }).notNull(),
  // Authoritative value derived from the ledger right now.
  ledgerSumBalance: decimal("ledger_sum_balance", { precision: 18, scale: 8 }).notNull(),
  // Signed: walletCachedBalance - ledgerSumBalance. Positive => cache claims
  // MORE than the ledger has posted; negative => cache claims LESS.
  driftAmount: decimal("drift_amount", { precision: 18, scale: 8 }).notNull(),
  // match | mismatch
  status: text("status").notNull(),
  // none | info | warning | alert | critical — same convention as the
  // ledger ↔ custodian reconciliation table so alerting code can be shared.
  severity: text("severity").notNull().default("none"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userCurrencyIdx: index("wallet_ledger_recon_user_currency_idx").on(table.userId, table.currency),
  statusCreatedIdx: index("wallet_ledger_recon_status_created_idx").on(table.status, table.createdAt),
}));

export const insertWalletLedgerReconciliationSchema = createInsertSchema(walletLedgerReconciliations).omit({
  id: true,
  createdAt: true,
});
export type WalletLedgerReconciliation = typeof walletLedgerReconciliations.$inferSelect;
export type InsertWalletLedgerReconciliation = z.infer<typeof insertWalletLedgerReconciliationSchema>;

// =============================================================================
// SESSION 28 (Task #35) — DRIFT ACKNOWLEDGEMENTS (alert suppression)
// =============================================================================
// Companion to `walletLedgerReconciliations`. When ops are already aware of a
// drift case (because they're investigating it) the daily reconciliation must
// stop re-paging them every 24 hours. An admin records an acknowledgement for
// the (userId, currency) pair, snapshotting the CURRENT drift amount; the
// dispatcher then suppresses further operator notifications for that pair
// until either:
//   (a) the drift moves by more than MATCH_EPSILON from the snapshot
//       (the situation has changed — ops needs to re-page), or
//   (b) the acknowledgement is explicitly cleared (clearedAt set).
//
// Hard rules:
//   1. The reconciliation row is STILL written every run regardless of
//      acknowledgement — the audit trail must show the drift continued to
//      exist. Only the notification dispatch is suppressed.
//   2. Exactly one ACTIVE (clearedAt IS NULL) acknowledgement per
//      (userId, currency) — enforced by a partial unique index. A second
//      ack attempt while one is open returns 409.
//   3. Ack rows are append-only-ish: clearing an ack sets clearedAt rather
//      than deleting the row, so "alert suppressed because acknowledged on
//      YYYY-MM-DD by Z" stays auditable forever.
// =============================================================================
export const walletLedgerDriftAcknowledgements = pgTable(
  "wallet_ledger_drift_acknowledgements",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id).notNull(),
    currency: text("currency").notNull(),
    // Snapshot of the SIGNED drift (cached - ledgerSum) at the moment of
    // acknowledgement. Used by the dispatcher to decide whether the drift
    // has materially moved since the ack was recorded.
    acknowledgedDriftAmount: decimal("acknowledged_drift_amount", {
      precision: 18,
      scale: 8,
    }).notNull(),
    // Free-form note from the admin: ticket id, root-cause hypothesis, etc.
    note: text("note"),
    // Admin who recorded the acknowledgement.
    acknowledgedByUserId: integer("acknowledged_by_user_id")
      .references(() => users.id)
      .notNull(),
    acknowledgedAt: timestamp("acknowledged_at").defaultNow().notNull(),
    // When set, the acknowledgement is no longer active and notifications
    // resume on the next mismatch.
    clearedAt: timestamp("cleared_at"),
    clearedByUserId: integer("cleared_by_user_id").references(() => users.id),
    clearReason: text("clear_reason"),
  },
  (table) => ({
    // Look up the active ack for a (user, currency) pair on every recon run.
    userCurrencyIdx: index("wallet_ledger_drift_ack_user_currency_idx").on(
      table.userId,
      table.currency,
    ),
    // At most one ACTIVE ack per (user, currency). Cleared rows are excluded
    // from the constraint so historical acks accumulate freely.
    activeUniq: uniqueIndex("wallet_ledger_drift_ack_active_uidx")
      .on(table.userId, table.currency)
      .where(sql`cleared_at IS NULL`),
  }),
);

export const insertWalletLedgerDriftAcknowledgementSchema = createInsertSchema(
  walletLedgerDriftAcknowledgements,
).omit({
  id: true,
  acknowledgedAt: true,
  clearedAt: true,
  clearedByUserId: true,
  clearReason: true,
});
export type WalletLedgerDriftAcknowledgement =
  typeof walletLedgerDriftAcknowledgements.$inferSelect;
export type InsertWalletLedgerDriftAcknowledgement = z.infer<
  typeof insertWalletLedgerDriftAcknowledgementSchema
>;

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

// ===========================================================================
// Session 19 — admin_review_notes
// ---------------------------------------------------------------------------
// Free-text annotations admins can attach to any reviewable entity (currently
// investment_instruction; future: adviser, application). Read-only artefact;
// admins do not edit/delete prior notes — every change is a new row, mirroring
// the audit-log pattern. The audit log itself separately records the
// admin_review_note_added action.
// ===========================================================================
export const adminReviewNotes = pgTable("admin_review_notes", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id").references(() => users.id).notNull(),
  // entityType is open-string today (no enum) to keep the table reusable for
  // adviser/application notes without a schema change. Validated at the API.
  entityType: text("entity_type").notNull(),
  // String to match audit_logs.entityId (which can be email-typed for invites).
  entityId: text("entity_id").notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  entityIdx: index("admin_review_notes_entity_idx").on(table.entityType, table.entityId),
  createdIdx: index("admin_review_notes_created_idx").on(table.createdAt),
}));

export const insertAdminReviewNoteSchema = createInsertSchema(adminReviewNotes).omit({
  id: true,
  createdAt: true,
});
export type AdminReviewNote = typeof adminReviewNotes.$inferSelect;
export type InsertAdminReviewNote = z.infer<typeof insertAdminReviewNoteSchema>;

// =============================================================================
// SESSION 23A — 10C ADVISER FEE ENGINE — GATE A SCAFFOLD
// -----------------------------------------------------------------------------
// THREE TABLES that model fee rules, daily accruals, and pending deductions.
// THIS IS A SCAFFOLD ONLY:
//   - No wallet debit, no adviser credit, no ledger posting, no reversal,
//     no investment execution, and no automatic/scheduled fee processing.
//   - Admin "approval" of a pending deduction is a status flip + audit only.
//   - Adviser & client surfaces over these tables are STRICTLY READ-ONLY.
// =============================================================================

export const adviserFeeRules = pgTable(
  "adviser_fee_rules",
  {
    id: serial("id").primaryKey(),

    // Every rule attaches to a SIGNED feeConsents row — this is the legal
    // basis for any future deduction. Without a consent, no rule can exist.
    feeConsentId: integer("fee_consent_id")
      .references(() => feeConsents.id)
      .notNull(),

    clientUserId: integer("client_user_id")
      .references(() => users.id)
      .notNull(),
    adviserUserId: integer("adviser_user_id")
      .references(() => users.id)
      .notNull(),

    feeType: text("fee_type").notNull(),
    // ongoing_service_fee | advice_fee | platform_fee
    amountType: text("amount_type").notNull(),
    // fixed | percentage

    // Mutually exclusive payload depending on amountType. Validated at the
    // service boundary (see server/services/fee-engine.ts).
    rateBps: integer("rate_bps"), // basis points (1bp = 0.01%) when amountType=percentage
    fixedAmount: decimal("fixed_amount", { precision: 14, scale: 4 }), // when amountType=fixed
    currency: text("currency").notNull().default("AUD"),

    // 10000 bps = 100% — splits MUST sum to 10000 (DB CHECK below).
    adviserSplitBps: integer("adviser_split_bps").notNull(),
    platformSplitBps: integer("platform_split_bps").notNull(),

    status: text("status").notNull().default("active"),
    // active | paused

    pausedAt: timestamp("paused_at"),
    pausedReason: text("paused_reason"),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    adviserStatusIdx: index("adviser_fee_rules_adviser_status_idx").on(
      table.adviserUserId,
      table.status,
    ),
    clientStatusIdx: index("adviser_fee_rules_client_status_idx").on(
      table.clientUserId,
      table.status,
    ),
    consentIdx: index("adviser_fee_rules_consent_idx").on(table.feeConsentId),
    // The 10C invariant: adviser + platform = 100% (10000 bps). Anything else
    // means the rule cannot be safely accrued; the DB rejects it outright.
    splitsTotalChk: check(
      "adviser_fee_rules_splits_total_chk",
      sql`adviser_split_bps + platform_split_bps = 10000`,
    ),
    // Bps must be in [0, 10000].
    splitsRangeChk: check(
      "adviser_fee_rules_splits_range_chk",
      sql`adviser_split_bps BETWEEN 0 AND 10000 AND platform_split_bps BETWEEN 0 AND 10000`,
    ),
  }),
);

export const adviserFeeAccruals = pgTable(
  "adviser_fee_accruals",
  {
    id: serial("id").primaryKey(),

    feeRuleId: integer("fee_rule_id")
      .references(() => adviserFeeRules.id)
      .notNull(),
    clientUserId: integer("client_user_id")
      .references(() => users.id)
      .notNull(),
    adviserUserId: integer("adviser_user_id")
      .references(() => users.id)
      .notNull(),

    // Calendar date the accrual is for (NOT the time the row was inserted).
    // We store as timestamp for portability with the rest of the schema.
    accrualDate: timestamp("accrual_date").notNull(),

    // When a gate fails, accrualAmount = 0 and gateReason is populated so the
    // skip is visible and auditable. Otherwise > 0.
    accrualAmount: decimal("accrual_amount", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    adviserShareAmount: decimal("adviser_share_amount", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    platformShareAmount: decimal("platform_share_amount", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    currency: text("currency").notNull().default("AUD"),

    // Populated when the row is a "skipped" accrual: e.g. consent_expired,
    // consent_withdrawn, link_inactive, rule_paused, splits_invalid.
    gateReason: text("gate_reason"),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    // Idempotency: re-running runDailyAccruals for the same date is a no-op
    // because the (rule, date) tuple is unique.
    ruleDateUniq: uniqueIndex("adviser_fee_accruals_rule_date_uniq").on(
      table.feeRuleId,
      table.accrualDate,
    ),
    clientDateIdx: index("adviser_fee_accruals_client_date_idx").on(
      table.clientUserId,
      table.accrualDate,
    ),
    adviserDateIdx: index("adviser_fee_accruals_adviser_date_idx").on(
      table.adviserUserId,
      table.accrualDate,
    ),
  }),
);

export const adviserFeeDeductions = pgTable(
  "adviser_fee_deductions",
  {
    id: serial("id").primaryKey(),

    clientUserId: integer("client_user_id")
      .references(() => users.id)
      .notNull(),
    adviserUserId: integer("adviser_user_id")
      .references(() => users.id)
      .notNull(),

    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),

    totalAccrued: decimal("total_accrued", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    adviserShareAmount: decimal("adviser_share_amount", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    platformShareAmount: decimal("platform_share_amount", { precision: 14, scale: 4 })
      .notNull()
      .default("0"),
    currency: text("currency").notNull().default("AUD"),

    // List of accrual ids rolled up into this deduction batch. Stored as a
    // JSON array of integers so future reconciliation can walk back to the
    // contributing rows without an extra join table.
    accrualIds: jsonb("accrual_ids").notNull().default(sql`'[]'::jsonb`),

    status: text("status").notNull().default("pending_approval"),
    // pending_approval | approved | settled | rejected | reversed
    //
    // SESSION 23B (Gate B): "settled" is the terminal success state after the
    // ledger postings have been written. "approved" is now legacy / transitional
    // — Gate B's approve flow goes straight to "settled" inside the same DB
    // transaction as the ledger pair. A failed posting attempt rolls the row
    // back to pending_approval and records `failureReason` so the admin can
    // retry with full context.
    //
    // TASK #33: "reversed" is the terminal state after an admin has explicitly
    // unwound a settled deduction. The reversal posts the OPPOSITE balanced
    // ledger triple against a NEW transactions row (the original `settled_*`
    // fields are NEVER edited — history is append-only); the reversal pointer
    // lives in `reversal_transaction_id` below.
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    rejectedReason: text("rejected_reason"),

    // Gate B settlement wiring — populated atomically with the ledger pair.
    settledAt: timestamp("settled_at"),
    settledTransactionId: integer("settled_transaction_id").references(
      () => transactions.id,
    ),
    // Per-deduction idempotency key for the underlying transactions row.
    // Reused on retries so a duplicated approve never produces a second
    // posting; UNIQUE on transactions.idempotency_key enforces this even if
    // the in-memory check loses a race.
    idempotencyKey: text("idempotency_key").unique(),
    // Surface for the most-recent posting failure. Cleared on a successful
    // settlement. Purely informational; the source-of-truth recovery signal
    // is `status === 'pending_approval' AND settled_at IS NULL`.
    failureReason: text("failure_reason"),

    // Task #33 — reversal of a settled deduction. All four fields are populated
    // atomically inside the same DB transaction that posts the reversing ledger
    // triple, OR all four remain NULL. The reversal transaction has its own
    // deterministic idempotency key (`fee_deduction_<id>_reversal`) so retries
    // can never produce a second reversal posting.
    reversedAt: timestamp("reversed_at"),
    reversedByUserId: integer("reversed_by_user_id").references(() => users.id),
    reversedReason: text("reversed_reason"),
    reversalTransactionId: integer("reversal_transaction_id").references(
      () => transactions.id,
    ),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    statusIdx: index("adviser_fee_deductions_status_idx").on(table.status),
    adviserPeriodIdx: index("adviser_fee_deductions_adviser_period_idx").on(
      table.adviserUserId,
      table.periodStart,
    ),
    clientPeriodIdx: index("adviser_fee_deductions_client_period_idx").on(
      table.clientUserId,
      table.periodStart,
    ),
  }),
);

export const insertAdviserFeeRuleSchema = createInsertSchema(adviserFeeRules).omit({
  id: true,
  status: true,
  pausedAt: true,
  pausedReason: true,
  createdAt: true,
  updatedAt: true,
});
export type AdviserFeeRule = typeof adviserFeeRules.$inferSelect;
export type InsertAdviserFeeRule = z.infer<typeof insertAdviserFeeRuleSchema>;

export const insertAdviserFeeAccrualSchema = createInsertSchema(adviserFeeAccruals).omit({
  id: true,
  createdAt: true,
});
export type AdviserFeeAccrual = typeof adviserFeeAccruals.$inferSelect;
export type InsertAdviserFeeAccrual = z.infer<typeof insertAdviserFeeAccrualSchema>;

export const insertAdviserFeeDeductionSchema = createInsertSchema(adviserFeeDeductions).omit({
  id: true,
  status: true,
  approvedByUserId: true,
  approvedAt: true,
  rejectedReason: true,
  settledAt: true,
  settledTransactionId: true,
  idempotencyKey: true,
  failureReason: true,
  reversedAt: true,
  reversedByUserId: true,
  reversedReason: true,
  reversalTransactionId: true,
  createdAt: true,
});
export type AdviserFeeDeduction = typeof adviserFeeDeductions.$inferSelect;
export type InsertAdviserFeeDeduction = z.infer<typeof insertAdviserFeeDeductionSchema>;

// ---------------------------------------------------------------------------
// Session 27 (Task #23) — Fee accrual run log
// ---------------------------------------------------------------------------
// Each invocation of `runDailyAccruals` (whether by the daily cron in
// server/index.ts or by an admin pressing "Run today's accruals") writes one
// row to this table so admins can see at a glance — without scanning server
// logs — when accruals last ran, what date they covered, what was inserted /
// gated / duplicated, and whether the run errored out.
//
// This is intentionally a SEPARATE table from `audit_logs`: audit_logs is the
// who-did-what trail (one row per state change), whereas this is the
// operational health log (one row per scheduled or manual job invocation,
// including failures). Keeping them separate means we can index/query the
// latter without polluting the former.
// ---------------------------------------------------------------------------
export const feeAccrualRuns = pgTable(
  "fee_accrual_runs",
  {
    id: serial("id").primaryKey(),
    // Calendar date the run targeted (NOT when the row was inserted — see
    // startedAt for that). Stored as timestamp for portability with the rest
    // of the schema.
    accrualDate: timestamp("accrual_date").notNull(),
    // "cron" = daily background job; "manual" = admin POSTed
    // /api/admin/fee-accruals/run.
    trigger: text("trigger").notNull(),
    // null when trigger='cron'; admin user id when trigger='manual'.
    triggeredByUserId: integer("triggered_by_user_id").references(() => users.id),
    inserted: integer("inserted").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    // { consent_missing: 1, rule_paused: 2, ... } — empty object on a clean run.
    byGateReason: jsonb("by_gate_reason").notNull().default(sql`'{}'::jsonb`),
    // Populated only when the run threw. The summary counts will be 0 in that
    // case so an admin can distinguish "ran cleanly, nothing to do" from
    // "ran and crashed".
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => ({
    // We almost always want "the most recent run" — index on startedAt DESC.
    startedAtIdx: index("fee_accrual_runs_started_at_idx").on(table.startedAt),
  }),
);

export const insertFeeAccrualRunSchema = createInsertSchema(feeAccrualRuns).omit({
  id: true,
  startedAt: true,
});
export type FeeAccrualRun = typeof feeAccrualRuns.$inferSelect;
export type InsertFeeAccrualRun = z.infer<typeof insertFeeAccrualRunSchema>;

// ---------------------------------------------------------------------------
// Task #36 — Operator alert audit log
// ---------------------------------------------------------------------------
// Durable record of every alert dispatched by `notifyOperator` (currently the
// daily wallet ↔ ledger reconciliation cron, future callers can reuse). For
// compliance and incident review, ops needs a queryable history that survives
// log-rotation and webhook-receiver outages — e.g. "prove we paged within
// 24h of detecting drift".
//
// One row per `notifyOperator` invocation. We store WHICH channels were
// attempted and the per-channel outcome (success / http_error / timeout /
// error) so an investigator can see at a glance whether the alert reached
// its destination — not just whether we tried.
//
// This table is intentionally separate from `audit_logs`: audit_logs is the
// who-did-what trail of admin state changes, whereas this is the operational
// record of automated paging events.
// ---------------------------------------------------------------------------
export const operatorAlerts = pgTable(
  "operator_alerts",
  {
    id: serial("id").primaryKey(),
    // Originating job, e.g. "wallet-ledger-reconciliation". Used as a filter
    // on the admin viewer so operators can isolate one job's alert stream.
    source: text("source").notNull(),
    // info | warning | alert | critical — mirrors OperatorAlertSeverity in
    // server/services/operator-alerts.ts.
    severity: text("severity").notNull(),
    // Short human-readable summary surfaced in the UI list view.
    title: text("title").notNull(),
    // Full structured payload as supplied to notifyOperator (e.g. userId,
    // currency, drift amount). Empty object is allowed.
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    // Channels we tried to dispatch to, in dispatch order. e.g. ["log"] or
    // ["log","webhook"]. Always includes "log" — the log channel is
    // unconditional.
    channelsAttempted: text("channels_attempted").array().notNull(),
    // Per-channel outcome detail. Shape:
    //   [{ channel, status, httpStatus?, error?, durationMs }]
    // status ∈ "success" | "http_error" | "timeout" | "error".
    // Stored as an array (not keyed object) so future re-dispatches of the
    // same channel can be appended without overwriting prior attempts.
    channelOutcomes: jsonb("channel_outcomes").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // Most reads are "show me the most recent N alerts" — index createdAt.
    createdAtIdx: index("operator_alerts_created_at_idx").on(table.createdAt),
    // Filter-by-source and filter-by-severity are the two filters the admin
    // viewer exposes; combine each with createdAt for ORDER BY pushdown.
    sourceCreatedIdx: index("operator_alerts_source_created_idx").on(
      table.source,
      table.createdAt,
    ),
    severityCreatedIdx: index("operator_alerts_severity_created_idx").on(
      table.severity,
      table.createdAt,
    ),
  }),
);

export const insertOperatorAlertSchema = createInsertSchema(operatorAlerts).omit({
  id: true,
  createdAt: true,
});
export type OperatorAlertRecord = typeof operatorAlerts.$inferSelect;
export type InsertOperatorAlertRecord = z.infer<typeof insertOperatorAlertSchema>;

// ---------------------------------------------------------------------------
// Task #59 + Task #60 — operator-alert prune run log
// ---------------------------------------------------------------------------
// One row per invocation of `pruneOperatorAlertsAndRecord` (success or
// failure). Two consumers depend on this table:
//
//   * Task #59 — the admin UI lists recent runs so operators can confirm at
//     a glance that the daily prune is healthy without grepping server logs.
//   * Task #60 — a watchdog reads "most recent successful run" to detect
//     when the prune has silently stopped running (deploy that crashes the
//     cron, env-var typo that throws on every tick, etc.). Only rows with
//     status='success' refresh the freshness clock; a long streak of
//     failures must page operators just like complete silence would.
//
// Kept small on purpose: only the metadata needed to (a) detect staleness,
// (b) explain what the last run did. Full per-row audit of what was deleted
// is out of scope; the prune service's own log line carries that detail. At
// one row per day, this table gains ~365 rows/year and never needs its own
// retention policy.
// ---------------------------------------------------------------------------
export const operatorAlertPruneRuns = pgTable(
  "operator_alert_prune_runs",
  {
    id: serial("id").primaryKey(),
    // When the prune attempt began. Defaulted server-side so a caller cannot
    // accidentally backdate a run and fool the watchdog.
    startedAt: timestamp("started_at").notNull().defaultNow(),
    // null for runs that threw before completing (errorMessage will be set).
    finishedAt: timestamp("finished_at"),
    // 'success' | 'error'. Watchdog filters by status='success'.
    status: text("status").notNull(),
    // Configured retention window for this run, captured for forensics.
    // Nullable because a failure may occur before the window is resolved.
    retentionDays: integer("retention_days"),
    // Inclusive lower bound that was kept (anything older was deleted).
    cutoff: timestamp("cutoff"),
    // Affected-row count returned by the DELETE driver. 0 on a clean,
    // nothing-to-prune day; null if the run failed before the DELETE ran.
    deleted: integer("deleted"),
    // Wall-clock duration of the prune call, in milliseconds. Useful for
    // spotting slow runs before they balloon into timeouts.
    durationMs: integer("duration_ms"),
    // Truncated error message for failed runs; null on success.
    errorMessage: text("error_message"),
  },
  (table) => ({
    // Reads are "show me the most recent N runs" (Task #59 admin UI) and
    // "most recent successful run" (Task #60 watchdog) — both want startedAt
    // indexed.
    startedAtIdx: index("operator_alert_prune_runs_started_at_idx").on(
      table.startedAt,
    ),
  }),
);

export const insertOperatorAlertPruneRunSchema = createInsertSchema(
  operatorAlertPruneRuns,
).omit({ id: true, startedAt: true });
// Retained alongside `OperatorAlertPruneRun` for backwards compatibility
// with the Task #59 admin route that imported the *Record name first.
export type OperatorAlertPruneRunRecord = typeof operatorAlertPruneRuns.$inferSelect;
export type OperatorAlertPruneRun = typeof operatorAlertPruneRuns.$inferSelect;
export type InsertOperatorAlertPruneRun = z.infer<
  typeof insertOperatorAlertPruneRunSchema
>;
