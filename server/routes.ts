import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
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
  registrationInvites,
  adviserClients,
  users,
  portfolios,
  leads,
  funnelEvents,
  applications as applicationsTable,
  factFindSnapshots,
  riskProfiles,
  riskAssessmentResponses,
  riskAssessmentAnswersSchema,
  riskAssessmentSubmitSchema,
  adviceRecords,
  normalizeEmail,
} from "@shared/schema";
import { buildComplianceOverview } from "./services/compliance-overview";
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
import { recordAuditWriteFailure } from "./services/error-log";
import { registerAdviserRoutes } from "./adviser-routes";
import { registerAdminRoutes } from "./admin-routes";
import { registerClientRoutes } from "./client-routes";
import {
  getOrCreateClientAccount,
  getOrCreateSuspenseAccount,
  getOrCreateFeeAccount,
  postLedgerEntries,
  refreshWalletCacheBalance,
  getUserLedgerSumsByCurrency,
  mapLedgerUnbalancedToHttpResponse,
  notifyMoneyMovementFailure,
} from "./services/ledger";
import { MATCH_EPSILON } from "./services/reconciliation";
import { emitAuditWriteFailureAlert } from "./services/audit";
import {
  loadSumsubConfigFromEnv,
  mintSumsubAccessToken,
  buildExternalUserId,
  parseExternalUserId,
  verifyWebhookSignature,
  mapSumsubReviewToKycStatus,
  DEFAULT_SUMSUB_DIGEST_ALG,
  SumsubApiError,
  SumsubNotConfiguredError,
} from "./services/sumsub";
import { loadKycState } from "./services/kyc-state";
import {
  assertKillSwitchOff,
  getAllKillSwitchStates,
  sendKillSwitchResponse,
} from "./services/kill-switch";
import {
  DEFAULT_REBALANCING_BENCHMARK,
  computeRebalancingGap,
  resolvePerClientBenchmark,
  resolveRecommendationKind,
} from "./config/rebalancing-benchmark";
import { loadLatestSoaTargetAllocation } from "./services/soa-target";
import { registerPortfolioRealMetricsRoute } from "./portfolio-real-metrics-route";
import { registerPortfolioAllocationRoute } from "./portfolio-allocation-route";

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

// Task #404 — Per-step KYC state cache + fallback logic lives in
// `./services/kyc-state.ts` so it can be unit-tested without supertest /
// without standing up the entire route table. The route below is a thin
// adapter over `loadKycState`.

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
// Task #160 — replay an idempotent response when a parallel request lost
// the SERIALIZABLE race.
//
// Background:
//   The money-movement handlers run inside `db.transaction(...)` with
//   `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`. Two requests that share
//   the same Idempotency-Key both pass `checkIdempotency()` (no row yet),
//   then race for the same wallet row. Postgres aborts the loser with
//   SQLSTATE 40001 ("could not serialize access due to concurrent update").
//   Without this helper, that 40001 surfaces to the client as a 500 — a
//   money-movement failure mode that is dangerous because clients usually
//   retry on 5xx, which can lead to duplicate processing if the next retry
//   races a third concurrent request.
//
// What this does:
//   - Detects err.code === "40001" (or the wrapped form Postgres drivers use).
//   - Polls `idempotencyKeys` with brief backoff until the winner has called
//     `saveIdempotentResponse()` (which happens AFTER its tx commits, so a
//     small window exists where the loser arrives before the winner has
//     persisted).
//   - Returns the stored response so the loser can reply 200 with
//     `idempotent: true` instead of 500.
//
// Invariants:
//   - Only triggers when an Idempotency-Key was actually present on the
//     request. Without a key, there is nothing meaningful to replay.
//   - Bounded retry (10 × 50ms = ~500ms wall-clock max). If the winner
//     never persists, we fall through to the original 500 path so the
//     failure is loud, not silently swallowed.
//   - Read-only — does not mutate state; safe to call from a catch block.
// ---------------------------------------------------------------------------
const PG_SERIALIZATION_FAILURE = "40001";

function isSerializationFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (e.code === PG_SERIALIZATION_FAILURE) return true;
  // Some drivers wrap the original pg error in `.cause`.
  if (e.cause && typeof e.cause === "object") {
    const cause = e.cause as { code?: unknown };
    if (cause.code === PG_SERIALIZATION_FAILURE) return true;
  }
  return false;
}

async function replayIdempotentOnSerializationFailure(
  err: unknown,
  userId: number | null,
  route: string,
  idemKey: string | undefined,
): Promise<unknown | null> {
  if (!idemKey || userId === null) return null;
  if (!isSerializationFailure(err)) return null;

  // The winning request commits the idempotency row OUTSIDE its DB
  // transaction (saveIdempotentResponse is called after `db.transaction`
  // returns). The loser may arrive here before the winner has persisted —
  // poll briefly to cover that window.
  for (let attempt = 0; attempt < 10; attempt++) {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.route, route),
          eq(idempotencyKeys.key, idemKey),
        ),
      );
    if (row) return row.responseJson;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistent audit log writer — writes finance-grade event records to DB.
// ---------------------------------------------------------------------------
// Failure semantics (TASK #145):
//   This legacy local writer must KEEP its swallow-on-failure behaviour to
//   honour the original "Audit log failures must never crash money routes"
//   contract — the surrounding callers in this file rely on it. But silent
//   loss of audit rows is exactly the operator-paging trigger we just wired
//   up, so we now fire the same `audit-log-write-failure` operator alert as
//   the canonical writer in services/audit.ts before swallowing. This keeps
//   the admin "audit-log-write-failure" alert stream consistent regardless of
//   which code path attempted the insert.
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
  } catch (err) {
    // Audit log failures must never crash money routes — but we DO record
    // the failure into the persistent error log + the in-process metrics
    // counter (Task #144), AND fire the same `audit-log-write-failure`
    // operator alert as the canonical writer in services/audit.ts
    // (Task #145). Together: the metrics counter is the "how often",
    // the operator alert is the "wake someone up RIGHT NOW", and the
    // suppression key collapses repeats of the same failing row to one
    // ack-able signature.
    recordAuditWriteFailure(err, { userId, action });
    await emitAuditWriteFailureAlert(
      { userId, action, entityType, entityId, before: null, after: null },
      err,
    );
    // Intentional: re-throwing here would crash a money route mid-flight.
    // The two compensating controls above are the substitute.
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

// Portfolio valuation helpers (convertToUsd, calculateInvestmentPerformance,
// getAnnualReturnFallback, calculateInvestmentTotalsAtDate, and
// reconstructWalletBalancesAsOf) live in server/services/portfolio-valuation.ts
// so the adviser read path can share the exact same engine without creating a
// routes -> adviser-routes -> adviser-access -> routes import cycle.
import {
  convertToUsd,
  calculateInvestmentPerformance,
  getAnnualReturnFallback,
  calculateInvestmentTotalsAtDate,
  reconstructWalletBalancesAsOf,
} from "./services/portfolio-valuation";

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
  registerAdminRoutes(app);
  registerClientRoutes(app);

  // ---------------------------------------------------------------------------
  // Task #146 — Public kill-switch status
  // -----------------------------------------------------------------------------
  // Read-only endpoint the client/adviser UI polls to render the
  // "Temporarily unavailable" banners on affected screens. Does NOT require
  // auth — the existence of a switch is not sensitive information and
  // returning 401 here would deny anonymous status pages of their banner.
  // The response intentionally omits `reason` to avoid leaking internal
  // operator notes; the admin page surfaces the reason behind the auth wall.
  // ---------------------------------------------------------------------------
  app.get("/api/kill-switches/status", async (_req, res) => {
    try {
      const states = await getAllKillSwitchStates();
      const out: Record<string, { disabled: boolean }> = {};
      for (const s of states) out[s.key] = { disabled: s.enabled };
      res.json({ switches: out });
    } catch (err: any) {
      // Fail open from the client's perspective — render no banner — so a
      // transient DB hiccup doesn't paint a scary "everything is down"
      // banner. The actual money-movement guards still consult the DB on
      // the request path.
      console.error("[kill-switches] status read failed", err);
      res.json({ switches: {} });
    }
  });

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

    // -------------------------------------------------------------------------
    // Task #149 — audit_logs immutability at the DB level
    // -------------------------------------------------------------------------
    // The go-live checklist requires `audit_logs` to be truly append-only:
    // no UPDATE, no DELETE, no TRUNCATE — ever. Until now this was enforced
    // only by convention (no application code path mutates the table); a
    // buggy migration or a future ORM call could silently break that. The
    // installer below adds BEFORE triggers that raise an exception for any
    // UPDATE, DELETE, or TRUNCATE attempt, regardless of who issues it (app
    // role, psql session, drizzle-kit migration, etc). INSERTs unaffected.
    //
    // The DDL itself lives in `server/services/audit-immutability-migration.ts`
    // so production startup and the automated test
    // (`server/services/audit-immutability.test.ts`) cannot drift apart.
    // The emergency-override procedure for DBAs is documented in that
    // installer module.
    // -------------------------------------------------------------------------
    const { installAuditLogsImmutabilityTriggers } = await import(
      "./services/audit-immutability-migration"
    );
    await installAuditLogsImmutabilityTriggers(db);

    // -------------------------------------------------------------------------
    // Task #330 — 7-year retention defaults + backfill
    // -------------------------------------------------------------------------
    // Every regulatory `retention_until` column now defaults to
    // `now() + interval '7 years'` (Corporations Act s912G). The
    // pre-existing `defaultNow()` placeholder left newly-inserted rows
    // with an immediately-elapsed retention deadline, which would have
    // let the daily retention-sweeper cron unlock them on the very next
    // tick. The migration block below:
    //
    //   1. ALTERs the column default on every retention table so future
    //      inserts get the correct deadline. Idempotent — re-running on
    //      every boot is a no-op.
    //
    //   2. Backfills existing rows whose retention_until still points at
    //      the placeholder timestamp. We detect the placeholder by checking
    //      whether retention_until is within 1 day of the row's natural
    //      anchor (uploaded_at / consented_at / created_at / etc.) — the
    //      original `defaultNow()` always wrote a timestamp essentially
    //      identical to the row's creation moment. Rows whose retention has
    //      already been bumped by some future code path (retention_until
    //      meaningfully after the anchor) are deliberately left untouched.
    //
    // The sweeper itself lives in `server/services/retention-sweeper.ts`
    // and is wired into `server/index.ts` alongside the other daily crons.
    // -------------------------------------------------------------------------
    {
      // ALTER COLUMN DEFAULTs first. PostgreSQL accepts ALTER COLUMN ...
      // SET DEFAULT idempotently — re-issuing the same default is a no-op.
      const tablesAndDefaults: ReadonlyArray<string> = [
        "fact_find_snapshots",
        "risk_profiles",
        "advice_records",
        "soa_documents",
        "roa_documents",
        "fee_consents",
        "advice_acknowledgements",
        "execution_authorisations",
        "client_objectives",
        "client_documents",
        "adviser_notes",
        "advice_record_versions",
      ];
      for (const tbl of tablesAndDefaults) {
        await db.execute(sql.raw(
          `ALTER TABLE ${tbl} ALTER COLUMN retention_until SET DEFAULT now() + interval '7 years'`,
        ));
      }

      // Backfill placeholder rows. Each entry maps a table to the column
      // we treat as the "natural anchor" for the row — the same column the
      // 7-year window is supposed to start from. The WHERE clause is the
      // placeholder detector: retention_until within 1 day of the anchor
      // means the original defaultNow() default was used.
      const backfills: ReadonlyArray<{ table: string; anchor: string }> = [
        { table: "fact_find_snapshots",       anchor: "created_at" },
        { table: "risk_profiles",             anchor: "created_at" },
        { table: "advice_records",            anchor: "created_at" },
        { table: "soa_documents",             anchor: "created_at" },
        { table: "roa_documents",             anchor: "created_at" },
        { table: "fee_consents",              anchor: "consented_at" },
        { table: "advice_acknowledgements",   anchor: "accepted_at" },
        { table: "execution_authorisations",  anchor: "authorised_at" },
        { table: "client_objectives",         anchor: "created_at" },
        { table: "client_documents",          anchor: "uploaded_at" },
        { table: "adviser_notes",             anchor: "created_at" },
        { table: "advice_record_versions",    anchor: "issued_at" },
      ];
      for (const { table, anchor } of backfills) {
        // The COALESCE guards rows where the anchor itself is somehow
        // null (legacy data) by falling back to retention_until itself —
        // because all twelve anchors carry a `defaultNow()` and were
        // populated alongside the row, the fallback is essentially
        // unreachable but kept as a safety belt.
        //
        // The 1-day fudge factor absorbs `now()` skew between the row's
        // INSERT and the placeholder default's evaluation. We deliberately
        // do NOT reference `created_at` in this query — two retention
        // tables (client_documents, advice_record_versions) don't carry
        // that column at all, and adding a per-table branch here would
        // just duplicate the anchor list.
        await db.execute(sql.raw(
          `UPDATE ${table}
             SET retention_until = COALESCE(${anchor}, retention_until) + interval '7 years'
           WHERE retention_until IS NOT NULL
             AND retention_until <= COALESCE(${anchor}, retention_until) + interval '1 day'`,
        ));
      }
    }

    // Task #307 — install the parameter-equality trigger on adviser_fee_rules
    // BEFORE any route accepts traffic. Idempotent (CREATE OR REPLACE) so it
    // is safe to run on every boot. The service-layer
    // validateRuleAmountAgainstConsent() check produces the friendly 400;
    // this trigger is the DB-level backstop that closes any path that
    // bypasses the service (raw psql, ad-hoc scripts, etc).
    const { installFeeRuleAmountEqualityTrigger } = await import(
      "./services/consent-integrity"
    );
    await installFeeRuleAmountEqualityTrigger(db);

    // Hash the demo user's plaintext password on first startup
    const demoUser = await storage.getUser(1);
    if (demoUser && !demoUser.password.startsWith("$2")) {
      const hashed = await hashPassword(demoUser.password);
      await storage.updateUser(1, { password: hashed });
    }

    // Seed the `wiseinvestor` demo account if it doesn't exist (idempotent on every boot).
    // Used for live demos; password is intentionally well-known.
    //
    // Task #143 — `isDemo: true` is set on create AND back-filled on existing
    // rows that pre-date the column. The wallet-vs-ledger and ledger-vs-
    // custodian reconciliation services skip demo-flagged users so the demo
    // multi-currency balances (which live in `wallets` but were never posted
    // through the ledger) cannot generate misleading drift alerts.
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
          isDemo: true,
        } as any);
      } else {
        const updates: any = {};
        if (!(await verifyPassword("wise888", existing.password))) {
          updates.password = desiredHash;
          updates.emailVerified = true;
        }
        if (!existing.isDemo) updates.isDemo = true;
        if (Object.keys(updates).length) await storage.updateUser(existing.id, updates);
      }
    } catch (err) {
      console.warn("[seed] wiseinvestor demo account seed failed:", (err as Error).message);
    }

    // Seed the `wiseadviser` demo adviser account. Idempotent.
    // Renames the older `demoadviser` account (from earlier sessions) so the
    // demo credentials follow a consistent `wise*` / `wise888` pattern across
    // all three personas (wiseinvestor / wiseadviser / wise).
    try {
      const desiredHash = await hashPassword("wise888");
      const existingWise = await storage.getUserByUsername("wiseadviser");
      const existingDemo = await storage.getUserByUsername("demoadviser");
      if (existingWise) {
        const updates: any = {};
        if (existingWise.role !== "adviser") updates.role = "adviser";
        if (!existingWise.emailVerified) updates.emailVerified = true;
        if (!(await verifyPassword("wise888", existingWise.password))) updates.password = desiredHash;
        // Task #143 — back-fill demo flag on rows that pre-date the column.
        if (!existingWise.isDemo) updates.isDemo = true;
        if (Object.keys(updates).length) await storage.updateUser(existingWise.id, updates);
      } else if (existingDemo) {
        // One-time rename: keeps existing adviser_clients links + audit history intact.
        await storage.updateUser(existingDemo.id, {
          username: "wiseadviser",
          password: desiredHash,
          role: "adviser",
          emailVerified: true,
          isDemo: true,
        } as any);
      } else {
        await storage.createUser({
          username: "wiseadviser",
          email: "wiseadviser@amaxglobal.com.au",
          password: desiredHash,
          firstName: "Wise",
          lastName: "Adviser",
          role: "adviser",
          kycStatus: "verified",
          emailVerified: true,
          isDemo: true,
        } as any);
      }
    } catch (err) {
      console.warn("[seed] wiseadviser demo account seed failed:", (err as Error).message);
    }

    // Seed the `wise` demo admin account (Session 13 — Admin shell).
    // GATED to local dev only — the admin role can approve applications,
    // create advisers, and link clients to advisers. Auto-seeding a known
    // privileged credential in any shared/staging/production environment
    // would be a privilege-escalation backdoor. In real environments the
    // first admin must be provisioned manually.
    if (isLocalDev) {
      try {
        const desiredHash = await hashPassword("wise888");
        const existingWise = await storage.getUserByUsername("wise");
        const existingAdmin = await storage.getUserByUsername("admin");
        if (existingWise) {
          const updates: any = {};
          if (existingWise.role !== "admin") updates.role = "admin";
          if (!existingWise.emailVerified) updates.emailVerified = true;
          if (!(await verifyPassword("wise888", existingWise.password))) updates.password = desiredHash;
          // Task #143 — back-fill demo flag on rows that pre-date the column.
          if (!existingWise.isDemo) updates.isDemo = true;
          if (Object.keys(updates).length) await storage.updateUser(existingWise.id, updates);
        } else if (existingAdmin) {
          // One-time rename: keeps audit history attached to the same user id.
          await storage.updateUser(existingAdmin.id, {
            username: "wise",
            password: desiredHash,
            role: "admin",
            emailVerified: true,
            isDemo: true,
          } as any);
        } else {
          await storage.createUser({
            username: "wise",
            email: "wise@amaxglobal.com.au",
            password: desiredHash,
            firstName: "Wise",
            lastName: "Admin",
            role: "admin",
            kycStatus: "verified",
            userTier: "professional",
            emailVerified: true,
            isDemo: true,
          } as any);
        }
      } catch (err) {
        console.warn("[seed] wise admin demo account seed failed:", (err as Error).message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Auth routes — login, current user, logout
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Task #148 — stricter per-IP rate limits on auth-mutating endpoints
  // ---------------------------------------------------------------------------
  // Layered ON TOP of the global 200/min /api limiter in server/index.ts.
  //
  // Rationale:
  //   * The global limiter exists to soak up burst abuse across the whole
  //     dashboard; 200 req/min per IP is generous enough to cover a real
  //     user with auto-refresh queries open.
  //   * That cap is FAR too generous for credential-guessing or
  //     reset-token enumeration. A single IP could attempt ~12,000 password
  //     guesses per hour and never hit the global limit.
  //   * These three endpoints (login, forgot-password, reset-password) are
  //     the only public surfaces that mutate authentication state, so they
  //     get their own dedicated, much tighter limiters.
  //
  // Sizing notes:
  //   * Login: 10 attempts per 15 min. Generous enough for a user mistyping
  //     their password a few times across a session, tight enough that an
  //     online brute-force is impractical (~40/hour vs ~10⁹ password space).
  //   * Forgot-password: 5 per 15 min. SMTP-cost protection AND a brake on
  //     someone trying to spray reset-token requests for many usernames.
  //   * Reset-password: 10 per 15 min. The token itself has 256-bit entropy
  //     so the limiter is mainly a bot-deterrent — ten chances per IP per
  //     window is more than any real user will ever need.
  //
  // The keyGenerator defaults to req.ip; with `app.set('trust proxy', 1)`
  // already set in server/index.ts, that resolves to the real client IP
  // behind Replit's reverse proxy.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // TASK #163 — Limiter trip recorder + repeat-offender operator alert
  // ---------------------------------------------------------------------------
  // Each of the three auth-surface limiters below wires a `handler` callback
  // that (a) records a structured `audit_logs` row tagged
  // `rate_limit_exceeded` and (b) dispatches an operator alert when the
  // configured per-window threshold is crossed. The recorder is best-effort
  // — failures inside it are logged loudly but never block the 429 response
  // the user is about to receive (otherwise an outage in the alerting path
  // would silently disable the limiter's user-visible behaviour).
  //
  // We send the response with `res.status(options.statusCode).json(options.message)`
  // so the body / status / standard-headers contract stays IDENTICAL to the
  // pre-Task-#163 default-handler behaviour. Adding the handler is purely
  // additive observability.
  // ---------------------------------------------------------------------------
  const { recordRateLimitTrip } = await import("./services/rate-limit-alerts");

  function makeAuthLimiterHandler(limiter: string, route: string) {
    return async (
      req: Request,
      res: Response,
      _next: NextFunction,
      options: RateLimitOptions,
    ) => {
      try {
        await recordRateLimitTrip(req, { limiter, route });
      } catch (err) {
        console.error(
          `[rate-limit-handler] recorder threw for ${limiter} @ ${route}`,
          (err as Error)?.message ?? err,
        );
      }
      // express-rate-limit's `Options.message` is typed as `any` upstream
      // (it can be a string, an object, or a value-determining middleware);
      // we never configure the middleware form on these three limiters, so a
      // narrow `string | object` is the right surface to send.
      const message: string | object =
        typeof options.message === "string" || typeof options.message === "object"
          ? (options.message as string | object)
          : { error: "Too many requests" };
      res.status(options.statusCode).json(message);
    };
  }

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        "Too many sign-in attempts from this address. Please try again in a few minutes.",
    },
    handler: makeAuthLimiterHandler("loginLimiter", "/api/auth/login"),
  });
  const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        "Too many password reset requests. Please wait a few minutes before trying again.",
    },
    handler: makeAuthLimiterHandler(
      "forgotPasswordLimiter",
      "/api/auth/forgot-password",
    ),
  });
  const resetPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        "Too many password reset attempts. Please wait a few minutes before trying again.",
    },
    handler: makeAuthLimiterHandler(
      "resetPasswordLimiter",
      "/api/auth/reset-password",
    ),
  });

  // Login — returns JWT on valid credentials
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
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
      const { email: rawEmail, password, firstName, lastName } = req.body;
      if (!rawEmail || !password || !firstName || !lastName) {
        return res.status(400).json({ error: "All fields are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(String(rawEmail))) {
        return res.status(400).json({ error: "Invalid email address" });
      }
      // Normalise once, at the top — every downstream check (existing user,
      // application lookup, insert) uses the same canonical form so case-only
      // collisions can't slip through.
      const email = normalizeEmail(rawEmail);
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
        email,
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
  // Session 14 — Registration invites (admin invites + approved applications)
  //
  // Two public endpoints, both look up by SHA-256(invite):
  //   GET  /api/auth/registration-invites/validate?invite=...  — surface email + role for the form
  //   POST /api/auth/registration-invites/complete             — actually activate the account
  //
  // Hard rules enforced server-side:
  //   - Invite is single-use (usedAt set inside the same activation tx).
  //   - Invite expires after 48h (server-side; client display only).
  //   - email + role come from the invite row, NEVER from form input.
  //   - username is forced to email; firstName/lastName default to "".
  //   - email must not already belong to a user (else duplicate-email rejection + audit).
  //   - If role=client and adviserUserId set, the new client is auto-linked to
  //     that adviser via adviser_clients in the same tx.
  //   - All steps audited (registration_invite_viewed, registration_account_activated,
  //     registration_invite_rejected_duplicate_email).
  // ---------------------------------------------------------------------------

  // Cheap rate limit — viewing/validating tokens is essentially free, but cap to
  // prevent enumeration sweeps.
  const inviteValidateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  });

  app.get("/api/auth/registration-invites/validate", inviteValidateLimiter, async (req, res) => {
    try {
      const rawInvite = String(req.query.invite || "");
      if (!rawInvite || rawInvite.length < 16) {
        return res.status(400).json({ valid: false, error: "Missing or invalid invitation." });
      }
      const inviteHash = createHash("sha256").update(rawInvite).digest("hex");
      const [inv] = await db
        .select()
        .from(registrationInvites)
        .where(eq(registrationInvites.inviteHash, inviteHash))
        .limit(1);

      if (!inv) {
        return res.status(404).json({ valid: false, error: "Invalid invitation link." });
      }
      if (inv.usedAt) {
        return res.status(410).json({ valid: false, error: "This invitation has already been used." });
      }
      if (inv.expiresAt.getTime() < Date.now()) {
        return res.status(410).json({ valid: false, error: "This invitation has expired." });
      }

      // Spec: validate must reject if a user with this email already exists.
      // We mirror /complete's pair of checks (email + username) here, because
      // /complete forces username = email; without both checks the user would
      // sail past validate and only hit a 409 after typing a password.
      // Audited as registration_invite_rejected_duplicate_email so reviewers
      // can match validate-time rejections to the same action used at /complete.
      const existingByEmail = await storage.getUserByEmail(inv.email);
      const existingByUsername = existingByEmail
        ? null
        : await storage.getUserByUsername(inv.email);
      if (existingByEmail || existingByUsername) {
        await db.insert(auditLogs).values({
          userId: null,
          action: "registration_invite_rejected_duplicate_email",
          entityType: "registration_invite",
          entityId: String(inv.id),
          metadata: { email: inv.email, stage: "validate" },
          ipAddress: req.ip || null,
        });
        return res.status(409).json({
          valid: false,
          error: "An account with this email already exists.",
        });
      }

      // Audit the view fail-closed: a direct insert (not writeAuditLog, which
      // swallows errors) so the response only succeeds if the audit row lands.
      // The viewer is unauthenticated; the invite hash + email pin the row to the
      // identity behind the link.
      await db.insert(auditLogs).values({
        userId: null,
        action: "registration_invite_viewed",
        entityType: "registration_invite",
        entityId: String(inv.id),
        metadata: { email: inv.email, role: inv.role },
        ipAddress: req.ip || null,
      });

      res.json({
        valid: true,
        email: inv.email,
        role: inv.role,
        // expose expiry so the form can show a countdown / warning
        expiresAt: inv.expiresAt.toISOString(),
      });
    } catch (error: any) {
      console.error("[registration-invites/validate] error:", error);
      res.status(500).json({ valid: false, error: "Failed to validate invitation." });
    }
  });

  const registerInviteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many registration attempts. Please try again later." },
  });

  const completeInviteSchema = z.object({
    invite: z.string().min(16).max(128),
    password: z.string().min(8, "password must be at least 8 chars").max(128),
  });

  app.post("/api/auth/registration-invites/complete", registerInviteLimiter, async (req, res) => {
    try {
      const parsed = completeInviteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const { invite: rawInvite, password } = parsed.data;

      const inviteHash = createHash("sha256").update(rawInvite).digest("hex");

      // Pre-flight checks outside the tx so we can return clean error codes.
      // Final atomicity is enforced inside the tx (re-check after locking).
      const [inv] = await db
        .select()
        .from(registrationInvites)
        .where(eq(registrationInvites.inviteHash, inviteHash))
        .limit(1);
      if (!inv) {
        return res.status(404).json({ error: "Invalid invitation link." });
      }
      if (inv.usedAt) {
        return res.status(410).json({ error: "This invitation has already been used." });
      }
      if (inv.expiresAt.getTime() < Date.now()) {
        return res.status(410).json({ error: "This invitation has expired." });
      }

      // Email must not already belong to a real user. Username == email per spec,
      // so the same check covers both columns (both are unique).
      const existingByEmail = await storage.getUserByEmail(inv.email);
      if (existingByEmail) {
        // Audit the duplicate-rejection so we can investigate phishing or
        // double-invite attempts.
        await db.insert(auditLogs).values({
          userId: null,
          action: "registration_invite_rejected_duplicate_email",
          entityType: "registration_invite",
          entityId: String(inv.id),
          metadata: { email: inv.email },
          ipAddress: req.ip || null,
        });
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      const usernameTaken = await storage.getUserByUsername(inv.email);
      if (usernameTaken) {
        // Same audit row name as the email-collision path so reviewers see ALL
        // duplicate-rejection outcomes under `registration_invite_rejected_duplicate_email`.
        // `stage:"complete_username"` distinguishes it from the email-side block.
        await db.insert(auditLogs).values({
          userId: null,
          action: "registration_invite_rejected_duplicate_email",
          entityType: "registration_invite",
          entityId: String(inv.id),
          metadata: { email: inv.email, stage: "complete_username" },
          ipAddress: req.ip || null,
        });
        return res.status(409).json({ error: "An account with this email already exists." });
      }

      const hashed = await hashPassword(password);

      const created = await db.transaction(async (tx) => {
        // Re-fetch + lock the invite row to guarantee single-use even under races.
        const [locked] = await (tx as any)
          .select()
          .from(registrationInvites)
          .where(eq(registrationInvites.inviteHash, inviteHash))
          .for("update")
          .limit(1);
        if (!locked || locked.usedAt || locked.expiresAt.getTime() < Date.now()) {
          throw Object.assign(new Error("This invitation is no longer valid."), { status: 410 });
        }

        // Username = email per spec. firstName/lastName start empty — the user
        // fills them in via profile / KYC. We can't drop the columns (they're
        // notNull on the users table) so empty strings are the spec-compliant default.
        const [newUser] = await (tx as any)
          .insert(users)
          .values({
            username: locked.email.toLowerCase(),
            email: locked.email.toLowerCase(),
            password: hashed,
            firstName: "",
            lastName: "",
            // Role is taken from the (admin-issued) invite, NOT from the form.
            role: locked.role,
            // Clients still need to complete KYC; advisers/admins don't.
            kycStatus: locked.role === "client" ? "pending" : "not_required",
            userTier: "standard",
            // Invite issuance proves the inviter trusts the email; skip a second
            // OTP round-trip so the user lands logged in.
            emailVerified: true,
          })
          .returning();

        // All real users get a portfolio shell (matches /api/auth/register flow).
        await (tx as any).insert(portfolios).values({
          userId: newUser.id,
          totalValue: "0.00",
          cryptoValue: "0.00",
          stablecoinValue: "0.00",
          fiatValue: "0.00",
          investmentValue: "0.00",
          monthlyPnl: "0.00",
          monthlyPnlPercent: "0.00",
        });

        // Optional adviser auto-link (only for client invites with adviserUserId).
        // Re-validate role='adviser' AT ACTIVATION TIME — the adviser's role
        // may have changed (demoted, deleted-then-recycled-id, etc.) between
        // invite issuance and the user redeeming it. If the linked target is
        // no longer an adviser, fail loudly rather than silently linking a
        // client to a regular account.
        if (locked.role === "client" && locked.adviserUserId) {
          const [stillAdviser] = await (tx as any)
            .select({ id: users.id, role: users.role })
            .from(users)
            .where(eq(users.id, locked.adviserUserId))
            .for("update")
            .limit(1);
          if (!stillAdviser || stillAdviser.role !== "adviser") {
            throw Object.assign(
              new Error(
                "The adviser linked to this invitation is no longer available. " +
                  "Please ask an administrator to re-issue the invite.",
              ),
              { status: 409 },
            );
          }
          await (tx as any).insert(adviserClients).values({
            adviserUserId: locked.adviserUserId,
            clientUserId: newUser.id,
            relationshipType: "servicing",
            isActive: true,
          });
        }

        await (tx as any)
          .update(registrationInvites)
          .set({ usedAt: new Date() })
          .where(eq(registrationInvites.id, locked.id));

        // Audit the activation. Use the new user's own id so the row is
        // discoverable from their account history.
        await (tx as any).insert(auditLogs).values({
          userId: newUser.id,
          action: "registration_account_activated",
          entityType: "user",
          entityId: String(newUser.id),
          metadata: {
            via: "registration_invite",
            inviteId: locked.id,
            role: locked.role,
            email: locked.email,
            adviserAutoLinked: locked.role === "client" ? Boolean(locked.adviserUserId) : null,
            relatedEntityType: locked.relatedEntityType,
            relatedEntityId: locked.relatedEntityId,
          },
          ipAddress: req.ip || null,
        });

        return newUser;
      });

      const jwt = signToken({
        userId: created.id,
        username: created.username,
        email: created.email,
        role: created.role,
      });

      return res.status(201).json({
        token: jwt,
        user: {
          id: created.id,
          username: created.username,
          email: created.email,
          firstName: created.firstName,
          lastName: created.lastName,
          role: created.role,
          emailVerified: true,
        },
      });
    } catch (error: any) {
      if (error?.status) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error?.code === "23505") {
        // Race-loser path: a parallel request won the create-user race between
        // our pre-flight checks and our INSERT. Audit the rejection so the
        // duplicate-email trail is complete across pre-flight + race outcomes.
        // The lowercased unique index (`users_email_lower_unique`) catches
        // case-only collisions here too.
        await db.insert(auditLogs).values({
          userId: null,
          action: "registration_invite_rejected_duplicate_email",
          entityType: "registration_invite",
          entityId: null,
          metadata: { stage: "complete_race", constraint: String(error?.constraint || "") },
          ipAddress: req.ip || null,
        }).catch(() => { /* never let audit failure mask the 409 */ });
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      console.error("[registration-invites/complete] error:", error);
      res.status(500).json({ error: "Activation failed. Please try again." });
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

  // Mint a short-lived Sumsub WebSDK access token for the logged-in user.
  // Returns 503 when SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY are unset.
  app.post("/api/kyc/sumsub-token", async (req, res) => {
    try {
      const auth = requireAuth(req);
      const config = loadSumsubConfigFromEnv();
      if (!config) throw new SumsubNotConfiguredError();
      const externalUserId = buildExternalUserId(auth.userId);
      const issued = await mintSumsubAccessToken(externalUserId, config);
      res.json({
        token: issued.token,
        userId: issued.userId,
        externalUserId,
        levelName: issued.levelName,
        expiresInSecs: config.ttlSecs,
      });
    } catch (error: unknown) {
      if (error instanceof SumsubNotConfiguredError) {
        return res.status(503).json({ error: error.message, code: "sumsub_not_configured" });
      }
      if (error instanceof SumsubApiError) {
        console.error("[sumsub] upstream error", error.upstreamStatus, error.upstreamBody);
        return res.status(502).json({ error: "Failed to reach the identity verification provider." });
      }
      const status = (error as { status?: number } | null)?.status;
      const message = error instanceof Error ? error.message : "Unknown error";
      if (status) return res.status(status).json({ error: message });
      console.error("[sumsub] unexpected error", error);
      res.status(500).json({ error: "Failed to start identity verification session." });
    }
  });

  // -------------------------------------------------------------------------
  // Task #403 — Sumsub webhook → automatic kycStatus updates
  // -------------------------------------------------------------------------
  // Sumsub posts review results back to us with an HMAC SHA-256 digest of
  // the raw request body in `x-payload-digest` (algorithm declared via
  // `x-payload-digest-alg`, defaulting to HMAC_SHA256_HEX). The route is
  // intentionally unauthenticated — the signature IS the auth. Any request
  // without a valid digest is rejected with 401 before we touch the DB.
  //
  // The route-scoped `express.raw(...)` middleware mounted in server/index.ts
  // ensures `req.body` is the exact byte buffer Sumsub signed; the global
  // `express.json()` would otherwise have already drained the stream.
  app.post("/api/kyc/sumsub-webhook", async (req, res) => {
    try {
      const config = loadSumsubConfigFromEnv();
      if (!config) {
        // Treat as not-configured: surface 503 so the sender can retry once
        // the operator wires the secret in. Important: do NOT 200-OK or we
        // would silently drop real review events during a config gap.
        return res.status(503).json({ error: "Sumsub webhook not configured" });
      }

      // express.raw gives us a Buffer; defensively coerce in case the route
      // is hit through a test app that didn't mount the raw parser (we then
      // refuse to verify rather than guess).
      const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;
      if (!rawBody) {
        return res.status(400).json({ error: "Raw body required" });
      }

      const digest = req.header("x-payload-digest") || req.header("X-Payload-Digest");
      const alg =
        req.header("x-payload-digest-alg") ||
        req.header("X-Payload-Digest-Alg") ||
        DEFAULT_SUMSUB_DIGEST_ALG;
      const valid = verifyWebhookSignature(rawBody, digest, config.secretKey, alg);
      if (!valid) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Malformed JSON payload" });
      }

      const externalUserId: string | undefined = payload?.externalUserId;
      if (!externalUserId || typeof externalUserId !== "string") {
        return res.status(400).json({ error: "Missing externalUserId" });
      }
      const userId = parseExternalUserId(externalUserId);
      if (userId == null) {
        return res.status(404).json({ error: "Unknown externalUserId" });
      }

      const existing = await storage.getUser(userId);
      if (!existing) {
        return res.status(404).json({ error: "Unknown externalUserId" });
      }

      const reviewStatus: string | undefined = payload?.reviewStatus;
      const reviewAnswer: string | undefined = payload?.reviewResult?.reviewAnswer;
      const nextStatus = mapSumsubReviewToKycStatus({ reviewStatus, reviewAnswer });

      if (!nextStatus) {
        // Notification-style events (e.g. `applicantCreated`) don't carry
        // a review verdict. ACK them so Sumsub stops retrying.
        return res.status(200).json({ ok: true, changed: false, reason: "no_review_verdict" });
      }

      if (existing.kycStatus === nextStatus) {
        return res.status(200).json({ ok: true, changed: false, reason: "already_in_state" });
      }

      // Persist via the storage interface so kycUpdatedAt is auto-stamped
      // (see Task #285 logic in DatabaseStorage.updateUser).
      await storage.updateUser(userId, { kycStatus: nextStatus });

      // Audit row so admins can later trace exactly which webhook event
      // flipped the row. userId here is the affected client (audit_logs
      // rows are user-scoped, not actor-scoped, in this codebase).
      await writeAuditLog(
        userId,
        "kyc_status_changed",
        "user",
        String(userId),
        {
          source: "sumsub_webhook",
          before: existing.kycStatus,
          after: nextStatus,
          reviewStatus: reviewStatus ?? null,
          reviewAnswer: reviewAnswer ?? null,
          applicantId: payload?.applicantId ?? null,
          inspectionId: payload?.inspectionId ?? null,
          correlationId: payload?.correlationId ?? null,
          eventType: payload?.type ?? null,
          externalUserId,
        },
        req.ip || null,
      );

      return res.status(200).json({
        ok: true,
        changed: true,
        userId,
        kycStatus: nextStatus,
      });
    } catch (error: unknown) {
      console.error("[sumsub-webhook] unexpected error", error);
      return res.status(500).json({ error: "Failed to process Sumsub webhook" });
    }
  });

  // -------------------------------------------------------------------------
  // Task #404 — Per-step KYC state
  // -------------------------------------------------------------------------
  // Returns a per-step status (identity / liveness / AML+PEP / source-of-funds)
  // that the compliance page renders independently. The Sumsub data comes
  // from two upstream calls (`/applicants/.../one` + `/requiredIdDocsStatus`)
  // and is cached in-process for KYC_STATE_CACHE_MS so a busy page render
  // doesn't hammer Sumsub. If the upstream call fails (or Sumsub isn't
  // configured) we transparently fall back to the overall-status mapping
  // produced by `buildComplianceOverview`, so the page never goes blank.
  //
  // The response always includes `source` ("sumsub" | "fallback") so the
  // client can distinguish a per-step verdict from an overall-status repeat.
  // -------------------------------------------------------------------------
  app.get("/api/kyc/state", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const result = await loadKycState(userId);
      if (result.kind === "not_found") return res.status(404).json({ error: "User not found" });
      return res.json(result.response);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error("[kyc-state] unexpected error", error);
      res.status(500).json({ error: "Failed to load KYC state" });
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

  // /api/portfolio/allocation — handler lives in
  // `server/portfolio-allocation-route.ts` so an automated test can mount it
  // on a tiny loopback express server with seeded `risk_profiles` rows and
  // assert that two clients with distinct profiles get different
  // `benchmark.targets` payloads (Task #406). Behaviour is preserved
  // byte-for-byte from the previous inline definition — see the registrar
  // file for the full handler comments.
  //
  // Task #405 — the registrar internally also runs the SoA target lookup
  // via `loadLatestSoaTargetAllocation` so an adviser-set target inside a
  // live SOA wins over the risk-profile-derived benchmark.
  registerPortfolioAllocationRoute(app, {
    db,
    calculatePortfolioTotalsAtDate,
  });

  // Real metrics for AI advisory — diversification score, expected return, rebalancing gap, period returns
  // The handler lives in `server/portfolio-real-metrics-route.ts` so it can be
  // mounted on a tiny loopback express server in `portfolio-real-metrics-route.test.ts`
  // and have its allocation-comparison payload + benchmark-resolution paths
  // pinned without booting the full application. See Task #392.
  registerPortfolioRealMetricsRoute(app, {
    storage,
    db,
    calculatePortfolioTotalsAtDate,
    calculateInvestmentTotalsAtDate,
  });

  // Task #155 — Public read-only endpoint for the write kill switch state.
  // Used by client/adviser layouts to render the "temporarily read-only"
  // banner without needing admin credentials. Returns ONLY the booleans +
  // reason — no actor id / timestamps — to keep the public surface minimal.
  // Failures fail-open (returns enabled:false) so a momentary DB blip
  // cannot pop a misleading banner across every screen.
  app.get("/api/system/write-state", async (_req, res) => {
    try {
      const { getWriteKillSwitchState } = await import("./services/write-kill-switch");
      const state = await getWriteKillSwitchState();
      res.json({
        writeKillSwitchEnabled: state.enabled,
        reason: state.reason,
      });
    } catch (e) {
      console.error("[/api/system/write-state] read failed", e);
      res.json({ writeKillSwitchEnabled: false, reason: null });
    }
  });

  // Task #307 — Public read-only endpoint that powers the shell-level
  // <DeductionExecutionBanner /> in the adviser layout. Returns a single
  // boolean: is fee-deduction execution currently enabled? The shell banner
  // is non-dismissable by design — when this endpoint says `enabled: false`
  // the banner renders Task #294's standardised Gate-A copy on every
  // adviser page that touches fees / consents / instructions.
  //
  // Sources of truth (single read, OR-ed together so any one of them being
  // off keeps the banner up):
  //   - The fee_deductions write kill switch (admin can flip this from the
  //     ops console at any time).
  //   - Gate B itself — the "deduction execution" feature flag. This lives
  //     in the same write-kill-switch table for now (kind='fee_deductions');
  //     a future Gate-B unlock will replace this read with a dedicated flag.
  //
  // Failures fail-OPEN — returning `enabled: true` on a DB blip is the
  // safer default because the shell banner exists to WARN advisers, and a
  // momentary unavailability shouldn't pop a misleading "execution is on"
  // signal across every screen. The canonical state is re-read on the
  // next 30s polling tick by the React component.
  app.get("/api/system/deduction-execution-state", async (_req, res) => {
    try {
      const { isKillSwitchActive } = await import("./services/kill-switch");
      const killActive = await isKillSwitchActive("fee_deductions");
      // Future: || (await isGateBEnabled()) — wired here so the React
      // component never has to learn the underlying source of truth.
      const enabled = !killActive;
      res.json({ enabled });
    } catch (e) {
      console.error("[/api/system/deduction-execution-state] read failed", e);
      res.json({ enabled: false });
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
  //
  // Task #22 — balance transparency.
  // Each wallet object carries:
  //   - balanceSource: "ledger"  — every cached balance returned here is
  //     ultimately derived from the double-entry ledger (refreshed inside
  //     each settlement transaction), so the consumer can label it for a
  //     support agent or compliance review.
  //   - hasDrift: true when |cached - SUM(ledger_entries)| >= MATCH_EPSILON
  //     (the SAME tolerance the daily wallet-vs-ledger reconciliation uses).
  //   - driftAmount: signed decimal string (`cached - ledgerSum`), present
  //     ONLY when hasDrift is true. Omitted otherwise to keep the clean
  //     case visually quiet on the wire.
  // We deliberately do NOT auto-correct the cache here — surfacing drift is
  // informational only; resolution is an admin workflow (see roadmap).
  app.get("/api/wallets", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const walletRows = await storage.getWallets(userId);
      const ledgerSums = await getUserLedgerSumsByCurrency(userId);
      const enriched = walletRows.map((w: any) => annotateWalletWithDrift(w, ledgerSums));
      res.json(enriched);
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

  // Server-side account-activity CSV export. Streams the user's full
  // ledger for the requested [from, to] window straight from the DB in
  // keyset-paginated batches, hashes the body as it goes, and writes one
  // audit row per export attempt — `account_activity_exported` on a
  // completed send, `account_activity_export_aborted` if the connection
  // closes before all bytes are flushed.
  const EXPORT_BATCH_SIZE = 500;
  const transactionExportQuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  });

  function csvCell(value: unknown): string {
    if (value == null) return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  const EXPORT_TYPE_LABELS: Record<string, string> = {
    deposit: "Inflow",
    withdrawal: "Outflow",
    exchange: "Conversion",
    transfer: "Transfer",
    crypto_buy: "Acquisition",
    crypto_sell: "Disposal",
    adviser_fee_deduction: "Fee deduction",
    adviser_fee_deduction_reversal: "Fee reversal",
  };

  function slugifyForFilename(value: string | null | undefined): string {
    if (!value) return "user";
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned || "user";
  }

  app.get("/api/transactions/export", async (req, res) => {
    let userId: number;
    try {
      ({ userId } = requireAuth(req));
    } catch (error: any) {
      if (error?.status) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = transactionExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid date range",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { from, to } = parsed.data;

    // Inclusive window: `to` is bumped to end-of-day. Round-trip the
    // parsed date back to YYYY-MM-DD and require an exact match so JS's
    // calendar overflow (e.g. Feb 30 → Mar 2) is rejected outright.
    const parseStrictUtcDate = (s: string): Date | null => {
      const d = new Date(`${s}T00:00:00.000Z`);
      if (!Number.isFinite(d.getTime())) return null;
      if (d.toISOString().slice(0, 10) !== s) return null;
      return d;
    };
    const fromDate = parseStrictUtcDate(from);
    const toBaseDate = parseStrictUtcDate(to);
    if (!fromDate || !toBaseDate) {
      return res.status(400).json({ error: "Could not parse date range" });
    }
    const toDate = new Date(toBaseDate.getTime() + (24 * 60 * 60 * 1000) - 1);
    if (fromDate.getTime() > toDate.getTime()) {
      return res.status(400).json({ error: "from must be on or before to" });
    }

    let userSlug = "user";
    try {
      const userRow = await storage.getUser(userId);
      userSlug = slugifyForFilename(userRow?.username ?? userRow?.email ?? null);
    } catch {
      userSlug = "user";
    }
    const filename = `account-activity_${userSlug}_${from}_${to}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    // Track terminal state via listeners attached BEFORE any body write,
    // so a client that disconnects mid-stream (or before the first byte)
    // is observed deterministically — the audit branch below picks the
    // outcome from `terminal` regardless of when it fired.
    let terminal: "finish" | "close" | "error" | null = null;
    let terminalErr: Error | null = null;
    const settled = new Promise<"finish" | "close" | "error">((resolve) => {
      const fire = (o: "finish" | "close" | "error") => {
        if (terminal !== null) return;
        terminal = o;
        resolve(o);
      };
      res.once("finish", () => fire("finish"));
      res.once("close", () => fire("close"));
      res.once("error", (e: Error) => {
        terminalErr = e;
        fire("error");
      });
    });
    const isAborted = () => terminal !== null && terminal !== "finish";

    const hash = createHash("sha256");
    let byteCount = 0;
    let rowCount = 0;
    class ClientAbortedError extends Error {
      constructor() {
        super("client aborted");
      }
    }
    // Honour backpressure, but race `drain` with `close`/`error` so a
    // dead socket can never leave us awaiting `drain` indefinitely.
    const writeChunk = async (chunk: string): Promise<void> => {
      if (isAborted()) throw new ClientAbortedError();
      const buf = Buffer.from(chunk, "utf-8");
      hash.update(buf);
      byteCount += buf.length;
      const ok = res.write(buf);
      if (ok) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          res.off("drain", onDrain);
          res.off("close", onAbort);
          res.off("error", onAbort);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new ClientAbortedError());
        };
        res.once("drain", onDrain);
        res.once("close", onAbort);
        res.once("error", onAbort);
      });
    };

    const header = [
      "Date", "Type", "Description", "From currency", "To currency",
      "Amount", "Fee", "Exchange rate", "Status",
    ];

    try {
      await writeChunk(header.map(csvCell).join(",") + "\r\n");

      // Keyset pagination over (createdAt ASC, id ASC). Each batch is
      // emitted before the next is fetched, so the full result set is
      // never resident in server memory.
      let cursorCreatedAt: Date | null = null;
      let cursorId: number | null = null;
      while (!isAborted()) {
        const conds = [
          eq(transactions.userId, userId),
          gte(transactions.createdAt, fromDate),
          lte(transactions.createdAt, toDate),
        ];
        if (cursorCreatedAt != null && cursorId != null) {
          conds.push(
            sql`(${transactions.createdAt} > ${cursorCreatedAt} OR (${transactions.createdAt} = ${cursorCreatedAt} AND ${transactions.id} > ${cursorId}))`,
          );
        }
        const batch = await db
          .select()
          .from(transactions)
          .where(and(...conds))
          .orderBy(asc(transactions.createdAt), asc(transactions.id))
          .limit(EXPORT_BATCH_SIZE);

        if (batch.length === 0) break;

        for (const t of batch) {
          const createdAtVal = t.createdAt
            ? new Date(t.createdAt as unknown as string | Date)
            : null;
          const line = [
            createdAtVal ? createdAtVal.toISOString() : "",
            EXPORT_TYPE_LABELS[t.type] ?? t.type,
            t.description ?? "",
            t.fromCurrency ?? "",
            t.toCurrency ?? "",
            t.amount ?? "",
            t.fee ?? "",
            t.exchangeRate ?? "",
            t.status ?? "",
          ].map(csvCell).join(",");
          await writeChunk(line + "\r\n");
          rowCount += 1;
        }

        const last = batch[batch.length - 1];
        cursorCreatedAt = last.createdAt
          ? new Date(last.createdAt as unknown as string | Date)
          : cursorCreatedAt;
        cursorId = last.id;
        if (batch.length < EXPORT_BATCH_SIZE) break;
      }

      if (!isAborted()) res.end();
    } catch (err) {
      if (err instanceof ClientAbortedError) {
        // Connection closed mid-stream. `terminal` is already set; fall
        // through to the audit branch below which will record the abort.
      } else {
        console.error("[transactions/export] export failed", err);
        if (!res.headersSent) {
          return res
            .status(500)
            .json({ error: "Failed to export activity" });
        }
        // Headers already on the wire. Tear the response down so the
        // client gets a truncated body rather than a silent 200, and let
        // the close/error listeners record the outcome below.
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const outcome = await settled;
    const completed = outcome === "finish";
    const action = completed
      ? "account_activity_exported"
      : "account_activity_export_aborted";
    const meta: Record<string, unknown> = {
      from,
      to,
      filename,
      rowCount,
      byteCount,
      contentSha256: hash.digest("hex"),
      outcome,
    };
    const recordedErr = terminalErr as Error | null;
    if (!completed && recordedErr) {
      meta.errorMessage = recordedErr.message.slice(0, 500);
    }

    await writeAuditLog(
      userId,
      action,
      "user",
      String(userId),
      meta,
      req.ip || null,
    );
  });

  // Get FX rates
  // Stale threshold — refresh runs every 15 min; if two cycles miss we flag as stale
  const FX_STALE_THRESHOLD_MS = 30 * 60 * 1000;

  // -------------------------------------------------------------------------
  // Task #22 — wallet balance transparency annotator
  // -------------------------------------------------------------------------
  // Pure function: takes a wallet row and the precomputed map of
  // currency → SUM(ledger_entries) for the user, and returns the same row
  // augmented with `balanceSource`, `hasDrift`, and (when hasDrift) the
  // signed `driftAmount` decimal string. Lives at the route layer because
  // the drift threshold is defined by the reconciliation service, and we
  // want the same tolerance enforced everywhere — not duplicated.
  // -------------------------------------------------------------------------
  function annotateWalletWithDrift(
    wallet: any,
    ledgerSumsByCurrency: Map<string, string>,
  ) {
    const currency = String(wallet?.currency ?? "").toUpperCase();
    const ledgerSumStr = ledgerSumsByCurrency.get(currency) ?? "0";
    const cachedNum = Number(wallet?.balance ?? 0);
    const ledgerNum = Number(ledgerSumStr);
    const drift = cachedNum - ledgerNum;
    const hasDrift = Math.abs(drift) >= MATCH_EPSILON;
    const annotated: any = {
      ...wallet,
      balanceSource: "ledger" as const,
      hasDrift,
    };
    if (hasDrift) annotated.driftAmount = drift.toFixed(8);
    return annotated;
  }

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

      // Rebalancing gap — sum of absolute deviations from the configured benchmark,
      // scaled by 0.5 so the result is a "one-sided" turnover measure (0 = perfectly
      // balanced). Benchmark constants live in `server/config/rebalancing-benchmark.ts`.
      // ILLUSTRATIVE math metric only — NOT a personal target. A personalised target
      // is set by an adviser in a Statement of Advice. The response surfaces
      // `rebalancingBenchmarkType` so callers can present it honestly to the user.
      //
      // Task #388 — delegate to the shared `resolvePerClientBenchmark` helper so
      // this route, `/api/portfolio/allocation`, and `/api/portfolio/real-metrics`
      // all return the same benchmark for a given user. The per-request
      // `riskTolerance` body field is still consumed below for the rule-based
      // recommendation logic, but it is no longer used to pick the benchmark —
      // doing so previously meant a profile-less user could see a different
      // target on the AI page than on their portfolio page.
      //
      // Task #405 — also pull the SoA-set target so the resolver can prefer
      // it over the risk-profile-derived benchmark when an adviser has
      // recorded one inside a live SOA. Lookups run in parallel: they touch
      // disjoint tables and we want the AI page to feel snappy.
      const allocationFractions = {
        fiat:       currentAllocation.fiat       / 100,
        crypto:     currentAllocation.crypto     / 100,
        stablecoin: currentAllocation.stablecoin / 100,
        investment: currentAllocation.investment / 100,
      };
      const [latestRiskProfileRow, latestSoaTarget] = await Promise.all([
        db
          .select({
            allocation: riskProfiles.allocation,
            riskBand: riskProfiles.riskBand,
          })
          .from(riskProfiles)
          .where(eq(riskProfiles.clientId, userId))
          .orderBy(desc(riskProfiles.createdAt))
          .limit(1),
        loadLatestSoaTargetAllocation(db, userId),
      ]);
      const latestRiskProfile = latestRiskProfileRow[0];
      const rebalancingBenchmark = resolvePerClientBenchmark(latestRiskProfile, latestSoaTarget);
      const rebalancingGap = computeRebalancingGap(allocationFractions, rebalancingBenchmark);
      const rebalancingBenchmarkType = rebalancingBenchmark.type;
      const rebalancingBenchmarkNote = rebalancingBenchmark.note;

      // Resolve the recommendation "kind" used to flavour the textual advice
      // below. We mirror the benchmark-resolution policy: when the client has
      // a stored `riskProfiles` row, use its `riskBand` directly so each of
      // the five canonical bands (conservative / moderate / balanced / growth
      // / high_growth) gets its own copy whose thresholds line up with the
      // band's row in `PORTFOLIO_ALLOCATIONS`
      // (`server/services/risk-scoring.ts`). Only fall back to the per-request
      // `riskTolerance` 1–5 number when no profile exists, in which case we
      // emit the legacy 3-tier copy via the `tol_*` fallback kinds so the
      // request-only contract does not break.
      //
      // Task #407 extracted the resolver so it can be unit-tested without
      // spinning up Express (see `scripts/test-recommendation-tier.ts`);
      // Task #408 widened that helper from a 3-tier `RecommendationTier`
      // into a 5-band-plus-fallback `RecommendationKind` so this route can
      // emit per-band copy. The helper also defensively guards against
      // unexpected `riskBand` values (`risk_profiles.risk_band` is plain
      // text with no DB-level enum constraint) — an unknown band falls
      // through to the neutral `moderate` kind rather than silently
      // serving high-growth copy.
      const recommendationKind = resolveRecommendationKind(
        latestRiskProfile,
        riskTolerance,
      );

      // Generate recommendations based on risk profile
      const recommendations: Array<{ userId: number; type: string; title: string; description: string; severity: string; isRead: boolean }> = [];
      const cryptoPct = currentAllocation.crypto.toFixed(1);

      // Risk-based portfolio recommendations.
      //
      // The five band branches below mirror the canonical allocations in
      // `PORTFOLIO_ALLOCATIONS` (`server/services/risk-scoring.ts`):
      //   conservative: cash 25, bonds 45, equities 25, alternatives 5, crypto  0
      //   moderate:     cash 15, bonds 35, equities 45, alternatives 5, crypto  0
      //   balanced:     cash 10, bonds 25, equities 55, alternatives 5, crypto  5
      //   growth:       cash  5, bonds 10, equities 70, alternatives 5, crypto 10
      //   high_growth:  cash  0, bonds  5, equities 75, alternatives 5, crypto 15
      // The three `tol_*` branches at the bottom preserve the legacy copy
      // used when the request has no `riskProfiles` row to read from.
      if (recommendationKind === "conservative") {
        if (currentAllocation.crypto > 5) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Trim Crypto Exposure",
            description: `Your crypto allocation (${cryptoPct}%) is above the conservative target of 0%. Consider trimming to 0-5% and rotating into bonds and cash.`,
            severity: "warning",
            isRead: false,
          });
        }
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Anchor with Bonds and Cash",
          description: "A conservative profile targets ~45% bonds and ~25% cash. Lean on government bonds, high-grade corporate bonds and short-duration cash holdings for stable income.",
          severity: "info",
          isRead: false,
        });
      } else if (recommendationKind === "moderate") {
        if (currentAllocation.crypto > 5) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Trim Crypto Exposure",
            description: `Your crypto allocation (${cryptoPct}%) is above the moderate target of 0%. Consider trimming to 0-5% and redeploying into a 35% bonds / 45% equities mix.`,
            severity: "warning",
            isRead: false,
          });
        }
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Balance Bonds with Core Equities",
          description: "A moderate profile targets ~35% bonds and ~45% equities. Use diversified equity ETFs alongside investment-grade bonds to keep volatility in check while still participating in growth.",
          severity: "info",
          isRead: false,
        });
      } else if (recommendationKind === "balanced") {
        if (currentAllocation.crypto > 10) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Rebalance Crypto Toward Target",
            description: `Your crypto allocation (${cryptoPct}%) exceeds the balanced target of ~5%. Consider trimming to 5-10% so equities and bonds stay near their 55%/25% targets.`,
            severity: "info",
            isRead: false,
          });
        } else if (currentAllocation.crypto < 2) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Add a Small Crypto Sleeve",
            description: `Your crypto allocation (${cryptoPct}%) is below the balanced target of ~5%. A modest 3-5% sleeve adds growth diversification without dominating the portfolio.`,
            severity: "info",
            isRead: false,
          });
        }
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Equity-Tilted Diversification",
          description: "A balanced profile targets ~55% equities and ~25% bonds with a small 5% crypto sleeve. Diversify across global equities and intermediate-duration bonds to capture growth while preserving downside protection.",
          severity: "info",
          isRead: false,
        });
      } else if (recommendationKind === "growth") {
        if (currentAllocation.crypto > 15) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Trim Crypto Toward Growth Target",
            description: `Your crypto allocation (${cryptoPct}%) is above the growth target of ~10%. Consider trimming to 10-15% so equities can do the heavy lifting at their ~70% target.`,
            severity: "info",
            isRead: false,
          });
        } else if (currentAllocation.crypto < 5) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Build Toward the Growth Crypto Sleeve",
            description: `Your crypto allocation (${cryptoPct}%) is below the growth target of ~10%. Consider scaling up to 8-12% and reducing cash, which should sit at only ~5% for a growth profile.`,
            severity: "info",
            isRead: false,
          });
        }
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Lead with Global Equities",
          description: "A growth profile targets ~70% equities, ~10% bonds and ~10% crypto. Concentrate the equity sleeve in diversified global growth funds and keep only a thin bond/cash buffer.",
          severity: "info",
          isRead: false,
        });
      } else if (recommendationKind === "high_growth") {
        if (currentAllocation.crypto > 20) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Cap Crypto Concentration",
            description: `Your crypto allocation (${cryptoPct}%) is above the high-growth target of ~15%. Consider trimming to 15-20% to avoid single-asset concentration eclipsing the ~75% equity sleeve.`,
            severity: "warning",
            isRead: false,
          });
        } else if (currentAllocation.crypto < 10) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Scale Up the Crypto Sleeve",
            description: `Your crypto allocation (${cryptoPct}%) is below the high-growth target of ~15%. A high-growth profile supports a 12-18% crypto sleeve alongside a ~75% equity allocation.`,
            severity: "info",
            isRead: false,
          });
        }
        recommendations.push({
          userId,
          type: "opportunity",
          title: "Maximise Growth and Venture Exposure",
          description: "A high-growth profile targets ~75% equities, ~15% crypto and only ~5% bonds with no cash buffer. Tilt the equity sleeve toward growth stocks, emerging markets and venture-style opportunities — and be prepared for larger drawdowns.",
          severity: "info",
          isRead: false,
        });
      } else if (recommendationKind === "tol_conservative") {
        if (currentAllocation.crypto > 10) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Reduce Crypto Exposure",
            description: `Your crypto allocation (${cryptoPct}%) is high for a conservative profile. Consider reducing to 5-10% and increasing fixed income investments.`,
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
      } else if (recommendationKind === "tol_moderate") {
        if (currentAllocation.crypto > 20) {
          recommendations.push({
            userId,
            type: "rebalancing",
            title: "Moderate Crypto Rebalancing",
            description: `Your crypto allocation (${cryptoPct}%) exceeds moderate risk guidelines. Consider reducing to 15-20% for better risk management.`,
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
      } else { // recommendationKind === "tol_aggressive"
        if (currentAllocation.crypto < 15) {
          recommendations.push({
            userId,
            type: "opportunity",
            title: "Increase Growth Exposure",
            description: `Your crypto allocation (${cryptoPct}%) is conservative. Consider increasing to 25-30% for higher growth potential.`,
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
        rebalancingBenchmarkType,
        rebalancingBenchmarkNote,
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
    // Task #185 — hoist `idemKey` and `userIdForReplay` so the catch handler
    // can replay the winner's stored response when a parallel request loses
    // the SERIALIZABLE race (Postgres SQLSTATE 40001). Mirrors the deposit
    // handler pattern from Task #160.
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let userIdForReplay: number | null = null;
    try {
      const { userId } = requireAuth(req);
      userIdForReplay = userId;
      await requireKyc(userId, storage);
      // Task #146 — kill switch. Master `transactions` switch covers
      // FX exchange (no narrower category exists for this op).
      await assertKillSwitchOff("transactions");

      const parsed = fxExchangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { fromCurrency, toCurrency, amount: rawAmount } = parsed.data;
      const amount = new Decimal(rawAmount);

      // DB-backed idempotency check
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

      // -----------------------------------------------------------------
      // Task #201 — LEDGER IS THE SOURCE OF TRUTH for FX as well.
      // Post BOTH legs as ONE multi-currency journal:
      //   source-currency leg : DEBIT clientSrc(amount), CREDIT suspenseSrc(amount)
      //   target-currency leg : DEBIT suspenseTgt(converted),
      //                         CREDIT clientTgt(netConverted),
      //                         CREDIT feeAccountTgt(fee)
      // Each currency balances independently; the per-currency guard in
      // postLedgerEntries enforces this. Wallet caches for both currencies
      // are then derived from the ledger via refreshWalletCacheBalance —
      // we never call `tx.update(wallets).set({ balance, ... })` directly.
      // -----------------------------------------------------------------
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

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "exchange", fromCurrency, toCurrency,
          amount: amount.toFixed(8), fee: fee.toFixed(8),
          exchangeRate: exchangeRate.toFixed(8), status: "completed",
          settlementStatus: "internal_only",
          description: `${fromCurrency} to ${toCurrency} Exchange`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();

        const clientFrom = await getOrCreateClientAccount(userId, fromCurrency, tx);
        const suspenseFrom = await getOrCreateSuspenseAccount(fromCurrency, tx);
        const clientTo = await getOrCreateClientAccount(userId, toCurrency, tx);
        const suspenseTo = await getOrCreateSuspenseAccount(toCurrency, tx);
        const feeAccountTo = await getOrCreateFeeAccount(toCurrency, tx);

        await postLedgerEntries(txRecord.id, [
          // Source-currency leg
          {
            accountId: clientFrom.id,
            userId,
            currency: fromCurrency,
            direction: "debit",
            amount: amount.toFixed(8),
            description: `FX exchange (source client leg) tx#${txRecord.id}`,
          },
          {
            accountId: suspenseFrom.id,
            userId: suspenseFrom.userId,
            currency: fromCurrency,
            direction: "credit",
            amount: amount.toFixed(8),
            description: `FX exchange (source suspense leg) tx#${txRecord.id}`,
          },
          // Target-currency leg
          {
            accountId: suspenseTo.id,
            userId: suspenseTo.userId,
            currency: toCurrency,
            direction: "debit",
            amount: converted.toFixed(8),
            description: `FX exchange (target suspense leg) tx#${txRecord.id}`,
          },
          {
            accountId: clientTo.id,
            userId,
            currency: toCurrency,
            direction: "credit",
            amount: netConverted.toFixed(8),
            description: `FX exchange (target client leg) tx#${txRecord.id}`,
          },
          {
            accountId: feeAccountTo.id,
            userId: feeAccountTo.userId,
            currency: toCurrency,
            direction: "credit",
            amount: fee.toFixed(8),
            description: `FX exchange (target fee leg) tx#${txRecord.id}`,
          },
        ], tx);

        await refreshWalletCacheBalance(tx, userId, fromCurrency);
        await refreshWalletCacheBalance(tx, userId, toCurrency);
      });

      const responseBody = { transaction: txRecord, convertedAmount: netConverted.toNumber(), exchangeRate: exchangeRate.toNumber(), fee: fee.toNumber() };
      if (idemKey) await saveIdempotentResponse(userId, "/api/fx-exchange", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "fx_exchange", "transaction", String(txRecord?.id), { fromCurrency, toCurrency, amount: rawAmount }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      // Task #185 — replay an idempotent response when a parallel request
      // with the same Idempotency-Key lost the SERIALIZABLE race (SQLSTATE
      // 40001). Runs FIRST so it pre-empts every other branch (including
      // the generic 500 mapper, which a client would otherwise retry —
      // increasing duplicate-processing risk).
      if (userIdForReplay !== null && idemKey) {
        const replay = await replayIdempotentOnSerializationFailure(
          error, userIdForReplay, "/api/fx-exchange", idemKey,
        );
        if (replay) {
          return res.status(200).json({ ...(replay as object), idempotent: true });
        }
      }
      // Task #201 — fx-exchange now posts a multi-currency journal via
      // postLedgerEntries; surface a tripped balance guard the same way
      // deposit/withdraw do (stable 422 + operator alert) instead of
      // leaking the internal credit/debit numbers as a generic 500.
      if (
        await mapLedgerUnbalancedToHttpResponse(res, error, "fx_exchange", {
          route: "/api/fx-exchange",
          ipAddress: req.ip ?? null,
        })
      ) {
        return;
      }
      if (sendKillSwitchResponse(res, error)) return;
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to process FX exchange" });
    }
  });

  // ---------------------------------------------------------------------------
  // Deposit — shared handler used by both canonical and legacy routes.
  // Internal operation: write completed atomically; no pending pre-insert.
  // ---------------------------------------------------------------------------
  const handleDeposit = async (req: Request, res: any) => {
    // Task #160 — `idemKey` and `userIdForReplay` are hoisted out of the try
    // block so the catch handler can replay an idempotent response when a
    // parallel request loses the SERIALIZABLE race (Postgres SQLSTATE 40001).
    // We keep the in-try `userId` as a narrowed `number` (post-requireAuth)
    // so downstream code does not have to re-prove non-null on every use.
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let userIdForReplay: number | null = null;
    try {
      const { userId } = requireAuth(req);
      userIdForReplay = userId;
      await requireKyc(userId, storage);
      // Task #146 — kill switch. Specific `deposits` first so the response
      // names the most precise reason; master `transactions` is the fallback.
      await assertKillSwitchOff("deposits", "transactions");
      const parsedDeposit = depositSchema.safeParse(req.body);
      if (!parsedDeposit.success) return res.status(400).json({ error: parsedDeposit.error.errors[0].message });
      const { currency, amount: rawAmount, description } = parsedDeposit.data;
      const amount = new Decimal(rawAmount);

      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/deposit", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      // -----------------------------------------------------------------
      // LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
      // Order inside the transaction:
      //   1. Lock + verify the wallet row exists (cache must already exist
      //      so the cache-refresh step at the end can update it).
      //   2. Insert the `transactions` row (gives us a transactionId for FK).
      //   3. Get-or-create the user's client account + the platform suspense
      //      account for this currency.
      //   4. Post a balanced ledger pair: DEBIT suspense / CREDIT client.
      //   5. Refresh the wallet cache from SUM(ledger_entries) — the ONLY
      //      sanctioned writer of `wallets.balance`.
      // We never call `tx.update(wallets).set({ balance, availableBalance })`
      // directly. Doing so would bypass the ledger and silently produce
      // drift the daily reconciliation would then surface as a mismatch.
      // -----------------------------------------------------------------
      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [wallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
          .for("update");
        if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "deposit", fromCurrency: null, toCurrency: currency,
          amount: amount.toFixed(8), fee: "0.00000000", exchangeRate: null,
          status: "completed", settlementStatus: "internal_only",
          description: description || `${currency} Deposit`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();

        const clientAccount = await getOrCreateClientAccount(userId, currency, tx);
        const suspenseAccount = await getOrCreateSuspenseAccount(currency, tx);

        // Deposit: funds flow IN from the platform suspense (representing the
        // external rail that delivered the money) into the user's client
        // account. Debit suspense, credit client → balanced.
        await postLedgerEntries(txRecord.id, [
          {
            accountId: suspenseAccount.id,
            userId: suspenseAccount.userId,
            currency,
            direction: "debit",
            amount: amount.toFixed(8),
            description: `Deposit settlement (suspense leg) tx#${txRecord.id}`,
          },
          {
            accountId: clientAccount.id,
            userId,
            currency,
            direction: "credit",
            amount: amount.toFixed(8),
            description: `Deposit settlement (client leg) tx#${txRecord.id}`,
          },
        ], tx);

        await refreshWalletCacheBalance(tx, userId, currency);
      });

      if (idemKey) await saveIdempotentResponse(userId, "/api/deposit", idemKey, payloadHash, txRecord);
      await writeAuditLog(userId, "deposit", "transaction", String(txRecord?.id), { currency, amount: rawAmount }, req.ip || null);
      res.json(txRecord);
    } catch (error: any) {
      // Task #160 — when a parallel deposit with the same Idempotency-Key
      // lost the SERIALIZABLE race (Postgres SQLSTATE 40001), replay the
      // winner's stored response instead of leaking a 500 that a client
      // would naively retry.  Runs FIRST so it pre-empts every other branch
      // (including the unbalanced-ledger 422 mapper, which would otherwise
      // page an operator about a benign concurrency conflict).
      //
      // We use `userIdForReplay` (assigned just inside the try right after
      // requireAuth) rather than `userId` (which is const-scoped INSIDE
      // the try and therefore not visible here). It is non-null whenever
      // the failure happened after auth, which is the only window where a
      // 40001 from the deposit transaction is possible.
      if (userIdForReplay !== null && idemKey) {
        const replay = await replayIdempotentOnSerializationFailure(
          error, userIdForReplay, "/api/deposit", idemKey,
        );
        if (replay) {
          return res.status(200).json({ ...(replay as object), idempotent: true });
        }
      }
      // Task #54 — unbalanced ledger journal (the double-entry invariant
      // tripped) maps to a stable 422 + clean message and pages an
      // operator. We check this BEFORE the generic `error.status` branch
      // because the typed error already carries status=422 — calling the
      // helper here also fires the operator alert (the generic branch
      // would not).
      if (
        await mapLedgerUnbalancedToHttpResponse(res, error, "deposit", {
          route: "/api/deposit",
          ipAddress: req.ip ?? null,
        })
      ) {
        return;
      }
      if (sendKillSwitchResponse(res, error)) return;
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("[deposit] failed", error);
      // Task #156 — money-movement 5xx failures must page an operator. The
      // ledger-unbalanced branch above already does this for the specific
      // 422 case; this catches every OTHER unexpected failure (DB outage,
      // serialization conflict, missing wallet, etc.) so a stuck deposit
      // path doesn't quietly burn for hours before being noticed.
      void notifyMoneyMovementFailure({
        callSite: "deposit",
        error,
        context: {
          route: req.path,
          ipAddress: req.ip ?? null,
          currency: typeof req.body?.currency === "string" ? req.body.currency : null,
        },
      });
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
    // Task #185 — hoist `idemKey` and `userIdForReplay` so the catch handler
    // can replay the winner's stored response when a parallel request loses
    // the SERIALIZABLE race (Postgres SQLSTATE 40001). Mirrors deposit.
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let userIdForReplay: number | null = null;
    try {
      const { userId } = requireAuth(req);
      userIdForReplay = userId;
      await requireKyc(userId, storage);
      // Task #146 — kill switch. Specific `withdrawals` first, master
      // `transactions` second.
      await assertKillSwitchOff("withdrawals", "transactions");
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

      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/withdraw", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      // -----------------------------------------------------------------
      // LEDGER IS THE SOURCE OF TRUTH — wallet cache is derived only.
      // Same shape as the deposit handler above, but the legs are reversed:
      // DEBIT the user's client account, CREDIT the platform suspense
      // account. The fee leg is bundled into the same posting because the
      // dedicated fee engine remains gated; once Gate B lands the fee can
      // be split into its own credit against a fee account.
      // -----------------------------------------------------------------
      let txRecord: any;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const [wallet] = await tx.select().from(wallets)
          .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
          .for("update");
        if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

        const available = new Decimal(wallet.availableBalance);
        if (available.lt(totalDeduction)) throw Object.assign(new Error("Insufficient balance"), { status: 400 });

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "withdrawal", fromCurrency: currency, toCurrency: null,
          amount: amount.toFixed(8), fee: fee.toFixed(8), exchangeRate: null,
          status: "completed", settlementStatus: "internal_only",
          description: description || `${currency} Withdrawal`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();

        const clientAccount = await getOrCreateClientAccount(userId, currency, tx);
        const suspenseAccount = await getOrCreateSuspenseAccount(currency, tx);

        await postLedgerEntries(txRecord.id, [
          {
            accountId: clientAccount.id,
            userId,
            currency,
            direction: "debit",
            amount: totalDeduction.toFixed(8),
            description: `Withdrawal settlement (client leg) tx#${txRecord.id} (incl. fee ${fee.toFixed(8)})`,
          },
          {
            accountId: suspenseAccount.id,
            userId: suspenseAccount.userId,
            currency,
            direction: "credit",
            amount: totalDeduction.toFixed(8),
            description: `Withdrawal settlement (suspense leg) tx#${txRecord.id}`,
          },
        ], tx);

        await refreshWalletCacheBalance(tx, userId, currency);
      });

      if (idemKey) await saveIdempotentResponse(userId, "/api/withdraw", idemKey, payloadHash, txRecord);
      await writeAuditLog(userId, "withdrawal", "transaction", String(txRecord?.id), { currency, amount: rawAmount }, req.ip || null);
      res.json(txRecord);
    } catch (error: any) {
      // Task #185 — replay an idempotent response when a parallel withdrawal
      // with the same Idempotency-Key lost the SERIALIZABLE race (SQLSTATE
      // 40001). Runs FIRST so it pre-empts every other branch — including
      // the unbalanced-ledger 422 mapper, which would otherwise page an
      // operator about a benign concurrency conflict, and the generic 500
      // mapper, which a client would naively retry.
      if (userIdForReplay !== null && idemKey) {
        const replay = await replayIdempotentOnSerializationFailure(
          error, userIdForReplay, "/api/withdraw", idemKey,
        );
        if (replay) {
          return res.status(200).json({ ...(replay as object), idempotent: true });
        }
      }
      // Task #54 — unbalanced ledger journal mapping (see deposit handler
      // above for rationale). The withdrawal path can produce a different
      // unbalanced shape (the fee leg is bundled into the same posting
      // until the dedicated fee engine ships), so this is a real risk
      // surface, not a theoretical one.
      if (
        await mapLedgerUnbalancedToHttpResponse(res, error, "withdrawal", {
          route: "/api/withdraw",
          ipAddress: req.ip ?? null,
        })
      ) {
        return;
      }
      if (sendKillSwitchResponse(res, error)) return;
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("[withdraw] failed", error);
      // Task #156 — see deposit handler above for the rationale.
      void notifyMoneyMovementFailure({
        callSite: "withdrawal",
        error,
        context: {
          route: req.path,
          ipAddress: req.ip ?? null,
          currency: typeof req.body?.currency === "string" ? req.body.currency : null,
        },
      });
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
      // Task #336 — investor-facing product shelf must hide unpublished/test
      // products (Smoke Test Fund, DraftProduct, InRange825, etc.) so
      // clients only see real funds. Admin routes hit storage directly and
      // skip this filter so internal tooling continues to see everything.
      const visible = products.filter((p: any) => p.isActive !== false && p.isPublished !== false);
      res.json(visible);
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
      // Task #336 — direct lookups by id (e.g. deep links into a product
      // page) must also respect the published flag so a leaked id can't
      // expose a draft fund to an investor.
      if ((product as any).isActive === false || (product as any).isPublished === false) {
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

      // Task #336 — investors with multiple lots in the same fund (very
      // common — e.g. two top-ups into the Real Estate Credit Fund) used
      // to see one row per lot here, which made the Individual Investment
      // Products grid look duplicated and made percentages add up wrong.
      // We now bucket by productId, sum the lot values, and surface the
      // raw lots under a `lots` field so an adviser drill-down can still
      // show every contributing position.
      type AggregatedProduct = {
        productId: number;
        name: string;
        value: number;
        investedAmount: number;
        returnAmount: number;
        returnPercentage: number;
        percentage: number;
        lots: any[];
      };
      const categoryMap: Record<string, { name: string; value: number; productMap: Map<number, AggregatedProduct> }> = {};
      for (const item of totals.items) {
        if (!categoryMap[item.category]) {
          categoryMap[item.category] = {
            name: categoryDisplayNames[item.category] ?? item.category,
            value: 0,
            productMap: new Map(),
          };
        }
        categoryMap[item.category].value += item.currentValue ?? 0;
        const existing = categoryMap[item.category].productMap.get(item.productId);
        const lot = {
          investmentId: item.investmentId,
          investedAmount: item.investedAmount,
          currentValue: item.currentValue,
          returnAmount: item.returnAmount,
          returnPercentage: item.returnPercentage,
          investmentDate: item.investmentDate,
        };
        if (existing) {
          existing.value += item.currentValue ?? 0;
          existing.investedAmount += item.investedAmount;
          existing.returnAmount += item.returnAmount;
          existing.lots.push(lot);
        } else {
          categoryMap[item.category].productMap.set(item.productId, {
            productId: item.productId,
            name: item.productName,
            value: item.currentValue ?? 0,
            investedAmount: item.investedAmount,
            returnAmount: item.returnAmount,
            returnPercentage: 0,
            percentage: 0,
            lots: [lot],
          });
        }
      }

      const categories = Object.values(categoryMap)
        .map(cat => ({
          name: cat.name,
          value: cat.value,
          percentage: totals.totalCurrentValue > 0 ? (cat.value / totals.totalCurrentValue) * 100 : 0,
          products: Array.from(cat.productMap.values()).map(p => ({
            ...p,
            // Recompute returnPercentage from the aggregated invested basis
            // so two-lot positions report a coherent blended return.
            returnPercentage: p.investedAmount > 0 ? (p.returnAmount / p.investedAmount) * 100 : 0,
            percentage: totals.totalCurrentValue > 0 ? (p.value / totals.totalCurrentValue) * 100 : 0,
            // Task #354 — surface the most recent top-up first so the
            // expandable lot list in the client matches investor intuition.
            lots: [...p.lots].sort((a, b) => {
              const aTime = a.investmentDate ? new Date(a.investmentDate).getTime() : 0;
              const bTime = b.investmentDate ? new Date(b.investmentDate).getTime() : 0;
              return bTime - aTime;
            }),
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
    // Task #185 — hoist `idemKey` and `userIdForReplay` so the catch handler
    // can replay the winner's stored response when a parallel request loses
    // the SERIALIZABLE race (Postgres SQLSTATE 40001). Mirrors deposit.
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let userIdForReplay: number | null = null;
    try {
      const { userId } = requireAuth(req);
      userIdForReplay = userId;
      await requireKyc(userId, storage);
      // Task #146 — kill switch. Investments are an internal money-movement
      // and don't have their own switch — they fall under `transactions`.
      await assertKillSwitchOff("transactions");
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

      const payloadHash = hashPayload(req.body);
      if (idemKey) {
        const idem = await checkIdempotency(userId, "/api/investments", idemKey, payloadHash);
        if (idem.conflict) return res.status(422).json({ error: "Idempotency-Key reused with a different request payload." });
        if (idem.existing) return res.json({ ...(idem.response as object), idempotent: true });
      }

      const exchangeRateStr = currency !== "USD" ? investmentAmount.div(deductionAmount).toFixed(8) : null;

      // -----------------------------------------------------------------
      // Task #201 — single-currency journal: DEBIT clientSrc(deduction),
      // CREDIT suspenseSrc(deduction). The investment row records what the
      // money was used for; the ledger records WHERE the money went.
      // The wallet cache is then derived from the ledger.
      // -----------------------------------------------------------------
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

        const clientAcct = await getOrCreateClientAccount(userId, currency, tx);
        const suspenseAcct = await getOrCreateSuspenseAccount(currency, tx);

        await postLedgerEntries(txRecord.id, [
          {
            accountId: clientAcct.id,
            userId,
            currency,
            direction: "debit",
            amount: deductionAmount.toFixed(8),
            description: `Investment in ${product.name} tx#${txRecord.id} (client leg)`,
          },
          {
            accountId: suspenseAcct.id,
            userId: suspenseAcct.userId,
            currency,
            direction: "credit",
            amount: deductionAmount.toFixed(8),
            description: `Investment in ${product.name} tx#${txRecord.id} (suspense leg)`,
          },
        ], tx);

        await refreshWalletCacheBalance(tx, userId, currency);
      });

      await saveActualSnapshot(userId);
      const responseBody = { investment: investRecord, transaction: txRecord, newBalance: deductionAmount.toString(), sourceCurrency: currency, message: "Investment created successfully" };
      if (idemKey) await saveIdempotentResponse(userId, "/api/investments", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "investment_created", "investment", String(investRecord?.id), { productId, amount: rawAmount, currency }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      // Task #185 — replay an idempotent response when a parallel request
      // with the same Idempotency-Key lost the SERIALIZABLE race (SQLSTATE
      // 40001). Runs FIRST so it pre-empts the generic 500 mapper, which a
      // client would otherwise retry — risking duplicate investment rows.
      if (userIdForReplay !== null && idemKey) {
        const replay = await replayIdempotentOnSerializationFailure(
          error, userIdForReplay, "/api/investments", idemKey,
        );
        if (replay) {
          return res.status(200).json({ ...(replay as object), idempotent: true });
        }
      }
      // Task #201 — surface a tripped balance guard the same way the other
      // money-movement routes do (stable 422 + operator alert) instead of
      // leaking the internal credit/debit numbers as a generic 500.
      if (
        await mapLedgerUnbalancedToHttpResponse(res, error, "investment", {
          route: "/api/investments",
          ipAddress: req.ip ?? null,
        })
      ) {
        return;
      }
      if (sendKillSwitchResponse(res, error)) return;
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to create investment" });
    }
  });

  // ---------------------------------------------------------------------------
  // Wallet Transfer — atomic SERIALIZABLE + Zod + Decimal + DB idempotency
  // (previously had no validation, no atomicity, no decimal math)
  // ---------------------------------------------------------------------------
  app.post("/api/wallets/transfer", moneyMovementLimiter, async (req, res) => {
    // Task #185 — hoist `idemKey` and `userIdForReplay` so the catch handler
    // can replay the winner's stored response when a parallel request loses
    // the SERIALIZABLE race (Postgres SQLSTATE 40001). Mirrors deposit.
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    let userIdForReplay: number | null = null;
    try {
      const { userId } = requireAuth(req);
      userIdForReplay = userId;
      await requireKyc(userId, storage);
      // Task #146 — kill switch. Wallet conversion is internal money-movement
      // and falls under the master `transactions` switch.
      await assertKillSwitchOff("transactions");
      const parsedTransfer = walletTransferSchema.safeParse(req.body);
      if (!parsedTransfer.success) return res.status(400).json({ error: parsedTransfer.error.errors[0].message });
      const { fromCurrency, toCurrency, amount: rawAmount } = parsedTransfer.data;
      const amount = new Decimal(rawAmount);

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

      // -----------------------------------------------------------------
      // Task #201 — same FX-shaped multi-currency posting as fx-exchange.
      // Source-currency leg: DEBIT clientSrc(amount), CREDIT suspenseSrc(amount).
      // Target-currency leg: DEBIT suspenseTgt(converted),
      //                      CREDIT clientTgt(finalAmount),
      //                      CREDIT feeAccountTgt(fee).
      // Wallet caches for both currencies are derived from the ledger via
      // refreshWalletCacheBalance — no direct `tx.update(wallets)` writes.
      // -----------------------------------------------------------------
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

        [txRecord] = await tx.insert(transactions).values({
          userId, type: "exchange", fromCurrency, toCurrency,
          amount: amount.toFixed(8), fee: fee.toFixed(8),
          exchangeRate: exchangeRate.toFixed(8), status: "completed",
          settlementStatus: "internal_only",
          description: `Converted ${rawAmount} ${fromCurrency} to ${finalAmount.toFixed(8)} ${toCurrency}`,
          sourceExchange: null, blockchainTxHash: null,
        }).returning();

        const clientFrom = await getOrCreateClientAccount(userId, fromCurrency, tx);
        const suspenseFrom = await getOrCreateSuspenseAccount(fromCurrency, tx);
        const clientTo = await getOrCreateClientAccount(userId, toCurrency, tx);
        const suspenseTo = await getOrCreateSuspenseAccount(toCurrency, tx);
        const feeAccountTo = await getOrCreateFeeAccount(toCurrency, tx);

        await postLedgerEntries(txRecord.id, [
          {
            accountId: clientFrom.id,
            userId,
            currency: fromCurrency,
            direction: "debit",
            amount: amount.toFixed(8),
            description: `Wallet transfer (source client leg) tx#${txRecord.id}`,
          },
          {
            accountId: suspenseFrom.id,
            userId: suspenseFrom.userId,
            currency: fromCurrency,
            direction: "credit",
            amount: amount.toFixed(8),
            description: `Wallet transfer (source suspense leg) tx#${txRecord.id}`,
          },
          {
            accountId: suspenseTo.id,
            userId: suspenseTo.userId,
            currency: toCurrency,
            direction: "debit",
            amount: converted.toFixed(8),
            description: `Wallet transfer (target suspense leg) tx#${txRecord.id}`,
          },
          {
            accountId: clientTo.id,
            userId,
            currency: toCurrency,
            direction: "credit",
            amount: finalAmount.toFixed(8),
            description: `Wallet transfer (target client leg) tx#${txRecord.id}`,
          },
          {
            accountId: feeAccountTo.id,
            userId: feeAccountTo.userId,
            currency: toCurrency,
            direction: "credit",
            amount: fee.toFixed(8),
            description: `Wallet transfer (target fee leg) tx#${txRecord.id}`,
          },
        ], tx);

        await refreshWalletCacheBalance(tx, userId, fromCurrency);
        await refreshWalletCacheBalance(tx, userId, toCurrency);
      });

      const responseBody = { transaction: txRecord, exchangeRate: exchangeRate.toNumber(), convertedAmount: converted.toNumber(), fee: fee.toNumber(), finalAmount: finalAmount.toNumber() };
      if (idemKey) await saveIdempotentResponse(userId, "/api/wallets/transfer", idemKey, payloadHash, responseBody);
      await writeAuditLog(userId, "wallet_transfer", "transaction", String(txRecord?.id), { fromCurrency, toCurrency, amount: rawAmount }, req.ip || null);
      res.json(responseBody);
    } catch (error: any) {
      // Task #185 — replay an idempotent response when a parallel request
      // with the same Idempotency-Key lost the SERIALIZABLE race (SQLSTATE
      // 40001). Runs FIRST so it pre-empts the generic 500 mapper, which a
      // client would otherwise retry — risking duplicate transfers.
      if (userIdForReplay !== null && idemKey) {
        const replay = await replayIdempotentOnSerializationFailure(
          error, userIdForReplay, "/api/wallets/transfer", idemKey,
        );
        if (replay) {
          return res.status(200).json({ ...(replay as object), idempotent: true });
        }
      }
      // Task #201 — surface a tripped balance guard the same way deposit /
      // withdraw / fx-exchange do (stable 422 + operator alert) instead of
      // leaking the internal credit/debit numbers as a generic 500.
      if (
        await mapLedgerUnbalancedToHttpResponse(res, error, "wallet_transfer", {
          route: "/api/wallets/transfer",
          ipAddress: req.ip ?? null,
        })
      ) {
        return;
      }
      if (sendKillSwitchResponse(res, error)) return;
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
  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
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

  app.post("/api/auth/reset-password", resetPasswordLimiter, async (req, res) => {
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

  // ---------------------------------------------------------------------------
  // Task #373 — Client KYC & compliance centre view.
  // Returns a single derived view that the `/compliance` page renders end to
  // end (header pills, overall progress counter, sumsub steps, AMAX steps,
  // sumsub footer audit strip, wholesale classification footer). Building this
  // view server-side keeps all of the "what counts as completed / under
  // review / action required" logic in one place.
  // ---------------------------------------------------------------------------
  app.get("/api/compliance/overview", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const overview = await buildComplianceOverview(userId);
      if (!overview) return res.status(404).json({ error: "User not found" });
      res.json(overview);
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error("Compliance overview error:", error);
      res.status(500).json({ error: "Failed to load compliance overview" });
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
  // Task #375 — Risk assessment questionnaire (compliance step A)
  //
  // The compliance centre links to a multi-step questionnaire covering
  // investment experience, objectives, and risk tolerance. The page promises
  // "Save and continue later", so PUT saves partial progress (status stays
  // in_progress) and POST /submit finalises the answers (status flips to
  // complete, submittedAt set). The compliance page reads GET to flip step
  // A from "Action required" to "Complete" and unlock step B.
  // ---------------------------------------------------------------------------
  app.get("/api/risk-assessment", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const response = await storage.getRiskAssessmentResponse(userId);
      res.json({ response: response ?? null });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error("Get risk assessment error:", error);
      res.status(500).json({ error: "Failed to fetch risk assessment" });
    }
  });

  const riskAssessmentSaveSchema = z.object({
    answers: riskAssessmentAnswersSchema.optional(),
    currentStep: z.number().int().min(0).max(3).optional(),
  });

  app.put("/api/risk-assessment", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const parsed = riskAssessmentSaveSchema.parse(req.body ?? {});
      const response = await storage.saveRiskAssessmentProgress(userId, parsed);
      res.json({ response });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0]?.message || "Invalid request" });
      }
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error("Save risk assessment error:", error);
      res.status(500).json({ error: "Failed to save risk assessment" });
    }
  });

  app.post("/api/risk-assessment/submit", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const answers = riskAssessmentSubmitSchema.parse(req.body ?? {});
      const response = await storage.submitRiskAssessmentResponse(userId, answers);
      await writeAuditLog(
        userId,
        "risk_assessment_completed",
        "risk_assessment_response",
        String(response.id),
        { submittedAt: response.submittedAt },
        req.ip || null,
      );
      res.json({ response });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0]?.message || "Invalid request" });
      }
      if (error?.status) return res.status(error.status).json({ error: error.message });
      console.error("Submit risk assessment error:", error);
      res.status(500).json({ error: "Failed to submit risk assessment" });
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
