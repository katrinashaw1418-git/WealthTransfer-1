// =============================================================================
// Adviser portfolio totals are LIVE, not snapshot-stale
// -----------------------------------------------------------------------------
// Locks in the fix for the Cluster 5 bug where the adviser client-detail page
// rendered "Total value: —" for clients with real wallet balances and live
// investments. Root cause: getAdviserClientPortfolio was returning the stale
// `portfolios.totalValue` snapshot column, and nothing in the codebase ever
// updates that column after insert. The fix routes the adviser read through
// the same calculatePortfolioTotalsAtDate engine the client portfolio page
// already uses, so the adviser sees the same number the client sees.
//
// This test isolates the contract by mocking the storage layer and the db
// link-check, so it doesn't need a live Postgres or a multi-table fixture.
// =============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage", () => {
  return {
    storage: {
      getWallets: vi.fn(),
      getTransactions: vi.fn(),
      getFxRate: vi.fn(),
      getUserInvestments: vi.fn(),
      getInvestmentProducts: vi.fn(),
    },
  };
});

vi.mock("../db", () => {
  // Minimal drizzle-style chainable stub. Each select() returns an object
  // whose .from().where().limit() resolves to the row list we want for the
  // call. We stage results via `dbResults` shifted FIFO.
  const dbResults: any[][] = [];
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => dbResults.shift() ?? [],
        // Some helpers don't .limit() — fall back here too.
        then: (res: any) => Promise.resolve(dbResults.shift() ?? []).then(res),
      }),
    }),
  }));
  return {
    db: { select, __stage: (rows: any[]) => dbResults.push(rows) },
  };
});

import { storage } from "../storage";
import { db } from "../db";
import { getAdviserClientPortfolio } from "./adviser-access";

const stage = (db as any).__stage as (rows: any[]) => void;

describe("getAdviserClientPortfolio — live totals", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("computes totalValue from live wallets + investments, ignoring stale portfolios.totalValue", async () => {
    // 1) link check passes
    stage([{ id: 1, adviserUserId: 10, clientUserId: 20, isActive: true }]);
    // 2) snapshot row reports a wildly stale total — we expect this to be IGNORED
    stage([
      {
        id: 99,
        userId: 20,
        totalValue: "0.00",
        cryptoValue: "0.00",
        stablecoinValue: "0.00",
        fiatValue: "0.00",
        investmentValue: "0.00",
        monthlyPnl: "0.00",
        monthlyPnlPercent: "0.00",
        updatedAt: new Date("2025-01-01"),
      },
    ]);
    // 3) wallets list (returned to the adviser as `wallets`)
    stage([
      { id: 1, userId: 20, currency: "USD", balance: "1000000.00", walletType: "fiat" },
      { id: 2, userId: 20, currency: "USDT", balance: "500000.00", walletType: "crypto" },
    ]);

    // Live computation pulls via storage:
    (storage.getWallets as any).mockResolvedValue([
      { currency: "USD", balance: "1000000.00", walletType: "fiat" },
      { currency: "USDT", balance: "500000.00", walletType: "crypto" },
    ]);
    (storage.getTransactions as any).mockResolvedValue([]);
    (storage.getFxRate as any).mockResolvedValue(null);
    (storage.getUserInvestments as any).mockResolvedValue([
      {
        id: 7,
        productId: 1,
        investedAmount: "550000.00",
        investmentDate: new Date("2025-06-01"),
      },
    ]);
    (storage.getInvestmentProducts as any).mockResolvedValue([
      {
        id: 1,
        name: "AMAX Real Estate Fund",
        category: "real_estate",
        annualReturn: "0.00", // zero return so currentValue == invested → easy assertion
        returnMethod: "fixed_annual_simple",
      },
    ]);

    const result = await getAdviserClientPortfolio(10, 20);

    // Snapshot row's stale "0.00" must NOT win.
    expect(result.portfolio).not.toBeNull();
    const total = parseFloat(result.portfolio!.totalValue);
    // 1,000,000 USD fiat + 500,000 USDT stablecoin + 550,000 investment
    expect(total).toBeCloseTo(2_050_000, 0);
    expect(parseFloat(result.portfolio!.fiatValue)).toBeCloseTo(1_000_000, 0);
    expect(parseFloat(result.portfolio!.stablecoinValue)).toBeCloseTo(500_000, 0);
    expect(parseFloat(result.portfolio!.investmentValue)).toBeCloseTo(550_000, 0);
    // Wallets list is still surfaced for the wallet table on the page.
    expect(result.wallets).toHaveLength(2);
  });

  it("rejects when adviser is not linked to the client (no cross-tenant leakage)", async () => {
    // Empty link-check result — assertAdviserClientLink should throw before
    // any client-scoped read happens.
    stage([]);
    await expect(getAdviserClientPortfolio(99, 20)).rejects.toThrow();
    // Storage / valuation must not have been touched.
    expect(storage.getWallets).not.toHaveBeenCalled();
    expect(storage.getUserInvestments).not.toHaveBeenCalled();
  });

  it("returns a non-null portfolio with a live total even when no snapshot row exists", async () => {
    stage([{ id: 1, adviserUserId: 10, clientUserId: 20, isActive: true }]);
    stage([]); // no snapshot row at all
    stage([{ id: 1, userId: 20, currency: "USD", balance: "100.00", walletType: "fiat" }]);

    (storage.getWallets as any).mockResolvedValue([
      { currency: "USD", balance: "100.00", walletType: "fiat" },
    ]);
    (storage.getTransactions as any).mockResolvedValue([]);
    (storage.getFxRate as any).mockResolvedValue(null);
    (storage.getUserInvestments as any).mockResolvedValue([]);
    (storage.getInvestmentProducts as any).mockResolvedValue([]);

    const result = await getAdviserClientPortfolio(10, 20);

    expect(result.portfolio).not.toBeNull();
    expect(parseFloat(result.portfolio!.totalValue)).toBeCloseTo(100, 2);
    expect(result.portfolio!.id).toBeNull();
  });
});
