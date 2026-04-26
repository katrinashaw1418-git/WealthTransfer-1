import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { and, desc, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { storage } from "./storage";
import { db } from "./db";
import {
  wallets,
  transactions,
  userInvestments,
  idempotencyKeys,
  auditLogs,
  passwordResetTokens,
  users,
  leads,
  funnelEvents,
  applications as applicationsTable,
  factFindSnapshots,
  riskProfiles,
} from "@shared/schema";
import { getRecommendation } from "@shared/recommendation-engine";
import { scoreRiskProfile, type RiskAnswers } from "./services/risk-scoring";
import { sendVerificationEmail, emailConfigured } from "./email";
import {
  requireAuth,
  requireKyc,
  authMiddleware,
  signToken,
  verifyPassword,
  hashPassword,
  isLocalDev,
  type AuthPayload,
} from "./auth";
import { registerAdviserRoutes } from "./adviser-routes";
import { registerClientRoutes } from "./client-routes";

// ---------------------------------------------------------------------------
// Zod validation schemas for all money-movement routes.
// These run before any storage access so bad input is rejected early.
// ---------------------------------------------------------------------------
const fxExchangeSchema = z.object({
  fromCurrency: z.string().min(2).max(10),
  toCurrency: z.string().min(2).max(10),
  amount: z.coerce.number().positive("Amount must be positive"),
}).refine(d => d.fromCurrency !== d.toCurrency, {
  message: "Source and target currencies must differ",
});

const depositSchema = z.object({
  currency: z.string().min(2).max(10),
  amount: z.coerce.number().positive("Amount must be positive"),
  description: z.string().max(255).optional(),
});

const withdrawSchema = z.object({
  currency: z.string().min(2).max(10),
  amount: z.coerce.number().positive("Amount must be positive"),
  description: z.string().max(255).optional(),
});

const investmentSchema = z.object({
  productId: z.number().int().positive(),
  amount: z.coerce.number().positive("Amount must be positive"),
  sourceCurrency: z.string().min(2).max(10).optional(),
  sourceAmount: z.coerce.number().positive().optional(),
});

// ---------------------------------------------------------------------------
// Lightweight in-memory system event log — persists within a server session.
// Stores the last MAX_EVENTS entries (FIFO ring); no DB migration required.
// Replace with a persistent events table when audit-grade traceability is needed.
// ---------------------------------------------------------------------------
const MAX_SYSTEM_EVENTS = 200;
const systemEventLog: Array<{ type: string; payload: unknown; timestamp: string }> = [];

function saveSystemEvent(event: { type: string; payload: unknown }): void {
  systemEventLog.unshift({ ...event, timestamp: new Date().toISOString() });
  if (systemEventLog.length > MAX_SYSTEM_EVENTS) systemEventLog.length = MAX_SYSTEM_EVENTS;
}

// ---------------------------------------------------------------------------
// Money-movement rate limiter — applied to FX exchange, withdrawals, and
// investment purchases. 30 requests per 5 minutes per IP prevents automated abuse.
// ---------------------------------------------------------------------------
const moneyMovementLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests for this operation. Please try again in a few minutes." },
});

// ---------------------------------------------------------------------------
// DB-backed idempotency for all money-movement routes.
// Uses the idempotency_keys table (unique on userId+route+key).
// payloadHash guards against key reuse with a different request body.
// Durable across restarts and horizontal scaling.
// ---------------------------------------------------------------------------
function hashPayload(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

async function checkIdempotency(
  userId: number,
  route: string,
  key: string,
  payloadHash: string
): Promise<{ existing: boolean; response?: unknown; conflict?: boolean }> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.route, route),
        eq(idempotencyKeys.key, key)
      )
    );
  if (!row) return { existing: false };
  if (row.payloadHash !== payloadHash) return { existing: true, conflict: true };
  return { existing: true, response: row.responseJson };
}

async function saveIdempotentResponse(
  userId: number,
  route: string,
  key: string,
  payloadHash: string,
  response: unknown
): Promise<void> {
  await db.insert(idempotencyKeys).values({
    userId,
    route,
    key,
    payloadHash,
    responseJson: response as any,
  }).onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Persistent audit log writer — writes finance-grade event records to DB.
// ---------------------------------------------------------------------------
async function writeAuditLog(
  userId: number | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  metadata: unknown,
  ipAddress: string | null
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId,
      action,
      entityType,
      entityId,
      metadata: metadata as any,
      ipAddress,
    });
  } catch {
    // Audit log failures must never crash money routes
  }
}

// ---------------------------------------------------------------------------
// Wallet transfer Zod schema (audit: missing validation added here)
// ---------------------------------------------------------------------------
const walletTransferSchema = z.object({
  fromCurrency: z.string().min(2).max(10),
  toCurrency: z.string().min(2).max(10),
  amount: z.coerce.number().positive("Amount must be positive"),
}).refine(d => d.fromCurrency !== d.toCurrency, {
  message: "Source and target currencies must differ",
});

// Category-level fallback rates — only used when a product has no explicit annualReturn set
function getAnnualReturnFallback(category: string, productName?: string): number {
  const rates = {
    'real_estate': 0.11,      // 11% midpoint (10-12% range)
    'corporate_credit': 0.11, // 11% midpoint (10-12% range)
    'venture_capital': 0.18,  // 18% midpoint (16-20% range)
    'digital_assets': (productName && typeof productName === 'string' && productName.includes('Bitcoin')) ? 0.60 : 0.0575,
    'default': 0.11
  };
  return rates[category as keyof typeof rates] || rates.default;
}

// Unified investment performance calculation
// Prefers product.annualReturn + product.returnMethod when set; falls back to category mapping
function calculateInvestmentPerformance(
  product: any,
  investedAmount: number,
  investmentDate: Date,
  currentDate: Date = new Date()
): { currentValue: number | null; returnAmount: number; returnPercentage: number; valuationStatus?: string } {
  if (!product) {
    return { currentValue: investedAmount, returnAmount: 0, returnPercentage: 0 };
  }

  if (investedAmount <= 0) {
    return { currentValue: 0, returnAmount: 0, returnPercentage: 0 };
  }

  const start = new Date(investmentDate);
  const end = new Date(currentDate);

  if (start > end) {
    return { currentValue: investedAmount, returnAmount: 0, returnPercentage: 0 };
  }

  const daysHeld = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const yearsHeld = daysHeld / 365;

  const returnMethod = product.returnMethod || "fixed_annual_compound";

  let currentValue: number | null = investedAmount;
  let valuationStatus: string | undefined;

  switch (returnMethod) {
    case "manual_nav":
    case "market_price":
      // No live price source available — exclude from totals and surface via valuationStatus
      currentValue = null;
      valuationStatus = "missing_price_source";
      break;
    default: {
      // Fail-closed: refuse to compute if no explicit product rate is stored in the DB.
      // Category assumption fallbacks (getAnnualReturnFallback) are intentionally not used here
      // to prevent silently overstating portfolio value with made-up rates.
      if (product.annualReturn == null) {
        currentValue = null;
        valuationStatus = "missing_product_rate";
        break;
      }
      const annualReturn = parseFloat(product.annualReturn);
      if (returnMethod === "fixed_annual_simple") {
        currentValue = investedAmount * (1 + annualReturn * yearsHeld);
      } else {
        currentValue = investedAmount * Math.pow(1 + annualReturn, yearsHeld);
      }
    }
  }

  // returnAmount and returnPercentage are 0 when currentValue is unknown
  const returnAmount = currentValue !== null ? currentValue - investedAmount : 0;
  const returnPercentage = currentValue !== null ? (returnAmount / investedAmount) * 100 : 0;

  return { currentValue, returnAmount, returnPercentage, valuationStatus };
}

// Shared FX conversion helper — tries direct rate then inverse.
// Returns null when no rate is available so callers can surface the gap
// rather than silently undercounting the portfolio total.
async function convertToUsd(currency: string, amount: number): Promise<number | null> {
  if (currency === "USD") return amount;
  const direct = await storage.getFxRate(currency, "USD");
  if (direct) return amount * parseFloat(direct.rate);
  const inverse = await storage.getFxRate("USD", currency);
  if (inverse) return amount / parseFloat(inverse.rate);
  return null;
}

// One shared engine for all investment valuation — batch fetches products to avoid N+1 queries
async function calculateInvestmentTotalsAtDate(userId: number, asOfDate: Date = new Date()) {
  const investments = await storage.getUserInvestments(userId);
  const products = await storage.getInvestmentProducts();

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let hasUnpricedAssets = false;
  const items: Array<{
    id: number; productId: number; productName: string; category: string;
    annualReturn: string; returnMethod: string;
    investedAmount: number; currentValue: number | null; returnAmount: number; returnPercentage: number;
    valuationStatus?: string;
  }> = [];

  for (const inv of investments) {
    const product = products.find((p: any) => p.id === inv.productId);
    if (!product) continue;
    const investedAmount = parseFloat(inv.investedAmount);
    const investmentDate = new Date(inv.investmentDate ?? Date.now());
    if (investmentDate > asOfDate) continue; // investment didn't exist yet at asOfDate
    const perf = calculateInvestmentPerformance(product, investedAmount, investmentDate, asOfDate);
    totalInvested += investedAmount;
    // Unpriced assets (manual_nav / market_price) are excluded from the total rather than
    // estimated with a placeholder — hasUnpricedAssets signals the gap to callers
    totalCurrentValue += perf.currentValue ?? 0;
    if (perf.currentValue === null) hasUnpricedAssets = true;
    items.push({
      id: inv.id,
      productId: product.id,
      productName: product.name,
      category: product.category,
      annualReturn: product.annualReturn ?? getAnnualReturnFallback(product.category, product.name).toString(),
      returnMethod: product.returnMethod ?? "fixed_annual_compound",
      investedAmount,
      currentValue: perf.currentValue,
      returnAmount: perf.returnAmount,
      returnPercentage: perf.returnPercentage,
      ...(perf.valuationStatus ? { valuationStatus: perf.valuationStatus } : {}),
    });
  }

  // Runtime guard — NaN here means a perf.currentValue ?? 0 silently received a non-numeric;
  // fail fast rather than propagate a corrupt total downstream.
  if (!Number.isFinite(totalCurrentValue)) {
    throw new Error(`[investment_totals] NaN in totalCurrentValue for userId=${userId}`);
  }

  return {
    totalInvested,
    totalCurrentValue,
    totalReturn: totalCurrentValue - totalInvested,
    totalReturnPercent: totalInvested > 0 ? ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0,
    hasUnpricedAssets,
    items,
  };
}

// Reconstruct wallet balances at a historical date using reverse transaction replay.
// Formula: balance_at_date = current_balance + debits_after_date - credits_after_date
// This accurately undoes any deposits/withdrawals/investments that occurred after asOfDate.
//
// NOTE: Float (IEEE 754 double) arithmetic is used intentionally here.
// Safe within current precision tolerance (<$0.01 drift per transaction chain).
// Replace with Decimal.js if FX volume or precision requirements increase significantly.
async function reconstructWalletBalancesAsOf(
  userId: number,
  asOfDate: Date
): Promise<Array<{ currency: string; balance: number; walletType: string }>> {
  const wallets = await storage.getWallets(userId);
  const allTransactions = await storage.getTransactions(userId); // no limit — need complete history

  return wallets.map((wallet: any) => {
    const currency = wallet.currency;
    const currentBalance = parseFloat(wallet.balance);

    // Only consider completed transactions that occurred AFTER the requested date
    const txAfter = allTransactions.filter(
      (t: any) => t.status === "completed" && new Date(t.createdAt) > asOfDate
    );

    // Debits: money LEFT this wallet after asOfDate → add back to get historical balance
    const totalDebits = txAfter
      .filter((t: any) => t.fromCurrency === currency)
      .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);

    // Credits: money ENTERED this wallet after asOfDate → subtract to get historical balance
    // For exchange transactions the net credited amount = (amount * exchangeRate) - fee.
    // t.fee is stored in the target currency (the fee was deducted from the converted amount).
    // Using gross (amount * exchangeRate) would overstate the historical credit by the 0.5% fee.
    const totalCredits = txAfter
      .filter((t: any) => t.toCurrency === currency)
      .reduce((sum: number, t: any) => {
        const base = parseFloat(t.amount);
        const rate = t.exchangeRate ? parseFloat(t.exchangeRate) : 1;
        const feeInTarget = t.fee ? parseFloat(t.fee) : 0;
        return sum + (t.type === "exchange" ? base * rate - feeInTarget : base);
      }, 0);

    const historicalBalance = Math.max(0, currentBalance + totalDebits - totalCredits);
    return { currency, balance: historicalBalance, walletType: wallet.walletType };
  });
}

// Guard called before any transaction is persisted to storage.
// Prevents bad transactions from poisoning the wallet reconstruction history.
function validateTransaction(tx: {
  type: string;
  amount: number;
  fromCurrency?: string | null;
  toCurrency?: string | null;
  exchangeRate?: number | null;
}): void {
  if (!Number.isFinite(tx.amount) || tx.amount <= 0) {
    throw new Error("Invalid transaction amount");
  }
  if (!tx.type) {
    throw new Error("Transaction type required");
  }
  if (tx.type === "exchange") {
    if (!tx.fromCurrency || !tx.toCurrency) {
      throw new Error("Exchange requires both fromCurrency and toCurrency");
    }
    if (!Number.isFinite(tx.exchangeRate) || (tx.exchangeRate as number) <= 0) {
      throw new Error("Invalid exchange rate");
    }
  }
  if (tx.fromCurrency && tx.toCurrency && tx.fromCurrency === tx.toCurrency) {
    throw new Error("fromCurrency and toCurrency must differ");
  }
}

// Compares reconstructed balances against current wallet state and logs any drift.
// Returns the list of mismatches so callers can decide how to surface them.
export async function reconcileWalletBalances(
  userId: number,
  asOfDate: Date
): Promise<Array<{ currency: string; reconstructedBalance: number; currentBalance: number; delta: number }>> {
  const reconstructed = await reconstructWalletBalancesAsOf(userId, asOfDate);
  const currentWallets = await storage.getWallets(userId);
  const tolerance = 1e-6;

  const byReconstructed = new Map(reconstructed.map((r: any) => [r.currency, r.balance]));

  const mismatches = (currentWallets as any[])
    .map((wallet: any) => {
      const reconstructedBalance = byReconstructed.get(wallet.currency) ?? 0;
      const currentBalance = parseFloat(wallet.balance ?? "0");
      const delta = currentBalance - reconstructedBalance;
      return { currency: wallet.currency, reconstructedBalance, currentBalance, delta };
    })
    .filter((x) => Math.abs(x.delta) > tolerance);

  if (mismatches.length > 0) {
    const logPayload = { userId, asOfDate: asOfDate.toISOString().split("T")[0], mismatches };
    console.warn("[ledger_drift_detected]", logPayload);
    // Persist to in-memory event log for session-level traceability
    saveSystemEvent({ type: "ledger_drift", payload: logPayload });
    // Write to persistent audit log for significant drift (>$0.01) only — prevents noise
    const significantMismatches = mismatches.filter((m) => Math.abs(m.delta) > 0.01);
    if (significantMismatches.length > 0) {
      await writeAuditLog(userId, "ledger_drift_detected", "wallet", null,
        { asOfDate: asOfDate.toISOString().split("T")[0], mismatches: significantMismatches }, null
      ).catch((err) => console.error("[reconcile] audit log write failed:", err));
    }
  }

  return mismatches;
}

// Portfolio valuation at any given date — uses date-aware wallet balances for historical accuracy
async function calculatePortfolioTotalsAtDate(userId: number, asOfDate: Date = new Date()) {
  const now = new Date();
  const isToday = Math.abs(asOfDate.getTime() - now.getTime()) < 12 * 60 * 60 * 1000; // within 12 hours

  // Use current wallet state for today; reconstruct from transactions for historical dates
  const walletData = isToday
    ? (await storage.getWallets(userId)).map((w: any) => ({
        currency: w.currency,
        balance: parseFloat(w.balance),
        walletType: w.walletType,
      }))
    : await reconstructWalletBalancesAsOf(userId, asOfDate);

  let fiatValue = 0, cryptoValue = 0, stablecoinValue = 0;
  let hasUnpricedWallets = false;
  const unpricedCurrencies: string[] = [];

  for (const wallet of walletData) {
    const balance = wallet.balance;
    if (wallet.walletType === "fiat") {
      const usd = await convertToUsd(wallet.currency, balance);
      if (usd !== null) {
        fiatValue += usd;
      } else {
        hasUnpricedWallets = true;
        unpricedCurrencies.push(wallet.currency);
      }
    } else if (wallet.currency === "USDT" || wallet.currency === "USDC") {
      stablecoinValue += balance;
    } else {
      const rate = await storage.getFxRate(wallet.currency, "USD");
      if (rate) {
        cryptoValue += balance * parseFloat(rate.rate);
      } else {
        hasUnpricedWallets = true;
        unpricedCurrencies.push(wallet.currency);
      }
    }
  }
  const investmentTotals = await calculateInvestmentTotalsAtDate(userId, asOfDate);
  const investmentValue = investmentTotals.totalCurrentValue;
  return {
    fiatValue, cryptoValue, stablecoinValue, investmentValue,
    totalValue: fiatValue + cryptoValue + stablecoinValue + investmentValue,
    hasUnpricedWallets,
    unpricedCurrencies,
  };
}

// Save a fresh "actual" snapshot immediately after any portfolio-changing event
async function saveActualSnapshot(userId: number): Promise<void> {
  const totals = await calculatePortfolioTotalsAtDate(userId, new Date());
  await storage.createPortfolioSnapshot({
    userId,
    snapshotDate: new Date(),
    totalValue: totals.totalValue.toFixed(2),
    fiatValue: totals.fiatValue.toFixed(2),
    cryptoValue: totals.cryptoValue.toFixed(2),
    stablecoinValue: totals.stablecoinValue.toFixed(2),
    investmentValue: totals.investmentValue.toFixed(2),
    source: "actual" as SnapshotSource,
  });
}

type SnapshotSource = "actual" | "historical_estimate";

// Create a single snapshot for one day — skips if one already exists for that day
async function createSnapshotForDay(
  userId: number,
  snapshotDate: Date,
  source: SnapshotSource
): Promise<void> {
  const dayStart = new Date(snapshotDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(snapshotDate);
  dayEnd.setHours(23, 59, 59, 999);
  const existingForDay = await storage.getPortfolioSnapshots(userId, dayStart, dayEnd);
  if (existingForDay.length > 0) return; // already have one for this day
  const totals = await calculatePortfolioTotalsAtDate(userId, snapshotDate);
  await storage.createPortfolioSnapshot({
    userId,
    snapshotDate,
    totalValue: totals.totalValue.toFixed(2),
    fiatValue: totals.fiatValue.toFixed(2),
    cryptoValue: totals.cryptoValue.toFixed(2),
    stablecoinValue: totals.stablecoinValue.toFixed(2),
    investmentValue: totals.investmentValue.toFixed(2),
    source,
  });
}

// Gap-aware backfill — fills every missing day in the range, including internal gaps
async function backfillPortfolioHistory(userId: number, startDate: Date, endDate: Date) {
  const normalizedStart = new Date(startDate);
  normalizedStart.setHours(0, 0, 0, 0);
  const normalizedEnd = new Date(endDate);
  normalizedEnd.setHours(0, 0, 0, 0);

  const existing = await storage.getPortfolioSnapshots(userId, normalizedStart, normalizedEnd);

  // Build a set of dates that already have snapshots (YYYY-MM-DD keys)
  const existingDays = new Set(
    existing.map((s: any) => new Date(s.snapshotDate).toISOString().split("T")[0])
  );

  // Collect every missing date in one pass, then write them sequentially
  const missingDates: Date[] = [];
  const cursor = new Date(normalizedStart);
  while (cursor <= normalizedEnd) {
    const key = cursor.toISOString().split("T")[0];
    if (!existingDays.has(key)) missingDates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const todayKey = normalizedEnd.toISOString().split("T")[0];
  for (const date of missingDates) {
    const isToday = date.toISOString().split("T")[0] === todayKey;
    await createSnapshotForDay(userId, date, isToday ? "actual" : "historical_estimate");
  }

  // After filling any new snapshots, run reconciliation to detect ledger drift
  if (missingDates.length > 0) {
    await reconcileWalletBalances(userId, normalizedEnd);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Session 9 — adviser overlay (read-only client access for partner advisers).
  // Mounted FIRST so its specific /api/adviser/* paths are matched before
  // any future generic /api/* fallback handlers.
  registerAdviserRoutes(app);
  registerClientRoutes(app);

  // Ensure crypto + GBP FX rates exist (seed missing rows, reset sequence first)
  {
    const { db } = await import('./db');
    const { sql: rawSql } = await import('drizzle-orm');
    // Reset the serial sequence to MAX(id) so inserts don't collide with existing rows
    await db.execute(rawSql`SELECT setval(pg_get_serial_sequence('fx_rates', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM fx_rates), 1), 1))`);
    const missingRates = [
      { baseCurrency: 'BTC', targetCurrency: 'USD', rate: '95000.00', spread: '0.0050' },
      { baseCurrency: 'ETH', targetCurrency: 'USD', rate: '3500.00',  spread: '0.0050' },
      { baseCurrency: 'GBP', targetCurrency: 'USD', rate: '1.27000',  spread: '0.0050' },
      { baseCurrency: 'USD', targetCurrency: 'GBP', rate: '0.78740',  spread: '0.0050' },
    ];
    for (const { baseCurrency, targetCurrency, rate, spread } of missingRates) {
      const existing = await storage.getFxRate(baseCurrency, targetCurrency);
      if (!existing) {
        await db.execute(rawSql`
          INSERT INTO fx_rates (base_currency, target_currency, rate, spread, updated_at)
          VALUES (${baseCurrency}, ${targetCurrency}, ${rate}, ${spread}, NOW())
        `);
      }
    }
  }

  // Migrate investment_products: add annualReturn + returnMethod columns and set per-product rates
  {
    const { db } = await import('./db');
    const { sql: rawSql } = await import('drizzle-orm');
    await db.execute(rawSql`
      ALTER TABLE investment_products
      ADD COLUMN IF NOT EXISTS annual_return numeric(10,4),
      ADD COLUMN IF NOT EXISTS return_method text NOT NULL DEFAULT 'fixed_annual_compound'
    `);
    // Seed per-product rates — matches the category fallback mapping for existing products
    // Uses DO UPDATE so it's safe to re-run on every restart
    await db.execute(rawSql`
      UPDATE investment_products SET annual_return = 0.1100 WHERE id = 1 AND annual_return IS NULL;
      UPDATE investment_products SET annual_return = 0.6000 WHERE id = 2 AND annual_return IS NULL;
      UPDATE investment_products SET annual_return = 0.1100 WHERE id = 3 AND annual_return IS NULL;
      UPDATE investment_products SET annual_return = 0.0575 WHERE id = 4 AND annual_return IS NULL;
      UPDATE investment_products SET annual_return = 0.0575 WHERE id = 5 AND annual_return IS NULL;
    `);
  }

  // Migrate portfolio_snapshots to add 'source' column if missing, then backfill 90 days of history
  {
    const { db } = await import('./db');
    const { sql: rawSql } = await import('drizzle-orm');
    // Add column if it doesn't exist — idempotent
    await db.execute(rawSql`
      ALTER TABLE portfolio_snapshots
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'actual'
    `);
    // Backfill 90 days so charts and period returns always have data to draw from.
    // Runs for every registered user — not just the seed/demo user.
    // Only creates snapshots for days with none already present — safe to repeat.
    const backfillEnd = new Date();
    backfillEnd.setHours(0, 0, 0, 0);
    const backfillStart = new Date(backfillEnd);
    backfillStart.setDate(backfillStart.getDate() - 90);
    const allUsers = await db.select({ id: users.id }).from(users);
    for (const u of allUsers) {
      await backfillPortfolioHistory(u.id, backfillStart, backfillEnd);
    }
  }

  // ---------------------------------------------------------------------------
  // One-time startup migrations: DB constraints + demo user password hashing
  // ---------------------------------------------------------------------------
  {
    // Wallet integrity constraints — enforce non-negative balances at DB level
    await db.execute(sql.raw(`
      DO $$ BEGIN
        ALTER TABLE wallets ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `));
    await db.execute(sql.raw(`
      DO $$ BEGIN
        ALTER TABLE wallets ADD CONSTRAINT available_balance_non_negative CHECK (available_balance >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `));
    // Unique wallet per user+currency — prevent duplicate wallets
    await db.execute(sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_wallet_user_currency ON wallets (user_id, currency);
    `));
    // Hash the demo user's plaintext password on first startup
    const demoUser = await storage.getUser(1);
    if (demoUser && !demoUser.password.startsWith("$2")) {
      const hashed = await hashPassword(demoUser.password);
      await storage.updateUser(1, { password: hashed });
    }

    // Seed the `wiseinvestor` demo account if it doesn't exist (idempotent on every boot).
    // Used for live demos; password is intentionally well-known.
    try {
      const existing = await storage.getUserByUsername("wiseinvestor");
      const desiredHash = await hashPassword("wise888");
      if (!existing) {
        await storage.createUser({
          username: "wiseinvestor",
          email: "wiseinvestor@amaxglobal.com.au",
          password: desiredHash,
          firstName: "Wise",
          lastName: "Investor",
          kycStatus: "verified",
          userTier: "professional",
          emailVerified: true,
        } as any);
      } else if (!(await verifyPassword("wise888", existing.password))) {
        await storage.updateUser(existing.id, { password: desiredHash, emailVerified: true });
      }
    } catch (err) {
      console.warn("[seed] wiseinvestor demo account seed failed:", (err as Error).message);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth routes — login, current user, logout
  // ---------------------------------------------------------------------------

  // Login — returns JWT on valid credentials
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      // Session 8 hardening: system accounts are infrastructure, not users.
      // They own platform-side ledger accounts (suspense, fees, adjustments)
      // and must NEVER be reachable via the login flow — even with a correct
      // password. We respond with the same generic 401 used for invalid
      // credentials to avoid leaking which usernames are system accounts via
      // response-message enumeration. We do, however, write a dedicated audit
      // entry: any attempt to log into a system account is itself a signal
      // worth alerting on.
      if (user.role === "system") {
        await writeAuditLog(
          user.id,
          "login_blocked_system_account",
          "user",
          String(user.id),
          { username },
          req.ip || null
        );
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const valid = await verifyPassword(password, user.password);
      if (!valid) {
        await writeAuditLog(user.id, "login_failed", "user", String(user.id), { username }, req.ip || null);
        return res.status(401).json({ error: "Invalid credentials" });
      }
      // Block login until email is verified
      if (!user.emailVerified) {
        return res.status(403).json({
          code: "email_not_verified",
          error: "Please verify your email address before signing in.",
          email: user.email,
        });
      }
      const token = signToken({ userId: user.id, username: user.username, email: user.email, role: user.role });
      await writeAuditLog(user.id, "login", "user", String(user.id), { username }, req.ip || null);
      res.json({ token, user: { id: user.id, username: user.username, email: user.email, firstName: user.firstName, lastName: user.lastName, kycStatus: user.kycStatus, userTier: user.userTier, role: user.role } });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password, firstName, lastName } = req.body;
      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({ error: "All fields are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email address" });
      }
      const existingEmail = await storage.getUserByEmail(email);
      if (existingEmail) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      const application = await storage.getApplicationByEmail(email);
      if (!application || application.status !== "approved") {
        return res.status(403).json({ error: "Account creation requires an approved application. Please apply first." });
      }
      // Defensive cross-check: an approved application MUST have email_verified=true.
      // The approval gate enforces this, but verifying here protects against any future
      // path that might mark an application "approved" without the verification step.
      if (!application.emailVerified) {
        return res.status(403).json({ error: "Application email is not verified. Please verify your email first." });
      }
      // Email was already verified during the application step — approval cannot occur otherwise.
      // The user inherits emailVerified=true and skips a second OTP round-trip.
      const username = email.split("@")[0] + "_" + Date.now().toString(36);
      const existingUsername = await storage.getUserByUsername(username);
      if (existingUsername) {
        return res.status(409).json({ error: "Please try again" });
      }
      const hashed = await hashPassword(password);
      const user = await storage.createUser({
        username,
        email: email.toLowerCase(),
        password: hashed,
        firstName,
        lastName,
        kycStatus: "pending",
        userTier: "standard",
      });
      await storage.createPortfolio({
        userId: user.id,
        totalValue: "0.00",
        cryptoValue: "0.00",
        stablecoinValue: "0.00",
        fiatValue: "0.00",
        investmentValue: "0.00",
        monthlyPnl: "0.00",
        monthlyPnlPercent: "0.00",
      });
      // Inherit verified status from the application — issue session token immediately.
      await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
      const token = signToken({ userId: user.id, username: user.username, email: user.email, role: user.role });
      await writeAuditLog(user.id, "account_created", "user", String(user.id), { email, authProvider: "email" }, req.ip || null);
      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          emailVerified: true,
        },
        token,
      });
    } catch (error: any) {
      console.error("Registration error:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  // ---------------------------------------------------------------------------
  // Email verification — OTP entry, link click, resend
  // ---------------------------------------------------------------------------

  // Brute-force protection: 6-digit OTP has only 1M combinations
  const otpVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Please request a new code and try again in a few minutes." },
  });
  // SMTP-cost protection on resend endpoints
  const otpResendLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many resend requests. Please wait a few minutes before requesting another code." },
  });

  // OTP helpers — short expiry, hashed at rest, capped attempts.
  const OTP_EXPIRY_MS = 15 * 60 * 1000;
  const OTP_MAX_ATTEMPTS = 5;
  const hashOtp = (code: string) => createHash("sha256").update(code).digest("hex");
  const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  // Verify by 6-digit OTP code (public — used right after register)
  app.post("/api/auth/verify-otp", otpVerifyLimiter, async (req, res) => {
    try {
      const { email, otp } = req.body ?? {};
      if (!email || !otp) return res.status(400).json({ error: "Email and code are required" });
      const normalized = String(email).trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, normalized));
      if (!user) return res.status(404).json({ error: "No account found for this email" });
      // Already-verified accounts must not receive a token from an unauthenticated
      // OTP submit (would be account-takeover-by-email). Force them through /login.
      if (user.emailVerified) {
        return res.status(400).json({ error: "This email is already verified. Please sign in." });
      }
      if (!user.emailOtp || user.emailOtp !== String(otp).trim()) {
        return res.status(400).json({ error: "Invalid verification code" });
      }
      if (!user.emailVerificationTokenExpiry || new Date(user.emailVerificationTokenExpiry) < new Date()) {
        return res.status(400).json({ error: "Verification code expired. Please request a new one." });
      }
      await db.update(users).set({
        emailVerified: true,
        emailOtp: null,
        emailVerificationToken: null,
        emailVerificationTokenExpiry: null,
      }).where(eq(users.id, user.id));
      await writeAuditLog(user.id, "email_verified", "user", String(user.id), { method: "otp" }, req.ip || null);
      const token = signToken({ userId: user.id, username: user.username, email: user.email, role: user.role });
      res.json({
        token,
        user: { id: user.id, username: user.username, email: user.email, firstName: user.firstName, lastName: user.lastName, kycStatus: user.kycStatus, userTier: user.userTier, emailVerified: true },
      });
    } catch (error: any) {
      console.error("verify-otp error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // Resend OTP / verification email (public — by email address)
  app.post("/api/auth/resend-otp", otpResendLimiter, async (req, res) => {
    try {
      const { email } = req.body ?? {};
      if (!email) return res.status(400).json({ error: "Email is required" });
      const normalized = String(email).trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, normalized));
      // Always return 200 to avoid leaking which emails exist
      if (!user || user.emailVerified) {
        return res.json({ ok: true, ...(user?.emailVerified ? { alreadyVerified: true } : {}) });
      }
      const verifyToken = randomBytes(32).toString("hex");
      const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.update(users).set({
        emailVerificationToken: verifyToken,
        emailVerificationTokenExpiry: expiry,
        emailOtp: newOtp,
      }).where(eq(users.id, user.id));
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      await sendVerificationEmail(user.email, user.firstName, verifyToken, newOtp, baseUrl).catch((err) => {
        console.error("[resend-otp] sendVerificationEmail failed:", err?.message);
      });
      res.json({
        ok: true,
        emailSent: emailConfigured,
        ...(!emailConfigured ? { devOtp: newOtp } : {}),
      });
    } catch (error: any) {
      console.error("resend-otp error:", error);
      res.status(500).json({ error: "Failed to resend code" });
    }
  });

  // Resend for already-authenticated user (e.g. user is logged in but unverified)
  app.post("/api/auth/resend-verification", otpResendLimiter, async (req, res) => {
    try {
      const auth = requireAuth(req);
      const user = await storage.getUser(auth.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
      const verifyToken = randomBytes(32).toString("hex");
      const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.update(users).set({
        emailVerificationToken: verifyToken,
        emailVerificationTokenExpiry: expiry,
        emailOtp: newOtp,
      }).where(eq(users.id, user.id));
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      await sendVerificationEmail(user.email, user.firstName, verifyToken, newOtp, baseUrl).catch((err) => {
        console.error("[resend-verification] sendVerificationEmail failed:", err?.message);
      });
      res.json({ ok: true, emailSent: emailConfigured, ...(!emailConfigured ? { devOtp: newOtp } : {}) });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to resend verification" });
    }
  });

  // Verify by clicking the link in the email (GET — redirects to /verify-email page with status)
  app.get("/api/auth/verify-email", async (req, res) => {
    const token = String(req.query.token || "");
    if (!token) return res.redirect("/verify-email?status=invalid");
    try {
      const [user] = await db.select().from(users).where(eq(users.emailVerificationToken, token));
      if (!user) return res.redirect("/verify-email?status=invalid");
      if (user.emailVerified) return res.redirect("/verify-email?status=already");
      if (!user.emailVerificationTokenExpiry || new Date(user.emailVerificationTokenExpiry) < new Date()) {
        return res.redirect(`/verify-email?status=expired&email=${encodeURIComponent(user.email)}`);
      }
      await db.update(users).set({
        emailVerified: true,
        emailOtp: null,
        emailVerificationToken: null,
        emailVerificationTokenExpiry: null,
      }).where(eq(users.id, user.id));
      await writeAuditLog(user.id, "email_verified", "user", String(user.id), { method: "link" }, req.ip || null);
      return res.redirect("/verify-email?status=success");
    } catch (error: any) {
      console.error("verify-email link error:", error);
      return res.redirect("/verify-email?status=error");
    }
  });

  // ---------------------------------------------------------------------------
  // Flow A — public lead capture (wizard email opt-in)
  // Public, unauthenticated. Zod validated, rate limited per IP, upserts on email.
  // ---------------------------------------------------------------------------
  const leadCaptureLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 min
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again in a few minutes." },
  });

  // Server is authoritative for recommendation + privateAccess — answers only.
  const leadSubmitSchema = z.object({
    email: z.string().email().max(255),
    profileType: z.enum(["individual", "family_office", "corporate", "international"]),
    goals: z.array(z.string().max(50)).min(1).max(10),
    riskTolerance: z.enum(["conservative", "balanced", "growth", "high_growth"]),
    timeHorizon: z.enum(["short", "medium", "long"]),
    capitalRange: z.enum(["under_10k", "10k_100k", "100k_500k", "500k_plus"]),
    // Honeypot — silently drop submissions where this is filled
    website: z.string().optional(),
  });

  app.post("/api/leads", leadCaptureLimiter, async (req, res) => {
    try {
      const parsed = leadSubmitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid submission", details: parsed.error.flatten() });
      }
      // Honeypot filled — pretend success without persisting
      if (parsed.data.website && parsed.data.website.length > 0) {
        return res.status(201).json({ ok: true });
      }
      // Recompute recommendation server-side. Never trust client-supplied
      // strategy or privateAccess values — they gate compliance behaviour.
      const rec = getRecommendation({
        profileType: parsed.data.profileType,
        goals: parsed.data.goals,
        riskTolerance: parsed.data.riskTolerance,
        timeHorizon: parsed.data.timeHorizon,
        capitalRange: parsed.data.capitalRange,
      });
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
      const emailLower = parsed.data.email.toLowerCase();
      // Atomic upsert — last-write-wins for the same email so updated answers persist.
      await db.insert(leads).values({
        email: emailLower,
        profileType: parsed.data.profileType,
        goals: parsed.data.goals,
        riskTolerance: parsed.data.riskTolerance,
        timeHorizon: parsed.data.timeHorizon,
        capitalRange: parsed.data.capitalRange,
        recommendedStrategy: rec.strategy,
        privateAccess: rec.privateAccess,
        source: "flow_a",
        ipAddress: ip,
      }).onConflictDoUpdate({
        target: leads.email,
        set: {
          profileType: parsed.data.profileType,
          goals: parsed.data.goals,
          riskTolerance: parsed.data.riskTolerance,
          timeHorizon: parsed.data.timeHorizon,
          capitalRange: parsed.data.capitalRange,
          recommendedStrategy: rec.strategy,
          privateAccess: rec.privateAccess,
          ipAddress: ip,
          updatedAt: new Date(),
        },
      });
      // Don't return id or hint at whether the email was new
      res.status(201).json({ ok: true });
    } catch (error) {
      console.error("Lead capture error:", error);
      res.status(500).json({ error: "Failed to save profile" });
    }
  });

  // Funnel events — best-effort analytics for Flow A. High write volume so a
  // separate, more permissive limiter. Validation is strict on event name to
  // keep the table queryable.
  const funnelLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many events" },
  });

  const funnelEventSchema = z.object({
    event: z.enum([
      "flow_a_step_view",
      "flow_a_step_complete",
      "flow_a_recommendation_view",
      "lead_captured",
      "apply_started",
      "apply_submitted",
    ]),
    sessionId: z.string().min(4).max(64),
    path: z.string().max(120).nullable().optional(),
    // Cap metadata to prevent table bloat — small key/value bag only.
    metadata: z
      .record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
      .refine((m) => Object.keys(m).length <= 10, "Too many keys")
      .nullable()
      .optional(),
  });

  app.post("/api/funnel", funnelLimiter, async (req, res) => {
    try {
      const parsed = funnelEventSchema.safeParse(req.body);
      if (!parsed.success) {
        // Don't 4xx loudly — analytics should never look like a bug to the client.
        return res.status(204).end();
      }
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      // Fire-and-forget on the server too — don't await before responding.
      db.insert(funnelEvents).values({
        event: parsed.data.event,
        sessionId: parsed.data.sessionId,
        path: parsed.data.path ?? null,
        metadata: (parsed.data.metadata ?? null) as any,
        ipAddress: ip,
        userAgent: ua ? ua.slice(0, 500) : null,
      }).catch((err) => console.error("Funnel insert failed:", err));
      res.status(204).end();
    } catch (error) {
      console.error("Funnel event error:", error);
      res.status(204).end();
    }
  });

  app.post("/api/applications", async (req, res) => {
    try {
      const { fullName, email, phone, country, accountType, entityName, abn, intendedUse } = req.body;
      if (!fullName || !email || !phone || !country || !accountType || !intendedUse) {
        return res.status(400).json({ error: "All required fields must be completed" });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email address" });
      }
      const normalizedEmail = email.toLowerCase().trim();
      const existing = await storage.getApplicationByEmail(normalizedEmail);
      if (existing) {
        return res.status(409).json({ error: "An application with this email already exists", status: existing.status });
      }
      const existingUser = await storage.getUserByEmail(normalizedEmail);
      if (existingUser) {
        return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
      }
      const { consentOwnBehalf, consentAmlCtf, consentContact: consentContactFlag, consentGeneralAdvice } = req.body;
      if (!consentOwnBehalf || !consentAmlCtf || !consentContactFlag || !consentGeneralAdvice) {
        return res.status(400).json({ error: "All compliance acknowledgements are required" });
      }

      // Generate OTP for email verification — application stays in `email_unverified`
      // until the applicant proves they own the email address. We store only the hash
      // of the code (not the plaintext) and enforce a short 15-minute expiry.
      const otp = generateOtp();
      const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MS);

      const application = await storage.createApplication({
        fullName,
        email: normalizedEmail,
        phone,
        country,
        accountType,
        entityName: entityName || null,
        abn: abn || null,
        intendedUse,
        consentOwnBehalf: true,
        consentAmlCtf: true,
        consentContact: true,
        consentGeneralAdvice: true,
        status: "email_unverified",
        reviewNote: null,
        emailVerified: false,
        emailOtp: hashOtp(otp),
        emailOtpExpiry: otpExpiry,
        emailOtpAttempts: 0,
      });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const firstName = fullName.split(" ")[0] || "there";
      // No link-token here — application verification is OTP-only.
      let emailSent = false;
      let emailError: string | null = null;
      try {
        const result = await sendVerificationEmail(normalizedEmail, firstName, "", otp, baseUrl);
        emailSent = result.sent;
      } catch (err: any) {
        emailError = err?.message || "Email delivery failed";
        console.error("[applications] sendVerificationEmail failed:", emailError);
      }

      res.status(201).json({
        id: application.id,
        status: application.status,
        requiresEmailVerification: true,
        emailSent,
        ...(emailError ? { emailError } : {}),
        // In dev, expose the OTP so the user can complete the flow when SMTP is misconfigured.
        ...(isLocalDev && !emailSent ? { devOtp: otp } : {}),
      });
    } catch (error: any) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "An application with this email already exists" });
      }
      console.error("Application error:", error);
      res.status(500).json({ error: "Failed to submit application" });
    }
  });

  // Verify the email on a submitted application (moves it from email_unverified → submitted)
  app.post("/api/applications/verify-otp", otpVerifyLimiter, async (req, res) => {
    try {
      const { email, otp } = req.body ?? {};
      if (!email || !otp) return res.status(400).json({ error: "Email and code are required" });
      const normalized = String(email).trim().toLowerCase();
      const application = await storage.getApplicationByEmail(normalized);
      if (!application) return res.status(404).json({ error: "No application found for this email" });
      if (application.emailVerified) {
        return res.json({ ok: true, alreadyVerified: true, status: application.status });
      }
      // Lock after too many failed attempts — applicant must request a fresh code.
      if ((application.emailOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS) {
        return res.status(429).json({ error: "Too many incorrect attempts. Please request a new verification code." });
      }
      // Expiry first — fail loudly so the user knows to resend instead of guessing.
      if (!application.emailOtpExpiry || new Date(application.emailOtpExpiry) < new Date()) {
        return res.status(400).json({ error: "Verification code expired. Please request a new one." });
      }
      const submittedHash = hashOtp(String(otp).trim());
      if (!application.emailOtp || application.emailOtp !== submittedHash) {
        // Increment attempts on every failure; expose remaining attempts so the UI can warn.
        const newAttempts = (application.emailOtpAttempts ?? 0) + 1;
        await db.update(applicationsTable)
          .set({ emailOtpAttempts: newAttempts })
          .where(eq(applicationsTable.id, application.id));
        const remaining = Math.max(0, OTP_MAX_ATTEMPTS - newAttempts);
        return res.status(400).json({
          error: remaining > 0
            ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
            : "Too many incorrect attempts. Please request a new verification code.",
          attemptsRemaining: remaining,
        });
      }
      // Move into the review queue + clear the secret material.
      await db.update(applicationsTable).set({
        emailVerified: true,
        emailOtp: null,
        emailOtpExpiry: null,
        emailOtpAttempts: 0,
        status: "submitted",
      }).where(eq(applicationsTable.id, application.id));
      res.json({ ok: true, status: "submitted" });
    } catch (error: any) {
      console.error("application verify-otp error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // Resend OTP for an unverified application
  app.post("/api/applications/resend-otp", otpResendLimiter, async (req, res) => {
    try {
      const { email } = req.body ?? {};
      if (!email) return res.status(400).json({ error: "Email is required" });
      const normalized = String(email).trim().toLowerCase();
      const application = await storage.getApplicationByEmail(normalized);
      if (!application || application.emailVerified) {
        return res.json({ ok: true, ...(application?.emailVerified ? { alreadyVerified: true } : {}) });
      }
      const newOtp = generateOtp();
      const expiry = new Date(Date.now() + OTP_EXPIRY_MS);
      // Resending also resets the attempt counter so the user gets a clean 5 attempts.
      await db.update(applicationsTable)
        .set({ emailOtp: hashOtp(newOtp), emailOtpExpiry: expiry, emailOtpAttempts: 0 })
        .where(eq(applicationsTable.id, application.id));
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const firstName = (application.fullName || "").split(" ")[0] || "there";
      let emailSent = false;
      let emailError: string | null = null;
      try {
        const result = await sendVerificationEmail(normalized, firstName, "", newOtp, baseUrl);
        emailSent = result.sent;
      } catch (err: any) {
        emailError = err?.message || "Email delivery failed";
        console.error("[applications resend] sendVerificationEmail failed:", emailError);
      }
      res.json({
        ok: true,
        emailSent,
        ...(emailError ? { emailError } : {}),
        ...(isLocalDev && !emailSent ? { devOtp: newOtp } : {}),
      });
    } catch (error: any) {
      console.error("application resend-otp error:", error);
      res.status(500).json({ error: "Failed to resend code" });
    }
  });

  app.get("/api/applications/status/:email", async (req, res) => {
    try {
      const email = decodeURIComponent(req.params.email);
      const application = await storage.getApplicationByEmail(email);
      if (!application) {
        return res.status(404).json({ error: "No application found for this email" });
      }
      res.json({
        status: application.status,
        fullName: application.fullName,
        email: application.email,
        createdAt: application.createdAt,
        reviewedAt: application.reviewedAt,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to check application status" });
    }
  });

  // Demo-only self-approval. In production, this would be an admin-only action
  // gated behind admin auth + audit logging. Restricted to local dev to prevent
  // unauthorized approval in deployed environments.
  app.post("/api/applications/approve/:email", async (req, res) => {
    if (!isLocalDev) {
      return res.status(403).json({ error: "Application approval is admin-only and not available in this environment." });
    }
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase();
      const application = await storage.getApplicationByEmail(email);
      if (!application) {
        return res.status(404).json({ error: "No application found" });
      }
      if (!application.emailVerified) {
        return res.status(409).json({
          error: "Cannot approve: applicant has not verified their email address yet.",
          status: application.status,
        });
      }
      const updated = await storage.updateApplicationStatus(application.id, "approved");
      res.json({ status: updated?.status });
    } catch (error) {
      res.status(500).json({ error: "Failed to approve application" });
    }
  });

  // Current authenticated user
  app.get("/api/auth/me", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const user = await storage.getUser(auth.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
    } catch (error: any) {
      // Only pass through messages from errors we explicitly constructed (requireAuth uses .status).
      // Unexpected DB or runtime errors get a generic message to avoid leaking internal details.
      if (error?.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to retrieve account details" });
    }
  });

  // Logout (client drops the token; this endpoint logs the event server-side)
  app.post("/api/auth/logout", async (req, res) => {
    try {
      const auth = requireAuth(req);
      await writeAuditLog(auth.userId, "logout", "user", String(auth.userId), {}, req.ip || null);
      res.json({ success: true });
    } catch {
      res.json({ success: true }); // Always succeed — client drops token regardless
    }
  });

  // Get current user (auth-aware)
  app.get("/api/user", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const user = await storage.getUser(auth.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { password: _, ...safeUser } = user;
      return res.json(safeUser);
    } catch (error: any) {
      if (error?.status === 401) {
        return res.status(401).json({ error: error.message || "Unauthorized" });
      }
      return res.status(500).json({ error: "Failed to get user" });
    }
  });

  // Get user portfolio — all values computed from the single shared valuation engine
  app.get("/api/portfolio", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const now = new Date();

      // One call to the shared engine — no duplicated FX/investment loops
      const totals = await calculatePortfolioTotalsAtDate(userId, now);
      const { fiatValue, cryptoValue, stablecoinValue, investmentValue, totalValue,
              hasUnpricedWallets, unpricedCurrencies } = totals;

      // Always upsert today's "actual" snapshot with the current live value.
      // Delete any stale snapshot from earlier today (could be from a previous session
      // when wallet/investment balances were different) then recreate fresh.
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().split('T')[0];
      await storage.deletePortfolioSnapshotsForDay(userId, todayStr);
      await storage.createPortfolioSnapshot({
        userId,
        totalValue: totalValue.toFixed(2),
        fiatValue: fiatValue.toFixed(2),
        cryptoValue: cryptoValue.toFixed(2),
        stablecoinValue: stablecoinValue.toFixed(2),
        investmentValue: investmentValue.toFixed(2),
        snapshotDate: now,
        source: "actual" as SnapshotSource,
      });
      let allSnapshots = await storage.getPortfolioSnapshots(userId);

      // Monthly P&L: compare current value against snapshot closest to 30 days ago
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const priorSnapshot = allSnapshots
        .filter(s => new Date(s.snapshotDate) <= thirtyDaysAgo)
        .sort((a, b) => new Date(b.snapshotDate).getTime() - new Date(a.snapshotDate).getTime())[0];

      let monthlyPnl: number | null = null;
      let monthlyPnlPercent: number | null = null;
      let monthlyPnlSource: 'actual' | 'historical_estimate' | 'insufficient_history' = 'insufficient_history';
      let monthlyPnlMethod: 'actual_30_day_comparison' | 'historical_inference' = 'historical_inference';

      if (priorSnapshot) {
        const priorValue = parseFloat(priorSnapshot.totalValue);
        monthlyPnl = totalValue - priorValue;
        monthlyPnlPercent = priorValue > 0 ? (monthlyPnl / priorValue) * 100 : 0;
        monthlyPnlSource = ((priorSnapshot as any).source === 'actual') ? 'actual' : 'historical_estimate';
        monthlyPnlMethod = ((priorSnapshot as any).source === 'actual') ? 'actual_30_day_comparison' : 'historical_inference';
      }

      res.json({
        id: 1,
        userId,
        totalValue: totalValue.toFixed(2),
        cryptoValue: cryptoValue.toFixed(2),
        stablecoinValue: stablecoinValue.toFixed(2),
        fiatValue: fiatValue.toFixed(2),
        investmentValue: investmentValue.toFixed(2),
        monthlyPnl: monthlyPnl !== null ? monthlyPnl.toFixed(2) : null,
        monthlyPnlPercent: monthlyPnlPercent !== null ? monthlyPnlPercent.toFixed(2) : null,
        monthlyPnlSource,
        monthlyPnlMethod,
        // Valuation completeness flags — consumers should warn users when true
        hasUnpricedWallets,
        unpricedCurrencies,
        updatedAt: now,
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get portfolio" });
    }
  });

  // Get portfolio historical performance based on actual transactions
  app.get("/api/portfolio/history", async (req, res) => {
    try {
      const { timeframe = "1M" } = req.query;
      const { userId } = requireAuth(req);
      
      // Calculate date range based on timeframe
      const endDate = new Date();
      const startDate = new Date();
      
      switch (timeframe) {
        case "1M":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "3M":
          startDate.setMonth(startDate.getMonth() - 3);
          break;
        case "1Y":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        default:
          startDate.setMonth(startDate.getMonth() - 1);
      }
      
      // Current live value — use the shared engine (same as /api/portfolio)
      const { totalValue: currentTotalValue } = await calculatePortfolioTotalsAtDate(userId, endDate);

      // --- Build data points from stored snapshots ---
      const storedSnapshots = await storage.getPortfolioSnapshots(userId, startDate, endDate);
      const todayStr = endDate.toISOString().split('T')[0];

      // Thin stored snapshots to ~22 evenly-spaced points
      let thinned: typeof storedSnapshots = [];
      if (storedSnapshots.length >= 2) {
        const maxPoints = 22;
        const step = Math.max(1, Math.floor(storedSnapshots.length / (maxPoints - 1)));
        for (let i = 0; i < storedSnapshots.length - 1; i += step) {
          thinned.push(storedSnapshots[i]);
        }
        thinned.push(storedSnapshots[storedSnapshots.length - 1]);
      } else {
        thinned = [...storedSnapshots];
      }

      // Map to data points, stripping any today-dated entries (we'll inject the live value instead)
      let dataPoints: Array<{ date: string; value: number; timestamp: number; source: string }> = thinned
        .filter(s => s.snapshotDate.toISOString().split('T')[0] !== todayStr)
        .map(s => ({
          date: s.snapshotDate.toISOString().split('T')[0],
          value: Math.round(parseFloat(s.totalValue)),
          timestamp: s.snapshotDate.getTime(),
          source: (s as any).source ?? 'actual',
        }));

      // Always append the live current value as today's final point.
      // This ensures period return calculations use accurate current data,
      // not a stale snapshot saved during a previous session.
      dataPoints.push({
        date: todayStr,
        value: Math.round(currentTotalValue),
        timestamp: endDate.getTime(),
        source: 'actual',
      });

      // Performance metrics — start from the oldest data point, end at today's live value
      const startValue = dataPoints[0]?.value ?? currentTotalValue;
      const endValue = Math.round(currentTotalValue); // always the live value
      const totalReturn = endValue - startValue;
      const totalReturnPercent = startValue > 0 ? (totalReturn / startValue) * 100 : 0;
      const historySource = dataPoints.some(d => d.source === 'historical_estimate')
        ? 'historical_estimate' : 'actual';

      // Reviewer-mandated integrity rule: with only one snapshot, the live value
      // and the start value are the same point — totalReturn would always be 0.
      // Returning "0.00" would imply the user has measured "no return" over the
      // period, which is a fabricated performance claim. Return null instead so
      // the UI can show "Insufficient history" rather than a fake zero.
      const hasSufficientHistory = dataPoints.length >= 2;

      res.json({
        timeframe,
        data: dataPoints,
        currentValue: currentTotalValue,
        totalReturn: hasSufficientHistory ? totalReturn.toFixed(2) : null,
        totalReturnPercent: hasSufficientHistory ? totalReturnPercent.toFixed(2) : null,
        startValue: startValue.toFixed(2),
        endValue: endValue.toFixed(2),
        historySource,
        hasSufficientHistory,
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Portfolio history error:", error);
      res.status(500).json({ error: "Failed to get portfolio history" });
    }
  });

  // Portfolio performance chart — two lines (historical + projected) from Jan 1, 2026
  app.get("/api/portfolio/performance-chart", async (req, res) => {
    try {
      const { timeframe = "1Y" } = req.query;
      const { userId } = requireAuth(req);
      const today = new Date();

      // Anchor = Jan 1 of current year
      const anchor = new Date(today.getFullYear(), 0, 1);
      anchor.setHours(0, 0, 0, 0);

      // Ensure backfilled history exists for the full anchor-to-today range
      await backfillPortfolioHistory(userId, anchor, today);

      // All historical points come from snapshots only — no wallet balance reconstruction
      const snapshots = await storage.getPortfolioSnapshots(userId, anchor, today);
      const sortedSnapshots = [...snapshots].sort(
        (a: any, b: any) =>
          new Date(a.snapshotDate).getTime() - new Date(b.snapshotDate).getTime()
      );

      // Group by month — keep the latest snapshot in each calendar month
      const historyByMonth = new Map<string, { value: number; source: string }>();
      for (const s of sortedSnapshots) {
        const d = new Date(s.snapshotDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        historyByMonth.set(key, {
          value: Math.round(parseFloat(s.totalValue)),
          source: (s as any).source ?? "actual",
        });
      }

      // Opening value = earliest real snapshot (not reconstructed from current wallets)
      const openingValue =
        sortedSnapshots.length > 0
          ? Math.round(parseFloat(sortedSnapshots[0].totalValue))
          : 0;

      // Forecast baseline = latest historical value
      const latestHistoricalValue =
        sortedSnapshots.length > 0
          ? Math.round(parseFloat(sortedSnapshots[sortedSnapshots.length - 1].totalValue))
          : openingValue;

      // Use realized CAGR when history is long enough; fall back to 10% otherwise
      let annualProjectionRate = 0.10;
      let projectionMethod = "fallback_default";
      if (sortedSnapshots.length >= 2) {
        const startVal  = parseFloat(sortedSnapshots[0].totalValue);
        const startDate = new Date(sortedSnapshots[0].snapshotDate);
        const years = (today.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (startVal > 0 && latestHistoricalValue > 0 && years >= 0.1) {
          const cagrRate = Math.pow(latestHistoricalValue / startVal, 1 / years) - 1;
          if (Number.isFinite(cagrRate)) {
            // Allow negative CAGR (declining portfolio); reject only non-finite values.
            // Clamp: floor at -95%/yr (near-total loss), ceiling at +100%/yr (double in a year).
            annualProjectionRate = Math.max(-0.95, Math.min(1.0, cagrRate));
            projectionMethod = "realized_cagr";
          }
        }
      }
      const forecastMonths =
        timeframe === "7Y" ? 84 :
        timeframe === "3Y" ? 36 :
        12;

      // --- Build historical monthly rows (anchor → today) ---
      const chartRows: Array<{
        month: string;
        historical: number | null;
        projected: number | null;
      }> = [];

      const cursor = new Date(anchor);
      while (cursor <= today) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
        const label = cursor.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        const entry = historyByMonth.get(key);
        chartRows.push({
          month: label,
          historical: entry ? entry.value : null,
          projected: null,
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }

      // If no Jan entry exists (snapshot is later in Jan), back-fill anchor row
      const anchorKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`;
      if (!historyByMonth.has(anchorKey) && chartRows.length > 0) {
        chartRows[0].historical = openingValue;
      }

      // Only add a forecast when we have a real CAGR derived from actual history.
      // A 10% "fallback default" with no data basis is assumption-based and must not be shown.
      const canForecast = projectionMethod === "realized_cagr";

      if (canForecast) {
        // Bridge: give the last historical row a projected value equal to today's portfolio value
        // so the forecast line starts exactly where the historical line ends (no gap).
        if (chartRows.length > 0 && latestHistoricalValue > 0) {
          chartRows[chartRows.length - 1].projected = latestHistoricalValue;
        }

        // --- Append forecast rows (i=1 = one month out, grows from the bridge point) ---
        for (let i = 1; i <= forecastMonths; i++) {
          const forecastDate = new Date(today);
          forecastDate.setMonth(forecastDate.getMonth() + i);
          const label = forecastDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
          const projected =
            latestHistoricalValue > 0
              ? Math.round(latestHistoricalValue * Math.pow(1 + annualProjectionRate, i / 12))
              : 0;
          chartRows.push({ month: label, historical: null, projected });
        }
      }

      const hasEstimateSource = snapshots.some((s: any) => s.source === 'historical_estimate');
      const chartSource = canForecast
        ? (hasEstimateSource ? 'historical_estimate_plus_forecast' : 'historical_plus_forecast')
        : (hasEstimateSource ? 'historical_estimate' : 'historical_only');

      res.json({
        timeframe,
        anchorDate: anchor.toISOString().split('T')[0],
        openingValue,
        projectionMethod,
        ...(canForecast ? { projectionRate: `${(annualProjectionRate * 100).toFixed(2)}% p.a.` } : {}),
        chartSource,
        data: chartRows,
      });
    } catch (e) {
      console.error("Performance chart error:", e);
      res.status(500).json({ error: "Failed to load performance chart" });
    }
  });

  // Investment value — full year from Jan 1 2026, month-by-month, historical + projected
  app.get("/api/investments/history-ytd", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
      const today = new Date();
      const TOTAL_MONTHS = 12; // Jan through Jan (13 points)

      const investments = await storage.getUserInvestments(userId);

      // Compute the opening investment value as of Jan 1, 2026
      let openingInvestmentValue = 0;
      for (const inv of investments) {
        const product = await storage.getInvestmentProduct(inv.productId);
        if (!product) continue;
        const investedAmount = parseFloat(inv.investedAmount);
        const investmentDate = new Date(inv.investmentDate ?? Date.now());
        const asOf = investmentDate <= ANCHOR ? ANCHOR : investmentDate;
        const perf = calculateInvestmentPerformance(product, investedAmount, investmentDate, asOf);
        openingInvestmentValue += perf.currentValue ?? 0;
      }

      // Projected line: use actual investment IRR — compute investment value at each month
      const getProjectedValueAt = async (targetDate: Date): Promise<number> => {
        let total = 0;
        for (const inv of investments) {
          const product = await storage.getInvestmentProduct(inv.productId);
          if (!product) continue;
          const investedAmount = parseFloat(inv.investedAmount);
          const investmentDate = new Date(inv.investmentDate ?? Date.now());
          const asOf = targetDate < investmentDate ? investmentDate : targetDate;
          const perf = calculateInvestmentPerformance(product, investedAmount, investmentDate, asOf);
          total += perf.currentValue ?? 0;
        }
        return Math.round(total);
      };

      // Historical line: real snapshot investment values, bucketed by month
      const snapshots = await storage.getPortfolioSnapshots(userId, ANCHOR, today);
      const historyByMonth = new Map<string, number>();
      for (const s of snapshots) {
        const d = new Date(s.snapshotDate);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        historyByMonth.set(key, Math.round(parseFloat(s.investmentValue)));
      }

      // Build merged monthly series
      const chartRows: Array<{ month: string; historical: number | null; projected: number }> = [];
      for (let m = 0; m <= TOTAL_MONTHS; m++) {
        const d = new Date(ANCHOR);
        d.setMonth(d.getMonth() + m);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        const projected = await getProjectedValueAt(d);

        let historical: number | null = null;
        if (d <= today) {
          if (m === 0) {
            historical = Math.round(openingInvestmentValue);
          } else if (historyByMonth.has(key)) {
            historical = historyByMonth.get(key)!;
          }
        }

        chartRows.push({ month: label, historical, projected });
      }

      const lastHistorical = chartRows.reduce<number | null>(
        (acc, r) => (r.historical !== null ? r.historical : acc), null
      );
      const totalReturnPercent = lastHistorical && openingInvestmentValue > 0
        ? ((lastHistorical - openingInvestmentValue) / openingInvestmentValue * 100).toFixed(2)
        : '0.00';

      res.json({
        anchorDate: '2026-01-01',
        openingValue: Math.round(openingInvestmentValue),
        projectionRate: 'actual IRR',
        data: chartRows,
        totalReturnPercent,
      });
    } catch (e) {
      console.error("Investment YTD history error:", e);
      res.status(500).json({ error: "Failed to load investment history" });
    }
  });

  // Get portfolio asset allocation — delegates entirely to the shared valuation engine
  app.get("/api/portfolio/allocation", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const totals = await calculatePortfolioTotalsAtDate(userId, new Date());
      const { fiatValue, cryptoValue, stablecoinValue, investmentValue, totalValue } = totals;

      res.json({
        fiat:       { value: fiatValue,        percentage: totalValue > 0 ? (fiatValue        / totalValue) * 100 : 0 },
        crypto:     { value: cryptoValue,       percentage: totalValue > 0 ? (cryptoValue      / totalValue) * 100 : 0 },
        stablecoin: { value: stablecoinValue,   percentage: totalValue > 0 ? (stablecoinValue  / totalValue) * 100 : 0 },
        investment: { value: investmentValue,   percentage: totalValue > 0 ? (investmentValue  / totalValue) * 100 : 0 },
        totalValue,
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get portfolio allocation" });
    }
  });

  // Real metrics for AI advisory — diversification score, expected return, rebalancing gap, period returns
  app.get("/api/portfolio/real-metrics", async (req, res) => {
    try {
      const { userId } = requireAuth(req);

      // Reuse the shared valuation engine for allocation fractions
      const totals = await calculatePortfolioTotalsAtDate(userId, new Date());
      const { fiatValue, cryptoValue, stablecoinValue, investmentValue, totalValue } = totals;

      // Get investment-level detail for hasUnpricedAssets flag
      const investmentTotals = await calculateInvestmentTotalsAtDate(userId, new Date());
      const hasUnpricedAssets = investmentTotals.hasUnpricedAssets;

      const alloc = {
        fiat:       totalValue > 0 ? fiatValue       / totalValue : 0,
        crypto:     totalValue > 0 ? cryptoValue     / totalValue : 0,
        stablecoin: totalValue > 0 ? stablecoinValue / totalValue : 0,
        investment: totalValue > 0 ? investmentValue / totalValue : 0,
      };

      // Diversification score — Herfindahl-Hirschman Index (HHI) based.
      // HHI = sum(wi²): 0.25 when all four classes are equally weighted, 1.0 when fully concentrated.
      // Score = (1 − (HHI − 0.25) / 0.75) × 100, clamped [0, 100].
      const hhi = alloc.fiat ** 2 + alloc.crypto ** 2 + alloc.stablecoin ** 2 + alloc.investment ** 2;
      const diversificationScore = Math.max(0, Math.min(100, (1 - (hhi - 0.25) / 0.75) * 100));

      // Investment-weighted contracted return — based solely on explicit product annualReturn
      // values stored in the DB (no asset-class assumption blending for fiat/crypto/stablecoin).
      // null when no investments have an explicit rate.
      const investments = await storage.getUserInvestments(userId);
      let weightedInvReturn = 0;
      let totalInvested = 0;
      for (const inv of investments) {
        const product = await storage.getInvestmentProduct(inv.productId);
        if (product?.annualReturn) {
          const amount = parseFloat(inv.investedAmount);
          weightedInvReturn += parseFloat(product.annualReturn.toString()) * amount;
          totalInvested += amount;
        }
      }
      const hasProductRateCoverage = totalInvested > 0;
      const contractedInvestmentReturn: number | null = hasProductRateCoverage
        ? +(weightedInvReturn / totalInvested * 100).toFixed(2)
        : null;

      // Rebalancing gap — one-sided turnover from equal-weight benchmark [0, 50%]
      const rebalancingGap = 0.5 * (
        Math.abs(alloc.fiat       - 0.25) +
        Math.abs(alloc.crypto     - 0.25) +
        Math.abs(alloc.stablecoin - 0.25) +
        Math.abs(alloc.investment - 0.25)
      ) * 100;

      // Snapshot history for period returns
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      yearStart.setHours(0, 0, 0, 0);
      const snapshots = await storage.getPortfolioSnapshots(userId, yearStart, now);
      const sorted = [...snapshots].sort(
        (a: any, b: any) => new Date(a.snapshotDate).getTime() - new Date(b.snapshotDate).getTime()
      );
      const historySource = sorted.some((s: any) => s.source === 'historical_estimate')
        ? 'historical_estimate' : 'actual';

      const latestValue = sorted.length > 0
        ? parseFloat(sorted[sorted.length - 1].totalValue)
        : totalValue;

      const computePeriodReturn = (lookbackMonths: number): number | null => {
        const cutoff = new Date(now);
        cutoff.setMonth(cutoff.getMonth() - lookbackMonths);
        const prior = sorted.filter((s: any) => new Date(s.snapshotDate) <= cutoff);
        if (!prior.length) return null;
        const base = parseFloat(prior[prior.length - 1].totalValue);
        return base > 0 ? (latestValue - base) / base * 100 : null;
      };

      // Patch 1 — configurable risk-free rate (annualised).  Default: 4 % p.a.
      const riskFreeAnnual = parseFloat(process.env.RISK_FREE_RATE || "0.04");

      // YTD simple return (arithmetic, consistent framework — Patch 4)
      const ytdRaw = sorted.length >= 2
        ? (latestValue - parseFloat(sorted[0].totalValue)) / parseFloat(sorted[0].totalValue) * 100
        : null;

      // Patch 2 — CAGR with stability guard.
      // For very short periods (< 0.1 years ≈ 5 weeks) annualisation is unstable;
      // fall back to the simple cumulative return instead.
      let cagr: number | null = null;
      if (sorted.length >= 2) {
        const startVal  = parseFloat(sorted[0].totalValue);
        const startDate = new Date(sorted[0].snapshotDate);
        const years = (now.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (startVal > 0 && latestValue > 0) {
          cagr = years < 0.1
            ? +((latestValue / startVal - 1) * 100).toFixed(2)           // simple return
            : +(( Math.pow(latestValue / startVal, 1 / years) - 1) * 100).toFixed(2); // CAGR
        }
      }

      // ── Risk metric computation (arithmetic returns, consistent framework) ──────
      // Compute daily arithmetic returns from the portfolio value time series.
      // All snapshots (estimated or actual) contribute; per-metric guards below
      // decide whether each statistic is meaningful enough to surface.
      const dailyReturns: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const v0 = parseFloat(sorted[i - 1].totalValue);
        const v1 = parseFloat(sorted[i].totalValue);
        if (v0 > 0) dailyReturns.push((v1 - v0) / v0);
      }

      const _mean = (arr: number[]): number =>
        arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
      const _stddev = (arr: number[], mu: number): number => {
        if (arr.length < 2) return 0;
        return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1));
      };

      const returnMean = _mean(dailyReturns);
      const returnStd  = _stddev(dailyReturns, returnMean);
      const riskFreeDaily = riskFreeAnnual / 365;

      // Sharpe — requires enough returns AND non-trivial volatility
      // (returnStd ≤ 0.0001 daily ≈ smooth backfill → guard fires → null)
      const canShowSharpe =
        dailyReturns.length >= 20 &&
        Number.isFinite(returnStd)  &&
        Number.isFinite(returnMean) &&
        returnStd > 0.0001;
      const sharpe: number | null = canShowSharpe
        ? +(((returnMean - riskFreeDaily) / returnStd) * Math.sqrt(365)).toFixed(2)
        : null;

      // Volatility — same threshold as Sharpe; near-zero stddev (smooth backfill) → null
      const canShowVolatility =
        dailyReturns.length >= 20 &&
        Number.isFinite(returnStd) &&
        returnStd > 0.0001;
      const annualizedVolatility: number | null = canShowVolatility
        ? +(returnStd * Math.sqrt(365) * 100).toFixed(2)
        : null;

      // Max drawdown — only meaningful when a real peak→trough event exists
      let hasDrawdownEvent = false;
      {
        let peak = sorted.length > 0 ? parseFloat(sorted[0].totalValue) : 0;
        for (const s of sorted) {
          const v = parseFloat(s.totalValue);
          if (v < peak) { hasDrawdownEvent = true; break; }
          if (v > peak) peak = v;
        }
      }
      const canShowDrawdown = sorted.length >= 20 && hasDrawdownEvent;
      let maxDrawdown: number | null = null;
      if (canShowDrawdown) {
        let peak = parseFloat(sorted[0].totalValue);
        let maxDD = 0;
        for (const s of sorted) {
          const v = parseFloat(s.totalValue);
          if (v > peak) peak = v;
          const dd = peak > 0 ? (peak - v) / peak : 0;
          if (dd > maxDD) maxDD = dd;
        }
        maxDrawdown = +(maxDD * 100).toFixed(2);
      }

      // 3-tier state — drives UI messaging
      const hasMeaningfulHistory = sorted.length >= 30 && dailyReturns.length >= 20;
      const canComputeRiskMetrics = hasMeaningfulHistory;
      let riskMetricsState: "limited" | "estimated" | "historical";
      if (!hasMeaningfulHistory) {
        riskMetricsState = "limited";
      } else if (historySource === "historical_estimate") {
        riskMetricsState = "estimated";
      } else {
        riskMetricsState = "historical";
      }

      // Keep legacy fields for backward compatibility
      const hasSufficientHistory = sorted.length >= 30;
      const actualSnapshotCount  = sorted.filter((s: any) => s.source === "actual").length;

      res.json({
        diversificationScore: +diversificationScore.toFixed(1),
        // contractedInvestmentReturn: weighted average of explicit product annualReturn rates from DB.
        // null when no investments have explicit rates. Does NOT include assumption-based
        // rates for fiat/crypto/stablecoin asset classes.
        contractedInvestmentReturn,
        hasProductRateCoverage,
        rebalancingGap: +rebalancingGap.toFixed(1),
        historySource,
        hasSufficientHistory,
        hasMeaningfulHistory,
        snapshotCount: sorted.length,
        actualSnapshotCount,
        canComputeRiskMetrics,
        riskMetricsState,
        hasUnpricedAssets,
        sharpe,
        annualizedVolatility,
        maxDrawdown,
        cagr,
        riskFreeRate: +(riskFreeAnnual * 100).toFixed(2),
        periodReturns: {
          ytd:        ytdRaw !== null ? +ytdRaw.toFixed(2) : null,
          oneMonth:   computePeriodReturn(1) !== null ? +computePeriodReturn(1)!.toFixed(2) : null,
          threeMonth: computePeriodReturn(3) !== null ? +computePeriodReturn(3)!.toFixed(2) : null,
        },
        allocation: {
          fiat:       +(alloc.fiat       * 100).toFixed(1),
          crypto:     +(alloc.crypto     * 100).toFixed(1),
          stablecoin: +(alloc.stablecoin * 100).toFixed(1),
          investment: +(alloc.investment * 100).toFixed(1),
        },
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Real metrics error:", error);
      res.status(500).json({ error: "Failed to compute real metrics" });
    }
  });

  // Diagnostic: expose the in-memory system event log for integrity monitoring
  // Returns the last MAX_SYSTEM_EVENTS entries (most recent first)
  // Requires authentication — unauthenticated access would leak internal state.
  app.get("/api/system-events", async (req, res) => {
    try {
      requireAuth(req);
      res.json({ count: systemEventLog.length, events: systemEventLog });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to retrieve system events" });
    }
  });

  // Get user wallets
  app.get("/api/wallets", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const wallets = await storage.getWallets(userId);
      res.json(wallets);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get wallets" });
    }
  });

  // ---------------------------------------------------------------------------
  // Track B (Session 7): Derived ledger balance — distinct from /api/wallets.
  // /api/wallets returns the legacy cached balance (fast UX read).
  // /api/ledger/balances/:currency returns the SUM of posted ledger entries —
  // the source of truth for any reconciliation, audit, or compliance review.
  // The two should always agree once Track B fully replaces the legacy path.
  // ---------------------------------------------------------------------------
  app.get("/api/ledger/balances/:currency", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const { currency } = req.params;
      if (!currency || !/^[A-Za-z]{3,10}$/.test(currency)) {
        return res.status(400).json({ error: "Invalid currency code" });
      }
      const { getUserCurrencyBalance } = await import("./services/ledger");
      const balance = await getUserCurrencyBalance(userId, currency);
      res.json({
        currency: currency.toUpperCase(),
        balance,
        source: "ledger_entries",
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Ledger balance error:", error);
      res.status(500).json({ error: "Failed to fetch ledger balance" });
    }
  });

  // Get user transactions
  app.get("/api/transactions", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const transactions = await storage.getTransactions(userId, limit);
      res.json(transactions);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get transactions" });
    }
  });

  // Get FX rates
  // Stale threshold — refresh runs every 15 min; if two cycles miss we flag as stale
  const FX_STALE_THRESHOLD_MS = 30 * 60 * 1000;

  function withStaleness(rate: any) {
    const updatedAt = rate.updatedAt ? new Date(rate.updatedAt) : null;
    const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : null;
    return {
      ...rate,
      rateAgeMinutes: ageMs !== null ? Math.floor(ageMs / 60_000) : null,
      isStale: ageMs !== null ? ageMs > FX_STALE_THRESHOLD_MS : false,
    };
  }

  app.get("/api/fx-rates", async (req, res) => {
    try {
      const rates = await storage.getFxRates();
      res.json(rates.map(withStaleness));
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get FX rates" });
    }
  });

  // Get specific FX rate
  app.get("/api/fx-rates/:base/:target", async (req, res) => {
    try {
      const { base, target } = req.params;
      const rate = await storage.getFxRate(base, target);
      if (!rate) {
        return res.status(404).json({ error: "FX rate not found" });
      }
      res.json(withStaleness(rate));
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get FX rate" });
    }
  });

  // Get AI recommendations
  app.get("/api/ai-recommendations", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const recommendations = await storage.getAiRecommendations(userId);
      res.json(recommendations);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get AI recommendations" });
    }
  });

  // Generate personalized AI recommendations based on risk profile
  app.post("/api/ai-recommendations/generate", async (req, res) => {
    try {
      const { riskTolerance, investmentHorizon, investmentGoal } = req.body;
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      // Get current portfolio allocation data
      const wallets = await storage.getWallets(userId);
      const investments = await storage.getUserInvestments(userId);
      
      // Calculate allocation categories
      let fiatValue = 0;
      let cryptoValue = 0;
      let stablecoinValue = 0;
      let investmentValue = 0;
      
      // Calculate fiat value in USD equivalent (FX-converted, same logic as /api/portfolio)
      for (const wallet of wallets.filter(w => w.walletType === 'fiat')) {
        const balance = parseFloat(wallet.balance);
        if (wallet.currency === 'USD') {
          fiatValue += balance;
        } else {
          const directRate = await storage.getFxRate(wallet.currency, 'USD');
          if (directRate) {
            fiatValue += balance * parseFloat(directRate.rate);
          } else {
            const inverseRate = await storage.getFxRate('USD', wallet.currency);
            if (inverseRate) {
              fiatValue += balance / parseFloat(inverseRate.rate);
            }
          }
        }
      }
      
      // Calculate crypto and stablecoin values
      for (const wallet of wallets.filter(w => w.walletType === 'crypto')) {
        const balance = parseFloat(wallet.balance);
        if (wallet.currency === "USDT" || wallet.currency === "USDC") {
          stablecoinValue += balance;
        } else {
          const rate = await storage.getFxRate(wallet.currency, "USD");
          if (rate) {
            cryptoValue += (balance * parseFloat(rate.rate));
          }
        }
      }
      
      // Calculate investment value with correct argument order
      const evaluationDate = new Date();
      for (const investment of investments) {
        const product = await storage.getInvestmentProduct(investment.productId);
        if (product) {
          const investedAmount = parseFloat(investment.investedAmount);
          const investmentDate = new Date(investment.investmentDate ?? Date.now());
          const performance = calculateInvestmentPerformance(product, investedAmount, investmentDate, evaluationDate);
          investmentValue += performance.currentValue ?? 0;
        }
      }
      
      const totalValue = fiatValue + cryptoValue + stablecoinValue + investmentValue;
      
      const currentAllocation = {
        crypto: totalValue > 0 ? (cryptoValue / totalValue) * 100 : 0,
        fiat: totalValue > 0 ? (fiatValue / totalValue) * 100 : 0,
        stablecoin: totalValue > 0 ? (stablecoinValue / totalValue) * 100 : 0,
        investment: totalValue > 0 ? (investmentValue / totalValue) * 100 : 0,
        totalValue,
      };

      // Patch 6: Rebalancing gap — sum of absolute deviations from an equal-weight benchmark,
      // scaled by 0.5 so the result is a "one-sided" turnover measure (0 = perfectly balanced).
      // currentAllocation values are percentages [0–100]; convert to fractions [0–1] first.
      const allocationFractions = {
        fiat:       currentAllocation.fiat       / 100,
        crypto:     currentAllocation.crypto     / 100,
        stablecoin: currentAllocation.stablecoin / 100,
        investment: currentAllocation.investment / 100,
      };
      const rebalancingGap = 0.5 * (
        Math.abs(allocationFractions.fiat       - 0.25) +
        Math.abs(allocationFractions.crypto     - 0.25) +
        Math.abs(allocationFractions.stablecoin - 0.25) +
        Math.abs(allocationFractions.investment - 0.25)
      );

      // Generate recommendations based on risk profile
      const recommendations: Array<{ userId: number; type: string; title: string; description: string; severity: string; isRead: boolean }> = [];
      
      // Risk-based portfolio recommendations
      if (riskTolerance <= 2) { // Conservative
        if (currentAllocation.crypto > 10) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Reduce Crypto Exposure",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) is high for a conservative profile. Consider reducing to 5-10% and increasing fixed income investments.`,
            severity: "warning",
            isRead: false,
          });
        }
        
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Increase Bond Allocation",
          description: "Consider allocating 60-70% to government bonds and high-grade corporate bonds for stable income generation.",
          severity: "info",
          isRead: false,
        });
      } else if (riskTolerance <= 4) { // Moderate
        if (currentAllocation.crypto > 20) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Moderate Crypto Rebalancing",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) exceeds moderate risk guidelines. Consider reducing to 15-20% for better risk management.`,
            severity: "info",
            isRead: false,
          });
        }
        
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Diversify with International Equities",
          description: "Consider adding 20-25% international equity exposure to reduce correlation with domestic markets.",
          severity: "info",
          isRead: false,
        });
      } else { // Aggressive
        if (currentAllocation.crypto < 15) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Increase Growth Exposure",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) is conservative. Consider increasing to 25-30% for higher growth potential.`,
            severity: "info",
            isRead: false,
          });
        }
        
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Consider Growth Equity Investments",
          description: "Your aggressive profile allows for higher allocation to growth stocks and venture capital opportunities.",
          severity: "info",
          isRead: false,
        });
      }
      
      // Investment goal-based recommendations
      if (investmentGoal === "preservation") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Capital Preservation Strategy",
          description: "Focus on high-grade bonds, treasury securities, and stable value funds to preserve capital while earning modest returns.",
          severity: "info",
          isRead: false,
        });
        
        if (currentAllocation.crypto > 5) {
          recommendations.push({
            userId,
            type: "risk_warning",
            title: "High Crypto Risk for Preservation Goal",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) is too high for capital preservation. Consider reducing to under 5%.`,
            severity: "warning",
            isRead: false,
          });
        }
      } else if (investmentGoal === "income") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Income Generation Focus",
          description: "Prioritize dividend-paying stocks, REITs, corporate bonds, and high-yield savings to generate steady income.",
          severity: "info",
          isRead: false,
        });
        
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Consider Dividend Aristocrats",
          description: "S&P 500 Dividend Aristocrats have increased dividends for 25+ consecutive years, providing reliable income.",
          severity: "info",
          isRead: false,
        });
      } else if (investmentGoal === "growth") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Growth Investment Strategy",
          description: "Focus on technology, healthcare, and emerging markets for long-term capital appreciation potential.",
          severity: "info",
          isRead: false,
        });
      } else if (investmentGoal === "aggressive") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Aggressive Growth Opportunities",
          description: "Consider small-cap growth stocks, venture capital, and higher crypto allocations for maximum growth potential.",
          severity: "info",
          isRead: false,
        });
        
        if (currentAllocation.crypto < 20) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Increase Crypto Allocation",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) is low for aggressive growth. Consider increasing to 20-30%.`,
            severity: "info",
            isRead: false,
          });
        }
      }
      
      // Time horizon recommendations
      if (investmentHorizon === "1-3") {
        recommendations.push({
          userId,
          type: "risk_warning",
          title: "Short-Term Horizon Adjustment",
          description: "With a 1-3 year horizon, prioritize liquidity and stability. Increase cash (15-20%) and high-grade bonds (50-60%).",
          severity: "warning",
          isRead: false,
        });
        
        if (currentAllocation.crypto > 10) {
          recommendations.push({
            userId,
            type: "risk_warning",
            title: "Crypto Risk for Short Timeline",
            description: `Your crypto allocation (${currentAllocation.crypto.toFixed(1)}%) is high for short-term goals. Consider reducing to 5-10%.`,
            severity: "warning",
            isRead: false,
          });
        }
      } else if (investmentHorizon === "3-5") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Medium-Term Balance",
          description: "Your 3-5 year horizon allows for moderate growth investments while maintaining some stability through bonds and cash.",
          severity: "info",
          isRead: false,
        });
      } else if (investmentHorizon === "5-10") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Long-Term Growth Focus",
          description: "Your 5-10 year horizon supports higher equity allocation and moderate alternative investments for compound growth.",
          severity: "info",
          isRead: false,
        });
      } else if (investmentHorizon === "10+") {
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Maximum Growth Potential",
          description: "Your 10+ year horizon allows for aggressive growth strategies including higher equity and alternative asset allocations.",
          severity: "info",
          isRead: false,
        });
        
        if (currentAllocation.crypto < 15) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Long-Term Crypto Opportunity",
            description: `Your long timeline allows for higher crypto exposure (${currentAllocation.crypto.toFixed(1)}% current). Consider 15-25% for growth.`,
            severity: "info",
            isRead: false,
          });
        }
      }
      
      // Append mandatory general advice warning to every recommendation description
      // (RG 244 — disclaimer alone does not make personal advice general; see compliance gate before execution)
      const GENERAL_ADVICE_WARNING = " — GENERAL ADVICE WARNING: This information is general advice only and does not consider your personal objectives, financial situation, or needs. Before acting, you must obtain a Statement of Advice (SOA) from a licensed adviser. AMAX Wealth does not authorise execution on any AI-generated insight without an issued SOA.";
      const decoratedRecommendations = recommendations.map(r => ({
        ...r,
        description: r.description + GENERAL_ADVICE_WARNING,
      }));

      // Supersede prior recommendations (mark as read) instead of deleting — preserves audit trail
      await storage.supersedeAiRecommendations(userId);
      for (const recommendation of decoratedRecommendations) {
        await storage.createAiRecommendation(recommendation);
      }

      res.json({
        success: true,
        recommendations: decoratedRecommendations,
        rebalancingGap: +(rebalancingGap * 100).toFixed(1),
        message: "AI recommendations generated successfully",
        disclaimer: "General advice only. Execution requires a Statement of Advice issued by a licensed adviser.",
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("AI recommendations error:", error);
      res.status(500).json({ error: "Failed to generate AI recommendations" });
    }
  });

  // ---------------------------------------------------------------------------
  // FX Exchange — atomic SERIALIZABLE transaction + Decimal + DB idempotency
  // ---------------------------------------------------------------------------
  app.post("/api/fx-exchange", moneyMovementLimiter, async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      const parsed = fxExchangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { fromCurrency, toCurrency, amount: rawAmount } = parsed.data;
      const amount = new Decimal(rawAmount);

      // DB-backed idempotency check
      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/fx-exchange", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      const rate = await storage.getFxRate(fromCurrency, toCurrency);
      if (!rate) return res.status(400).json({ error: "Exchange rate not available" });

      // Ensure target wallet exists before entering transaction
      const existingToWallet = await storage.getWallet(userId, toCurrency);
      if (!existingToWallet) {
        await storage.createWallet({
          userId, currency: toCurrency, balance: "0.00", availableBalance: "0.00",
          walletType: toCurrency === "BTC" || toCurrency === "ETH" ? "crypto" : "fiat",
        });
      }

      const exchangeRate = new Decimal(rate.rate);
      const converted = amount.mul(exchangeRate);
      const fee = converted.mul("0.005");
      const netConverted = converted.minus(fee);

      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

        const [fromWallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, fromCurrency)))
          .for("update");
        if (!fromWallet) throw Object.assign(new Error("Source wallet not found"), { status: 404 });

        const available = new Decimal(fromWallet.availableBalance);
        if (available.lt(amount)) throw Object.assign(new Error("Insufficient balance"), { status: 400 });

        validateTransaction({ type: "exchange", amount: amount.toNumber(), fromCurrency, toCurrency, exchangeRate: exchangeRate.toNumber() });

        const [toWallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, toCurrency)))
          .for("update");
        if (!toWallet) throw Object.assign(new Error("Target wallet not found"), { status: 404 });

        await tx.update(wallets)
          .set({ balance: new Decimal(fromWallet.balance).minus(amount).toFixed(8), availableBalance: available.minus(amount).toFixed(8) })
          .where(eq(wallets.id, fromWallet.id));

        await tx.update(wallets)
          .set({ balance: new Decimal(toWallet.balance).plus(netConverted).toFixed(8), availableBalance: new Decimal(toWallet.availableBalance).plus(netConverted).toFixed(8) })
          .where(eq(wallets.id, toWallet.id));

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "exchange", fromCurrency, toCurrency,
          amount: amount.toFixed(8), fee: fee.toFixed(8),
          exchangeRate: exchangeRate.toFixed(8), status: "completed",
          settlementStatus: "internal_only",
          description: `${fromCurrency} to ${toCurrency} Exchange`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();
      });

      const responseBody = { transaction: txRecord, convertedAmount: netConverted.toNumber(), exchangeRate: exchangeRate.toNumber(), fee: fee.toNumber() };
      if (idemKey) await saveIdempotentResponse(userId, "/api/fx-exchange", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "fx_exchange", "transaction", String(txRecord?.id), { fromCurrency, toCurrency, amount: rawAmount }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process FX exchange" });
    }
  });

  // ---------------------------------------------------------------------------
  // Deposit — shared handler used by both canonical and legacy routes.
  // Internal operation: write completed atomically; no pending pre-insert.
  // ---------------------------------------------------------------------------
  const handleDeposit = async (req: Request, res: any) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);
      const parsedDeposit = depositSchema.safeParse(req.body);
      if (!parsedDeposit.success) return res.status(400).json({ error: parsedDeposit.error.errors[0].message });
      const { currency, amount: rawAmount, description } = parsedDeposit.data;
      const amount = new Decimal(rawAmount);

      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/deposit", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [wallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
          .for("update");
        if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

        await tx.update(wallets).set({
          balance: new Decimal(wallet.balance).plus(amount).toFixed(8),
          availableBalance: new Decimal(wallet.availableBalance).plus(amount).toFixed(8),
        }).where(eq(wallets.id, wallet.id));

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "deposit", fromCurrency: null, toCurrency: currency,
          amount: amount.toFixed(8), fee: "0.00000000", exchangeRate: null,
          status: "completed", settlementStatus: "internal_only",
          description: description || `${currency} Deposit`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();
      });

      if (idemKey) await saveIdempotentResponse(userId, "/api/deposit", idemKey, payloadHash, txRecord);
      await writeAuditLog(userId, "deposit", "transaction", String(txRecord?.id), { currency, amount: rawAmount }, req.ip || null);
      res.json(txRecord);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process deposit" });
    }
  };

  app.post("/api/deposit", moneyMovementLimiter, handleDeposit);
  app.post("/api/wallets/deposit", moneyMovementLimiter, handleDeposit);

  // ---------------------------------------------------------------------------
  // Withdraw — shared handler used by both canonical and legacy routes.
  // Internal operation: write completed atomically; no pending pre-insert.
  // ---------------------------------------------------------------------------
  const handleWithdraw = async (req: Request, res: any) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);
      const parsedWithdraw = withdrawSchema.safeParse(req.body);
      if (!parsedWithdraw.success) return res.status(400).json({ error: parsedWithdraw.error.errors[0].message });
      const { currency, amount: rawAmount, description } = parsedWithdraw.data;
      const amount = new Decimal(rawAmount);

      // This endpoint handles fiat wire withdrawals only.
      // Crypto assets (BTC, ETH, USDT, USDC) must not use this route — a flat
      // fiat fee (e.g. 25 USD) applied to a BTC withdrawal would be catastrophic.
      const CRYPTO_CURRENCIES = new Set(["BTC", "ETH", "USDT", "USDC", "LTC", "XRP"]);
      if (CRYPTO_CURRENCIES.has(currency)) {
        throw Object.assign(
          new Error("Crypto withdrawals are not supported via this route. Use the crypto withdrawal channel."),
          { status: 400 }
        );
      }

      // Currency-aware fiat wire fee table (flat fee per withdrawal, in native currency).
      // These represent typical correspondent banking / SWIFT wire charges.
      const WITHDRAWAL_FEES: Record<string, string> = {
        USD: "25.00",
        EUR: "20.00",
        GBP: "18.00",
        AUD: "35.00",
        CAD: "30.00",
        HKD: "200.00",
        SGD: "30.00",
        CNY: "150.00",
        JPY: "2500.00",
        CHF: "22.00",
        NZD: "35.00",
      };
      const feeAmount = WITHDRAWAL_FEES[currency] ?? "25.00";
      const fee = new Decimal(feeAmount);
      const totalDeduction = amount.plus(fee);

      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/withdraw", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [wallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
          .for("update");
        if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

        const available = new Decimal(wallet.availableBalance);
        if (available.lt(totalDeduction)) throw Object.assign(new Error("Insufficient balance"), { status: 400 });

        await tx.update(wallets).set({
          balance: new Decimal(wallet.balance).minus(totalDeduction).toFixed(8),
          availableBalance: available.minus(totalDeduction).toFixed(8),
        }).where(eq(wallets.id, wallet.id));

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "withdrawal", fromCurrency: currency, toCurrency: null,
          amount: amount.toFixed(8), fee: fee.toFixed(8), exchangeRate: null,
          status: "completed", settlementStatus: "internal_only",
          description: description || `${currency} Withdrawal`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();
      });

      if (idemKey) await saveIdempotentResponse(userId, "/api/withdraw", idemKey, payloadHash, txRecord);
      await writeAuditLog(userId, "withdrawal", "transaction", String(txRecord?.id), { currency, amount: rawAmount }, req.ip || null);
      res.json(txRecord);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process withdrawal" });
    }
  };

  app.post("/api/withdraw", moneyMovementLimiter, handleWithdraw);
  app.post("/api/wallets/withdraw", moneyMovementLimiter, handleWithdraw);

  // Mark AI recommendation as read
  app.patch("/api/ai-recommendations/:id/read", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) throw Object.assign(new Error("Invalid recommendation id"), { status: 400 });
      await storage.markRecommendationAsRead(id, userId);
      res.json({ success: true });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to mark recommendation as read" });
    }
  });

  // Apply AI recommendation — BLOCKED until SOA infrastructure is live (Session 1 lockdown)
  // Personal advice execution requires an issued Statement of Advice (Corporations Act s946A).
  // Re-enable only when advice_records / soa_documents / fee_consents tables and the
  // execution compliance gate are deployed (see Session 3+).
  // NOTE: Do NOT mutate recommendation state on a blocked execution attempt — that would
  // conflate user-read with execution-attempted in the audit trail. Just refuse cleanly.
  app.post("/api/ai-recommendations/:id/apply", async (req, res) => {
    try {
      const { userId: _userId } = requireAuth(req);
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) throw Object.assign(new Error("Invalid recommendation id"), { status: 400 });
      return res.status(403).json({
        success: false,
        error: "Execution unavailable",
        message: "AI insights are general information only. To act on this insight, request a Statement of Advice from a licensed adviser. Execution will be authorised only after SOA delivery, advice acceptance, and valid fee consent.",
        nextStep: "request_soa",
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process recommendation" });
    }
  });

  // Get investment products
  app.get("/api/investment-products", async (req, res) => {
    try {
      const filters = {
        category: req.query.category as string,
        riskProfile: req.query.riskProfile as string,
        liquidity: req.query.liquidity as string,
      };
      
      // Remove undefined filters
      Object.keys(filters).forEach(key => {
        if (!filters[key as keyof typeof filters]) {
          delete filters[key as keyof typeof filters];
        }
      });
      
      const products = await storage.getInvestmentProducts(Object.keys(filters).length > 0 ? filters : undefined);
      res.json(products);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get investment products" });
    }
  });

  // Get specific investment product
  app.get("/api/investment-products/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = await storage.getInvestmentProduct(id);
      if (!product) {
        return res.status(404).json({ error: "Investment product not found" });
      }
      res.json(product);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get investment product" });
    }
  });



  // Get user investments with real-time performance calculation
  app.get("/api/user-investments", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const investments = await storage.getUserInvestments(userId);
      const allProducts = await storage.getInvestmentProducts();
      const currentDate = new Date();
      
      // Calculate current values with performance using unified midpoint IRR function
      const investmentsWithPerformance = investments.map(investment => {
        const product = allProducts.find(p => p.id === investment.productId);
        if (!product) return investment;
        
        const investmentDate = new Date(investment.investmentDate ?? Date.now());
        const investedAmount = parseFloat(investment.investedAmount);
        const performance = calculateInvestmentPerformance(product, investedAmount, investmentDate, currentDate);
        
        return {
          ...investment,
          currentValue: performance.currentValue != null ? performance.currentValue.toFixed(2) : null,
          totalReturn: performance.returnAmount.toFixed(2),
          returnPercent: performance.returnPercentage.toFixed(2),
          ...(performance.valuationStatus ? { valuationStatus: performance.valuationStatus } : {})
        };
      });
      
      res.json(investmentsWithPerformance);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get user investments" });
    }
  });

  // Get investment performance by period with predictions
  app.get("/api/investment-performance", async (req, res) => {
    try {
      const { timeframe = "1Y" } = req.query;
      const { userId } = requireAuth(req);
      
      // Get all user investments
      const investments = await storage.getUserInvestments(userId);
      const allProducts = await storage.getInvestmentProducts();
      
      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      
      switch (timeframe) {
        case "1M":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "3M":
          startDate.setMonth(startDate.getMonth() - 3);
          break;
        case "1Y":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        default:
          startDate.setFullYear(startDate.getFullYear() - 1);
      }
      
      // Generate data points at 3-month intervals for the timeframe
      const dataPoints = [];
      const currentDate = new Date(startDate);
      
      while (currentDate <= endDate) {
        let totalInvestmentValue = 0;
        let weightedReturn = 0;
        let totalInvestedAmount = 0;
        
        // Calculate investment values and returns for this date
        for (const investment of investments) {
          const product = allProducts.find(p => p.id === investment.productId);
          if (product) {
            const investmentDate = new Date(investment.investmentDate ?? Date.now());
            if (investmentDate <= currentDate) {
              const investedAmount = parseFloat(investment.investedAmount);
              const performance = calculateInvestmentPerformance(product, investedAmount, investmentDate, currentDate);
              
              totalInvestmentValue += performance.currentValue ?? 0;
              totalInvestedAmount += investedAmount;
              
              // Weight the return by the investment amount
              weightedReturn += (performance.returnPercentage * investedAmount);
            }
          }
        }
        
        // Calculate weighted average return
        const avgReturn = totalInvestedAmount > 0 ? weightedReturn / totalInvestedAmount : 0;
        
        dataPoints.push({
          date: currentDate.toISOString().split('T')[0],
          value: Math.round(totalInvestmentValue),
          investedAmount: Math.round(totalInvestedAmount),
          weightedReturn: Number(avgReturn.toFixed(2)),
          timestamp: currentDate.getTime()
        });
        
        // Move to next 3-month interval
        currentDate.setMonth(currentDate.getMonth() + 3);
      }
      
      // Calculate 12-month prediction based on current allocation
      const currentPortfolioAllocation: Record<string, { value: number; annualReturn: number }> = {};
      let totalCurrentInvestment = 0;
      
      for (const investment of investments) {
        const product = allProducts.find(p => p.id === investment.productId);
        if (product) {
          const investedAmount = parseFloat(investment.investedAmount);
          const investmentDate = new Date(investment.investmentDate ?? Date.now());
          const performance = calculateInvestmentPerformance(product, investedAmount, investmentDate, endDate);
          const currentValue = performance.currentValue ?? 0;
          totalCurrentInvestment += currentValue;
          
          if (!currentPortfolioAllocation[product.category]) {
            currentPortfolioAllocation[product.category] = { value: 0, annualReturn: 0 };
          }
          currentPortfolioAllocation[product.category].value += currentValue;
          
          // Use product-level rate first, fallback to category mapping only when missing
          const predictedReturn =
            product.annualReturn != null
              ? parseFloat(product.annualReturn.toString())
              : getAnnualReturnFallback(product.category, product.name);
          currentPortfolioAllocation[product.category].annualReturn = predictedReturn;
        }
      }
      
      // Generate 7-year prediction (28 data points at 3-month intervals)
      const predictions = [];
      const predictionStartDate = new Date(endDate);
      
      // Calculate weighted annual return for the portfolio
      let portfolioWeightedReturn = 0;
      for (const [category, allocation] of Object.entries(currentPortfolioAllocation)) {
        const { value, annualReturn } = allocation as { value: number; annualReturn: number };
        const weight = value / totalCurrentInvestment;
        portfolioWeightedReturn += (annualReturn * weight);
      }
      
      for (let i = 1; i <= 28; i++) {
        predictionStartDate.setMonth(predictionStartDate.getMonth() + 3);
        
        // Calculate time in years (3-month intervals)
        const timeInYears = (i * 3) / 12;
        
        // Apply compound growth with portfolio weighted return
        const futureValue = totalCurrentInvestment * Math.pow(1 + portfolioWeightedReturn, timeInYears);
        const totalReturn = futureValue - totalCurrentInvestment;
        const totalReturnPercent = (totalReturn / totalCurrentInvestment) * 100;
        
        predictions.push({
          date: predictionStartDate.toISOString().split('T')[0],
          value: Math.round(futureValue),
          totalReturn: Math.round(totalReturn),
          weightedReturn: Number(totalReturnPercent.toFixed(2)),
          currentInvestment: Math.round(totalCurrentInvestment),
          isPrediction: true,
          timestamp: predictionStartDate.getTime()
        });
      }
      
      // Calculate overall performance metrics - use real-time current values from all investments with unified function
      let totalInvestedNow = 0;
      let totalCurrentValueNow = 0;
      
      for (const investment of investments) {
        const product = allProducts.find(p => p.id === investment.productId);
        if (product) {
          const investedAmount = parseFloat(investment.investedAmount);
          const investmentDate = new Date(investment.investmentDate ?? Date.now());
          const performance = calculateInvestmentPerformance(product, investedAmount, investmentDate, endDate);
          
          totalInvestedNow += investedAmount;
          totalCurrentValueNow += performance.currentValue ?? 0;
        }
      }
      
      const totalReturn = totalCurrentValueNow - totalInvestedNow;
      const totalReturnPercent = totalInvestedNow > 0 ? (totalReturn / totalInvestedNow) * 100 : 0;
      
      res.json({
        timeframe,
        data: dataPoints,
        predictions,
        currentValue: totalCurrentValueNow,
        totalReturn: totalReturn.toFixed(2),
        totalReturnPercent: totalReturnPercent.toFixed(2),
        portfolioAllocation: currentPortfolioAllocation
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Investment performance error:", error);
      res.status(500).json({ error: "Failed to get investment performance" });
    }
  });

  // Get investment breakdown by category
  app.get("/api/investment-breakdown", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const totals = await calculateInvestmentTotalsAtDate(userId, new Date());

      const categoryDisplayNames: Record<string, string> = {
        real_estate: "Real Estate",
        corporate_credit: "Corporate Credit",
        venture_capital: "Venture Capital",
        digital_assets: "Digital Assets",
        cash_deposit: "Cash Deposits",
      };

      const categoryMap: Record<string, { name: string; value: number; products: any[] }> = {};
      for (const item of totals.items) {
        if (!categoryMap[item.category]) {
          categoryMap[item.category] = {
            name: categoryDisplayNames[item.category] ?? item.category,
            value: 0,
            products: [],
          };
        }
        categoryMap[item.category].value += item.currentValue ?? 0;
        categoryMap[item.category].products.push({
          name: item.productName,
          value: item.currentValue,
          investedAmount: item.investedAmount,
          returnAmount: item.returnAmount,
          returnPercentage: item.returnPercentage,
          percentage: 0, // filled below
        });
      }

      const categories = Object.values(categoryMap)
        .map(cat => ({
          ...cat,
          percentage: totals.totalCurrentValue > 0 ? (cat.value / totals.totalCurrentValue) * 100 : 0,
          products: cat.products.map(p => ({
            ...p,
            percentage: totals.totalCurrentValue > 0 ? (p.value / totals.totalCurrentValue) * 100 : 0,
          })),
        }))
        .filter(cat => cat.value > 0);

      res.json({
        totalInvested: totals.totalInvested,
        totalCurrentValue: totals.totalCurrentValue,
        totalReturn: totals.totalReturn,
        totalReturnPercent: totals.totalReturnPercent,
        categories,
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to fetch investment breakdown" });
    }
  });

  // ---------------------------------------------------------------------------
  // Investments — atomic SERIALIZABLE transaction + Decimal + DB idempotency
  // ---------------------------------------------------------------------------
  app.post("/api/investments", moneyMovementLimiter, async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);
      const parsedInvestment = investmentSchema.safeParse(req.body);
      if (!parsedInvestment.success) return res.status(400).json({ error: parsedInvestment.error.errors[0].message });
      const { productId, amount: rawAmount, sourceCurrency = "USD", sourceAmount: rawSourceAmount } = parsedInvestment.data;

      const product = await storage.getInvestmentProduct(productId);
      if (!product) return res.status(400).json({ error: "Investment product not found" });

      const investmentAmount = new Decimal(rawAmount);
      const deductionAmount = rawSourceAmount ? new Decimal(rawSourceAmount) : investmentAmount;
      const currency = sourceCurrency || "USD";
      const minimumInvestment = new Decimal(product.minimumInvestment);

      if (investmentAmount.lt(minimumInvestment)) {
        return res.status(400).json({ error: `Minimum investment is $${minimumInvestment.toFixed(2)}` });
      }

      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/investments", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      const exchangeRateStr = currency !== "USD" ? investmentAmount.div(deductionAmount).toFixed(8) : null;

      let txRecord: any;
      let investRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [sourceWallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency))).for("update");
        if (!sourceWallet) throw Object.assign(new Error(`${currency} wallet not found`), { status: 400 });

        const available = new Decimal(sourceWallet.availableBalance);
        if (available.lt(deductionAmount)) throw Object.assign(
          new Error(`Insufficient balance. Available: ${available.toFixed(2)} ${currency}`), { status: 400 }
        );

        await tx.update(wallets).set({
          balance: new Decimal(sourceWallet.balance).minus(deductionAmount).toFixed(8),
          availableBalance: available.minus(deductionAmount).toFixed(8),
        }).where(eq(wallets.id, sourceWallet.id));

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "investment", fromCurrency: currency,
          toCurrency: currency === "USD" ? null : "USD",
          amount: deductionAmount.toFixed(8), fee: "0.00000000",
          exchangeRate: exchangeRateStr, status: "completed",
          settlementStatus: "internal_only",
          description: `Investment in ${product.name}${currency !== "USD" ? ` (converted from ${currency})` : ""}`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();

        const [inv] = await tx.insert(userInvestments).values({
          userId, productId,
          investedAmount: investmentAmount.toFixed(2),
          currentValue: investmentAmount.toFixed(2),
          totalReturn: "0.00",
          returnPercent: "0.00",
          status: "active",
          maturityDate: null,
        }).returning();
        investRecord = inv;
      });

      await saveActualSnapshot(userId);
      const responseBody = { investment: investRecord, transaction: txRecord, newBalance: deductionAmount.toString(), sourceCurrency: currency, message: "Investment created successfully" };
      if (idemKey) await saveIdempotentResponse(userId, "/api/investments", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "investment_created", "investment", String(investRecord?.id), { productId, amount: rawAmount, currency }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to create investment" });
    }
  });

  // ---------------------------------------------------------------------------
  // Wallet Transfer — atomic SERIALIZABLE + Zod + Decimal + DB idempotency
  // (previously had no validation, no atomicity, no decimal math)
  // ---------------------------------------------------------------------------
  app.post("/api/wallets/transfer", moneyMovementLimiter, async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);
      const parsedTransfer = walletTransferSchema.safeParse(req.body);
      if (!parsedTransfer.success) return res.status(400).json({ error: parsedTransfer.error.errors[0].message });
      const { fromCurrency, toCurrency, amount: rawAmount } = parsedTransfer.data;
      const amount = new Decimal(rawAmount);

      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/wallets/transfer", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      const rate = await storage.getFxRate(fromCurrency, toCurrency);
      if (!rate) return res.status(400).json({ error: `Exchange rate not found for ${fromCurrency} to ${toCurrency}` });
      const exchangeRate = new Decimal(rate.rate);

      // Ensure target wallet exists before entering the transaction
      const existingTarget = await storage.getWallet(userId, toCurrency);
      if (!existingTarget) {
        await storage.createWallet({
          userId, currency: toCurrency, balance: "0.00", availableBalance: "0.00",
          walletType: ["BTC", "ETH"].includes(toCurrency) ? "crypto" : "fiat",
        });
      }

      const converted = amount.mul(exchangeRate);
      const fee = converted.mul("0.005");
      const finalAmount = converted.minus(fee);

      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [srcWallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, fromCurrency))).for("update");
        if (!srcWallet) throw Object.assign(new Error("Source wallet not found"), { status: 404 });

        const available = new Decimal(srcWallet.availableBalance);
        if (available.lt(amount)) throw Object.assign(new Error("Insufficient balance"), { status: 400 });

        validateTransaction({ type: "exchange", amount: amount.toNumber(), fromCurrency, toCurrency, exchangeRate: exchangeRate.toNumber() });

        const [tgtWallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, toCurrency))).for("update");
        if (!tgtWallet) throw Object.assign(new Error("Target wallet not found"), { status: 404 });

        await tx.update(wallets).set({
          balance: new Decimal(srcWallet.balance).minus(amount).toFixed(8),
          availableBalance: available.minus(amount).toFixed(8),
        }).where(eq(wallets.id, srcWallet.id));

        await tx.update(wallets).set({
          balance: new Decimal(tgtWallet.balance).plus(finalAmount).toFixed(8),
          availableBalance: new Decimal(tgtWallet.availableBalance).plus(finalAmount).toFixed(8),
        }).where(eq(wallets.id, tgtWallet.id));

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "exchange", fromCurrency, toCurrency,
          amount: amount.toFixed(8), fee: fee.toFixed(8),
          exchangeRate: exchangeRate.toFixed(8), status: "completed",
          settlementStatus: "internal_only",
          description: `Converted ${rawAmount} ${fromCurrency} to ${finalAmount.toFixed(8)} ${toCurrency}`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();
      });

      const responseBody = { transaction: txRecord, exchangeRate: exchangeRate.toNumber(), convertedAmount: converted.toNumber(), fee: fee.toNumber(), finalAmount: finalAmount.toNumber() };
      if (idemKey) await saveIdempotentResponse(userId, "/api/wallets/transfer", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "wallet_transfer", "transaction", String(txRecord?.id), { fromCurrency, toCurrency, amount: rawAmount }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process transfer" });
    }
  });

  // Advisor Contact Route
  app.post("/api/advisor/contact", async (req, res) => {
    try {
      const { message } = req.body;
      
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      // In a real implementation, this would send an email or create a ticket
      // For demo, we'll just return success
      res.json({ 
        success: true, 
        message: "Your message has been sent to your wealth planner",
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // ---------------------------------------------------------------------------
  // Password Reset — forgot-password generates a token; reset-password validates
  // it, hashes the new password, and marks the token used. Single-use, 1h TTL.
  // ---------------------------------------------------------------------------
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { username } = z.object({ username: z.string().min(1) }).parse(req.body);
      const [user] = await db.select().from(users).where(eq(users.username, username));
      // Always return 200 to prevent username enumeration
      if (!user) return res.json({ message: "If that account exists, a reset token has been generated." });

      // Expire any existing unused tokens for this user
      await db.update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, user.id), sql`${passwordResetTokens.usedAt} IS NULL`));

      const token = randomBytes(32).toString("hex"); // raw token returned to user
      const tokenHash = createHash("sha256").update(token).digest("hex"); // hashed value stored in DB
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db.insert(passwordResetTokens).values({ userId: user.id, token: tokenHash, expiresAt });

      await writeAuditLog(user.id, "password_reset_requested", "user", String(user.id), { username }, null);

      // Never expose the raw token outside isolated local development — in a real
      // deployment this would be emailed to the user. Only returned when isLocalDev
      // is true (NODE_ENV=development + APP_ENV=local or ALLOW_LOCAL_DEV_AUTH=true),
      // which is never satisfied by a shared staging server.
      if (isLocalDev) {
        return res.json({ message: "Reset token generated (dev mode).", resetToken: token });
      }
      res.json({ message: "If that account exists, a password reset link has been sent." });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = z.object({
        token: z.string().min(1),
        newPassword: z.string().min(8, "Password must be at least 8 characters"),
      }).parse(req.body);

      // Hash incoming token before comparing — stored value is also a SHA-256 hash
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const [record] = await db.select().from(passwordResetTokens)
        .where(and(
          eq(passwordResetTokens.token, tokenHash),
          sql`${passwordResetTokens.usedAt} IS NULL`,
          sql`${passwordResetTokens.expiresAt} > now()`
        ));

      if (!record) return res.status(400).json({ error: "Invalid or expired reset token." });

      const hashed = await hashPassword(newPassword);

      await db.transaction(async (tx) => {
        await tx.update(users).set({ password: hashed }).where(eq(users.id, record.userId));
        await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, record.id));
      });

      await writeAuditLog(record.userId, "password_reset_completed", "user", String(record.userId), {}, null);

      res.json({ message: "Password reset successfully." });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // ---------------------------------------------------------------------------
  // Phase 2.1 — Fact find + risk profile (advice-engine foundation)
  // ---------------------------------------------------------------------------
  // Routes:
  //   POST /api/fact-find              — create a new fact-find snapshot
  //   POST /api/risk-profile/score     — score answers, persist a risk profile
  //   GET  /api/fact-find/latest       — most recent snapshot for current user
  //   GET  /api/risk-profile/latest    — most recent risk profile for current user
  //
  // All routes require auth + verified KYC. Persisting these inputs is what
  // makes the scoring decision auditable later, so we always insert before
  // returning (no read-only scoring path in this phase).
  // ---------------------------------------------------------------------------

  // Zod schema for fact-find body. All decimal-amount fields are accepted as
  // strings (Drizzle decimal columns expect strings) but also tolerate numbers
  // by coercing to string. Optional everywhere except clientId (derived from
  // the authenticated user) and rawAnswers (defaults to the body itself).
  const decimalString = z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === null || v === "" ? undefined : String(v)));

  const factFindBodySchema = z.object({
    employmentStatus: z.string().optional(),
    incomeStability: z.enum(["stable", "variable", "unstable"]).optional(),
    annualIncome: decimalString,
    annualExpenses: decimalString,
    cashAssets: decimalString,
    investmentAssets: decimalString,
    propertyAssets: decimalString,
    superAssets: decimalString,
    otherAssets: decimalString,
    mortgageDebt: decimalString,
    personalDebt: decimalString,
    creditCardDebt: decimalString,
    otherDebt: decimalString,
    dependantsCount: z.number().int().nonnegative().optional(),
    liquidityBufferMonths: z.number().int().nonnegative().optional(),
    liquidityNeeds: z.enum(["low", "medium", "high"]).optional(),
    primaryObjective: z.string().optional(),
    investmentHorizon: z.enum(["<2", "2-5", "5-10", "10+"]).optional(),
    incomeReliance: z.enum(["full", "partial", "none"]).optional(),
    existingAllocation: z.record(z.string(), z.number()).optional(),
    rawAnswers: z.record(z.string(), z.unknown()).optional(),
  });

  app.post("/api/fact-find", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      const payload = factFindBodySchema.parse(req.body);

      const [snapshot] = await db
        .insert(factFindSnapshots)
        .values({
          clientId: userId,
          employmentStatus: payload.employmentStatus,
          incomeStability: payload.incomeStability,
          annualIncome: payload.annualIncome,
          annualExpenses: payload.annualExpenses,

          cashAssets: payload.cashAssets,
          investmentAssets: payload.investmentAssets,
          propertyAssets: payload.propertyAssets,
          superAssets: payload.superAssets,
          otherAssets: payload.otherAssets,

          mortgageDebt: payload.mortgageDebt,
          personalDebt: payload.personalDebt,
          creditCardDebt: payload.creditCardDebt,
          otherDebt: payload.otherDebt,

          dependantsCount: payload.dependantsCount ?? 0,
          liquidityBufferMonths: payload.liquidityBufferMonths,
          liquidityNeeds: payload.liquidityNeeds,

          primaryObjective: payload.primaryObjective,
          investmentHorizon: payload.investmentHorizon,
          incomeReliance: payload.incomeReliance,

          existingAllocation: payload.existingAllocation ?? {},
          rawAnswers: payload.rawAnswers ?? payload,
          isComplete: true,
        })
        .returning();

      await writeAuditLog(userId, "fact_find_created", "fact_find_snapshot", String(snapshot.id), {}, req.ip || null);
      res.json({ success: true, factFindSnapshot: snapshot });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Create fact find error:", error);
      res.status(500).json({ error: "Failed to create fact find snapshot" });
    }
  });

  // Zod schema for the risk-profile scoring body.
  const riskAnswersSchema = z.object({
    marketDropReaction: z.enum(["sell_all", "sell_some", "hold", "buy_more"]),
    volatilityTolerance: z.enum(["low", "some", "moderate", "high"]),
    lossTolerance: z.enum(["under_5", "5_10", "10_20", "over_20"]),
    investmentExperience: z.enum(["none", "basic", "moderate", "advanced"]),
    incomeReliance: z.enum(["full", "partial", "none"]),
    incomeStability: z.enum(["stable", "variable", "unstable"]),
    liquidityBufferMonths: z.number().int().nonnegative(),
    dependantsCount: z.number().int().nonnegative(),
    debtRatio: z.enum(["low", "medium", "high"]),
    investmentHorizon: z.enum(["<2", "2-5", "5-10", "10+"]),
    liquidityNeeds: z.enum(["low", "medium", "high"]),
  });

  const riskProfileScoreBodySchema = z.object({
    factFindSnapshotId: z.number().int().positive(),
    answers: riskAnswersSchema,
  });

  app.post("/api/risk-profile/score", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      const { factFindSnapshotId, answers } = riskProfileScoreBodySchema.parse(req.body);

      // Verify the referenced fact-find snapshot belongs to this user before
      // scoring — prevents a user from binding their risk profile to someone
      // else's snapshot.
      const [parent] = await db
        .select({ id: factFindSnapshots.id, clientId: factFindSnapshots.clientId })
        .from(factFindSnapshots)
        .where(eq(factFindSnapshots.id, factFindSnapshotId))
        .limit(1);

      if (!parent || parent.clientId !== userId) {
        return res.status(404).json({ error: "Fact find snapshot not found." });
      }

      const result = scoreRiskProfile(answers as RiskAnswers);

      const [riskProfile] = await db
        .insert(riskProfiles)
        .values({
          clientId: userId,
          factFindSnapshotId,

          behaviouralScore: result.behaviouralScore,
          capacityAdjustment: result.capacityAdjustment,
          finalScore: result.finalScore,

          riskBand: result.riskBand,
          recommendedPortfolio: result.recommendedPortfolio,

          overrideApplied: result.overrideApplied,
          overrideReasons: result.overrideReasons,

          allocation: result.allocation,
          scoringInputs: result.scoringInputs,
        })
        .returning();

      await writeAuditLog(userId, "risk_profile_scored", "risk_profile", String(riskProfile.id), {
        riskBand: result.riskBand,
        finalScore: result.finalScore,
        overrideApplied: result.overrideApplied,
      }, req.ip || null);

      res.json({ success: true, riskProfile });
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Risk scoring error:", error);
      res.status(500).json({ error: "Failed to score risk profile" });
    }
  });

  app.get("/api/fact-find/latest", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      const [snapshot] = await db
        .select()
        .from(factFindSnapshots)
        .where(eq(factFindSnapshots.clientId, userId))
        .orderBy(desc(factFindSnapshots.createdAt))
        .limit(1);

      res.json({ factFindSnapshot: snapshot ?? null });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Get latest fact find error:", error);
      res.status(500).json({ error: "Failed to fetch fact find" });
    }
  });

  app.get("/api/risk-profile/latest", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      await requireKyc(userId, storage);

      const [profile] = await db
        .select()
        .from(riskProfiles)
        .where(eq(riskProfiles.clientId, userId))
        .orderBy(desc(riskProfiles.createdAt))
        .limit(1);

      res.json({ riskProfile: profile ?? null });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Get latest risk profile error:", error);
      res.status(500).json({ error: "Failed to fetch risk profile" });
    }
  });

  // ---------------------------------------------------------------------------
  // Live FX Rate Refresh
  // Uses two free, key-free public APIs to keep rates current:
  //   • frankfurter.app  — ECB fiat rates (EUR, GBP, CAD, CNY vs USD)
  //   • api.coinbase.com — BTC and ETH spot prices
  // Runs immediately on startup, then every 15 minutes.
  // Fails silently on network errors — existing DB rates are kept as fallback.
  // ---------------------------------------------------------------------------
  async function refreshFxRates(): Promise<void> {
    try {
      // ── Fiat pairs ─────────────────────────────────────────────────────────
      const fiatRes = await fetch(
        "https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,CAD,CNY"
      );
      if (fiatRes.ok) {
        const fiatData = await fiatRes.json() as { rates: Record<string, number> };
        for (const [currency, rate] of Object.entries(fiatData.rates)) {
          const rateStr = rate.toFixed(8);
          const inverseStr = (1 / rate).toFixed(8);
          await db.execute(
            sql`UPDATE fx_rates SET rate = ${rateStr}, updated_at = NOW() WHERE base_currency = 'USD' AND target_currency = ${currency}`
          ).catch(() => {});
          await db.execute(
            sql`UPDATE fx_rates SET rate = ${inverseStr}, updated_at = NOW() WHERE base_currency = ${currency} AND target_currency = 'USD'`
          ).catch(() => {});
        }
      }

      // ── Crypto pairs ───────────────────────────────────────────────────────
      for (const [symbol, dbCurrency] of [["BTC-USD", "BTC"], ["ETH-USD", "ETH"]] as const) {
        const res = await fetch(`https://api.coinbase.com/v2/prices/${symbol}/spot`);
        if (res.ok) {
          const body = await res.json() as { data: { amount: string } };
          const price = parseFloat(body.data.amount);
          if (isFinite(price) && price > 0) {
            await db.execute(
              sql`UPDATE fx_rates SET rate = ${price.toFixed(8)}, updated_at = NOW() WHERE base_currency = ${dbCurrency} AND target_currency = 'USD'`
            ).catch(() => {});
          }
        }
      }

      console.log("[fx-refresh] rates updated at", new Date().toISOString());
    } catch (err) {
      // Fail silently — DB rates remain as fallback; don't crash the server
      console.error("[fx-refresh] failed:", (err as Error).message);
    }
  }

  // Run immediately on startup, then every 15 minutes
  refreshFxRates();
  setInterval(refreshFxRates, 15 * 60 * 1000);

  return httpServer;
}
