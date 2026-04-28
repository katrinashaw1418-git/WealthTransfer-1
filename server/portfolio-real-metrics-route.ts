// =============================================================================
// /api/portfolio/real-metrics route — extracted registrar
// -----------------------------------------------------------------------------
// The AI Advisory page renders an asset-class allocation comparison card and a
// rebalancing-gap figure built from this endpoint's payload. The fields the UI
// depends on are:
//
//   * `currentAllocation`    — { fiat, crypto, stablecoin, investment } in %
//   * `benchmarkAllocation`  — { fiat, crypto, stablecoin, investment } in %
//   * `hasAllocationData`    — false when the portfolio is empty so the UI can
//                              show a placeholder rather than a row of zeros
//   * `rebalancingBenchmarkType` / `rebalancingBenchmarkNote`
//                            — chosen by `resolveBenchmarkForRiskProfileRow`
//                              when the client has a recorded risk-profile,
//                              and by the equal-weight fallback otherwise
//
// The handler used to live inline in `server/routes.ts`. It moved to this file
// (Task #392) so an automated test can mount it on a tiny loopback express
// server and pin the wire shape + the personalised vs. fallback benchmark
// resolution without booting the full application. The dependency-injection
// shape (`PortfolioRealMetricsDeps`) keeps the test free of `vi.mock` magic
// — the test passes plain object stubs for `storage`, `db`, and the two
// portfolio-totals helpers and asserts the JSON the route emits.
// =============================================================================

import type { Express } from "express";
import { desc, eq } from "drizzle-orm";

import { riskProfiles } from "@shared/schema";
import { storage as defaultStorage } from "./storage";
import { db as defaultDb } from "./db";
import { requireAuth } from "./auth";
import {
  buildAllocationComparisonPayload,
  buildBenchmarkDerivation,
  computeRebalancingGap,
  resolvePerClientBenchmark,
} from "./config/rebalancing-benchmark";

export interface PortfolioTotals {
  fiatValue: number;
  cryptoValue: number;
  stablecoinValue: number;
  investmentValue: number;
  totalValue: number;
}

export interface InvestmentTotals {
  hasUnpricedAssets: boolean;
}

export interface PortfolioRealMetricsDeps {
  storage: Pick<
    typeof defaultStorage,
    "getUserInvestments" | "getInvestmentProduct" | "getPortfolioSnapshots"
  >;
  db: Pick<typeof defaultDb, "select">;
  calculatePortfolioTotalsAtDate: (userId: number, asOfDate: Date) => Promise<PortfolioTotals>;
  calculateInvestmentTotalsAtDate: (
    userId: number,
    asOfDate: Date,
  ) => Promise<InvestmentTotals>;
  // `now` exists so tests can pin a deterministic instant. Production code
  // omits this — the route then uses `new Date()` per request.
  now?: () => Date;
}

export function registerPortfolioRealMetricsRoute(
  app: Express,
  deps: PortfolioRealMetricsDeps,
): void {
  const {
    storage,
    db,
    calculatePortfolioTotalsAtDate,
    calculateInvestmentTotalsAtDate,
    now: nowProvider = () => new Date(),
  } = deps;

  app.get("/api/portfolio/real-metrics", async (req, res) => {
    try {
      const { userId } = requireAuth(req);

      // Reuse the shared valuation engine for allocation fractions
      const requestNow = nowProvider();
      const totals = await calculatePortfolioTotalsAtDate(userId, requestNow);
      const { fiatValue, cryptoValue, stablecoinValue, investmentValue, totalValue } = totals;

      // Get investment-level detail for hasUnpricedAssets flag
      const investmentTotals = await calculateInvestmentTotalsAtDate(userId, requestNow);
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

      // Rebalancing gap — one-sided turnover from the configured benchmark [0, 50%].
      // ILLUSTRATIVE math metric only — NOT a personal target. The benchmark constants
      // live in `server/config/rebalancing-benchmark.ts` so they can be audited in one
      // place. We resolve the benchmark from the client's latest recorded risk-profile
      // allocation when one exists; otherwise we fall back to the equal-weight default
      // and let the UI surface that fallback explicitly. A personalised target must
      // still be set by an adviser in a Statement of Advice — neither path is a target.
      const [latestRiskProfile] = await db
        .select({ allocation: riskProfiles.allocation })
        .from(riskProfiles)
        .where(eq(riskProfiles.clientId, userId))
        .orderBy(desc(riskProfiles.createdAt))
        .limit(1);
      const rebalancingBenchmark = resolvePerClientBenchmark(latestRiskProfile);
      const rebalancingGap = computeRebalancingGap(alloc, rebalancingBenchmark) * 100;
      const rebalancingBenchmarkType = rebalancingBenchmark.type;
      const rebalancingBenchmarkNote = rebalancingBenchmark.note;

      // Per-bucket derivation payload — only meaningful when the personalised
      // benchmark is in use (the equal-weight fallback isn't projected from
      // a risk-profile row, so there's nothing to derive). The client renders
      // the popover under each bucket label directly from this payload, so
      // the formula and explanation can never silently disagree with the
      // math `resolveBenchmarkForRiskProfileRow` ran above (task #402). Both
      // the math and the payload come from `RISK_PROFILE_BENCHMARK_DERIVATION`
      // in `server/config/rebalancing-benchmark.ts`.
      const benchmarkDerivation =
        rebalancingBenchmarkType === "risk_profile_personalised"
          ? buildBenchmarkDerivation()
          : null;

      // Snapshot history for period returns
      const now = requestNow;
      const yearStart = new Date(now.getFullYear(), 0, 1);
      yearStart.setHours(0, 0, 0, 0);
      const snapshots = await storage.getPortfolioSnapshots(userId, yearStart, now);
      const sorted = [...snapshots].sort(
        (a: any, b: any) => new Date(a.snapshotDate).getTime() - new Date(b.snapshotDate).getTime(),
      );
      const historySource = sorted.some((s: any) => s.source === "historical_estimate")
        ? "historical_estimate" : "actual";

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
            ? +((latestValue / startVal - 1) * 100).toFixed(2)
            : +((Math.pow(latestValue / startVal, 1 / years) - 1) * 100).toFixed(2);
        }
      }

      // ── Risk metric computation (arithmetic returns, consistent framework) ──────
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

      const canShowSharpe =
        dailyReturns.length >= 20 &&
        Number.isFinite(returnStd)  &&
        Number.isFinite(returnMean) &&
        returnStd > 0.0001;
      const sharpe: number | null = canShowSharpe
        ? +(((returnMean - riskFreeDaily) / returnStd) * Math.sqrt(365)).toFixed(2)
        : null;

      const canShowVolatility =
        dailyReturns.length >= 20 &&
        Number.isFinite(returnStd) &&
        returnStd > 0.0001;
      const annualizedVolatility: number | null = canShowVolatility
        ? +(returnStd * Math.sqrt(365) * 100).toFixed(2)
        : null;

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

      const hasSufficientHistory = sorted.length >= 30;
      const actualSnapshotCount  = sorted.filter((s: any) => s.source === "actual").length;

      // Per-asset-class allocation comparison numbers, expressed as percentages
      // (0–100) so the UI can render them directly without re-multiplying. The
      // current weights come from the live portfolio valuation above; the
      // benchmark weights come from the same `rebalancingBenchmark` we already
      // resolved for the rebalancing-gap calculation, keeping the two sides
      // consistent. `hasAllocationData` lets the client decide whether to show
      // the comparison or a "no data" placeholder without inferring it from
      // other fields. The payload is built by `buildAllocationComparisonPayload`
      // so the wire shape and the 1-decimal rounding rule live in one
      // auditable place that the route-level test can pin without
      // re-implementing the math here.
      const allocationComparison = buildAllocationComparisonPayload(
        alloc,
        rebalancingBenchmark,
        totalValue > 0,
      );
      const {
        currentAllocation: currentAllocationPct,
        benchmarkAllocation: benchmarkAllocationPct,
        hasAllocationData,
      } = allocationComparison;

      res.json({
        diversificationScore: +diversificationScore.toFixed(1),
        contractedInvestmentReturn,
        hasProductRateCoverage,
        rebalancingGap: +rebalancingGap.toFixed(1),
        rebalancingBenchmarkType,
        rebalancingBenchmarkNote,
        benchmarkDerivation,
        currentAllocation: currentAllocationPct,
        benchmarkAllocation: benchmarkAllocationPct,
        hasAllocationData,
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
}
