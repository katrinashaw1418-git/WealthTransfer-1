// =============================================================================
// /api/portfolio/allocation route — extracted registrar (Task #406)
// -----------------------------------------------------------------------------
// The portfolio page renders an actual-vs-target bar for each of the four
// asset classes (fiat / crypto / stablecoin / investment) using the payload
// returned by this endpoint. The fields the UI depends on are:
//
//   * `<class>.value` / `<class>.percentage` — the live allocation
//   * `totalValue`                           — the live total (USD)
//   * `benchmark.type`                       — picks the disclaimer the UI
//                                              shows (`equal_weight_illustrative`
//                                              vs `risk_profile_personalised`)
//   * `benchmark.note`                       — the disclaimer text itself
//   * `benchmark.targets.<class>`            — the per-class target (0–100)
//
// The handler used to live inline in `server/routes.ts`. It moved to this file
// (Task #406) so an automated test can mount it on a tiny loopback express
// server, seed two distinct `risk_profiles` rows, and assert the per-client
// `benchmark.targets` payload differs — without booting the full application.
// The dependency-injection shape (`PortfolioAllocationDeps`) keeps the test
// free of `vi.mock` magic — the test passes plain object stubs for `storage`,
// `db`, and the `calculatePortfolioTotalsAtDate` helper and asserts the JSON
// the route emits.
//
// Task #388 originally moved this handler from a hard-coded equal-weight
// 25/25/25/25 default to per-client benchmark resolution via
// `resolvePerClientBenchmark`. This extraction preserves that behaviour
// byte-for-byte — see scripts/test-portfolio-allocation-per-client.ts for
// the regression that pins it.
// =============================================================================

import type { Express } from "express";
import { desc, eq } from "drizzle-orm";

import { riskProfiles } from "@shared/schema";
import { db as defaultDb } from "./db";
import { requireAuth } from "./auth";
import { resolvePerClientBenchmark } from "./config/rebalancing-benchmark";

export interface PortfolioAllocationTotals {
  fiatValue: number;
  cryptoValue: number;
  stablecoinValue: number;
  investmentValue: number;
  totalValue: number;
}

// The route only needs the DB (for the per-client risk_profiles lookup) and
// the totals helper — it does not touch the `storage` interface directly.
// Keeping the dependency surface minimal makes the test harness lighter
// and the contract easier to audit.
export interface PortfolioAllocationDeps {
  db: Pick<typeof defaultDb, "select">;
  calculatePortfolioTotalsAtDate: (
    userId: number,
    asOfDate: Date,
  ) => Promise<PortfolioAllocationTotals>;
  // `now` exists so tests can pin a deterministic instant. Production code
  // omits this — the route then uses `new Date()` per request.
  now?: () => Date;
}

export function registerPortfolioAllocationRoute(
  app: Express,
  deps: PortfolioAllocationDeps,
): void {
  const {
    db,
    calculatePortfolioTotalsAtDate,
    now: nowProvider = () => new Date(),
  } = deps;

  app.get("/api/portfolio/allocation", async (req, res) => {
    try {
      const { userId } = requireAuth(req);
      const totals = await calculatePortfolioTotalsAtDate(userId, nowProvider());
      const { fiatValue, cryptoValue, stablecoinValue, investmentValue, totalValue } = totals;

      // Task #338 — surface the rebalancing benchmark alongside the live
      // allocation so the portfolio page can render actual-vs-target bars
      // without re-deriving the targets on the client. Targets are returned
      // as percentages (0–100) for easy display alongside the existing
      // `percentage` fields. The note is included verbatim so the client UI
      // can reproduce the same disclaimer the AI flow uses.
      //
      // Task #388 — pick the benchmark per-client rather than serving the
      // shared equal-weight default to everyone. We delegate to
      // `resolvePerClientBenchmark` so this route, the real-metrics route,
      // and the AI-recommendations route all resolve the same benchmark
      // for a given user — never disagreeing on what the target is. A
      // personalised target must still be set by an adviser in a
      // Statement of Advice.
      const [latestRiskProfile] = await db
        .select({ allocation: riskProfiles.allocation })
        .from(riskProfiles)
        .where(eq(riskProfiles.clientId, userId))
        .orderBy(desc(riskProfiles.createdAt))
        .limit(1);
      const benchmark = resolvePerClientBenchmark(latestRiskProfile);
      res.json({
        fiat:       { value: fiatValue,        percentage: totalValue > 0 ? (fiatValue        / totalValue) * 100 : 0 },
        crypto:     { value: cryptoValue,       percentage: totalValue > 0 ? (cryptoValue      / totalValue) * 100 : 0 },
        stablecoin: { value: stablecoinValue,   percentage: totalValue > 0 ? (stablecoinValue  / totalValue) * 100 : 0 },
        investment: { value: investmentValue,   percentage: totalValue > 0 ? (investmentValue  / totalValue) * 100 : 0 },
        totalValue,
        benchmark: {
          type: benchmark.type,
          note: benchmark.note,
          targets: {
            fiat:       benchmark.weights.fiat       * 100,
            crypto:     benchmark.weights.crypto     * 100,
            stablecoin: benchmark.weights.stablecoin * 100,
            investment: benchmark.weights.investment * 100,
          },
        },
      });
    } catch (error: any) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: "Failed to get portfolio allocation" });
    }
  });
}
