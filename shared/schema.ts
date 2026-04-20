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
  status: text("status").notNull(), // pending, completed, failed, cancelled
  // Explicit labeling — prevents UI/regulator confusion. "internal_only" = no external settlement.
  settlementStatus: text("settlement_status").notNull().default("internal_only"),
  description: text("description").notNull(),
  sourceExchange: text("source_exchange"), // binance, coinbase, etc.
  blockchainTxHash: text("blockchain_tx_hash"), // transaction hash for blockchain transfers
  createdAt: timestamp("created_at").defaultNow(),
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
