// =============================================================================
// Task #357 — pin the contract that the snapshot re-anchor produces the
// same totals as the live dashboard.
// -----------------------------------------------------------------------------
// `scripts/refresh-portfolio-snapshots-aud.ts` rebuilds historical
// `portfolio_snapshots` rows by calling `calculatePortfolioTotalsAtDate`,
// the same helper that powers the live `/api/portfolio` endpoint. If a
// future refactor swapped one out for a different valuation path the two
// could silently drift apart, re-introducing the kind of stale-AUD gap
// Task #351 was created to fix.
//
// This integration-style test seeds a deterministic user with crypto +
// stablecoin + fiat wallets (plus an investment) via the storage mock,
// runs the re-anchor in --apply mode, captures the row written for
// "today", and asserts its `totalValue` exactly matches the value the
// live API would compute for the same user/date.
//
// Storage and db are mocked so the test stays fast and deterministic and
// does not require a populated Postgres fixture.
// =============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "portfolio-snapshot-reanchor-test-secret";
});

vi.mock("../storage", () => {
  return {
    storage: {
      getWallets: vi.fn(),
      getTransactions: vi.fn(),
      getFxRate: vi.fn(),
      getUserInvestments: vi.fn(),
      getInvestmentProducts: vi.fn(),
      getPortfolioSnapshots: vi.fn(),
    },
  };
});

vi.mock("../db", () => {
  // Captures every `tx.insert(portfolioSnapshots).values(...)` payload the
  // re-anchor would write. The transaction stub immediately invokes the
  // callback so the script's `await db.transaction(...)` path runs end-to-end.
  const inserts: any[] = [];
  const deletes: any[] = [];
  const tx = {
    execute: vi.fn(async (q: any) => {
      deletes.push(q);
      return { rows: [] };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: any) => {
        inserts.push(v);
      }),
    })),
  };
  return {
    db: {
      transaction: vi.fn(async (fn: any) => fn(tx)),
      select: vi.fn(),
      __getInserts: () => inserts,
      __resetInserts: () => {
        inserts.length = 0;
        deletes.length = 0;
      },
    },
  };
});

import { storage } from "../storage";
import { db } from "../db";
import { calculatePortfolioTotalsAtDate } from "./portfolio-valuation";
import { rebuildForUser } from "../../scripts/refresh-portfolio-snapshots-aud";

const getInserts = (db as any).__getInserts as () => any[];
const resetInserts = (db as any).__resetInserts as () => void;

// Pricing snapshot used across the assertions:
//   BTC/AUD = 144,178 (direct)
//   ETH/USD =   6,500 (no direct ETH/AUD — chains via USD)
//   USD/AUD =  1.4825
const FX: Record<string, { rate: string }> = {
  "BTC|AUD": { rate: "144178" },
  "ETH|USD": { rate: "6500" },
  "USD|AUD": { rate: "1.4825" },
};

function seedFixtureUser() {
  // A deterministic mix that exercises every wallet bucket:
  //   - fiat AUD  : passes through unchanged
  //   - fiat USD  : direct USD→AUD
  //   - crypto BTC: direct BTC→AUD
  //   - crypto ETH: chained ETH→USD→AUD (this is the path #336 fixed)
  //   - stable USDT: 1:1 USD then USD→AUD
  (storage.getWallets as any).mockResolvedValue([
    { currency: "AUD", balance: "5000.00", walletType: "fiat" },
    { currency: "USD", balance: "1000.00", walletType: "fiat" },
    { currency: "BTC", balance: "0.05", walletType: "crypto" },
    { currency: "ETH", balance: "2.00", walletType: "crypto" },
    { currency: "USDT", balance: "1000.00", walletType: "crypto" },
  ]);
  (storage.getTransactions as any).mockResolvedValue([]);
  (storage.getFxRate as any).mockImplementation(
    async (base: string, target: string) => FX[`${base}|${target}`] ?? null,
  );
  // One simple investment so investmentValue is non-zero. Zero annual
  // return + simple-interest method ⇒ currentValue == invested, which
  // keeps the assertion arithmetic obvious.
  (storage.getUserInvestments as any).mockResolvedValue([
    {
      id: 1,
      productId: 1,
      investedAmount: "10000.00",
      investmentDate: new Date("2025-01-01T00:00:00.000Z"),
    },
  ]);
  (storage.getInvestmentProducts as any).mockResolvedValue([
    {
      id: 1,
      name: "AMAX Real Estate Fund",
      category: "real_estate",
      annualReturn: "0.00",
      returnMethod: "fixed_annual_simple",
    },
  ]);
  (storage.getPortfolioSnapshots as any).mockResolvedValue([]);
}

describe("snapshot re-anchor matches live dashboard totals (Task #357)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetInserts();
  });

  it("writes a 'today' snapshot whose totals exactly equal calculatePortfolioTotalsAtDate", async () => {
    seedFixtureUser();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // The live API total — what the dashboard would render right now.
    const live = await calculatePortfolioTotalsAtDate(123, today);

    // Run the re-anchor for a 1-day window (today only) in apply mode.
    const result = await rebuildForUser(123, today, today, true);

    expect(result.daysRebuilt).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);

    const inserts = getInserts();
    expect(inserts).toHaveLength(1);

    const row = inserts[0];
    const todayKey = today.toISOString().split("T")[0];

    // Today's row is marked `actual` (not `historical_estimate`) — same
    // convention as the daily snapshot writer in routes.ts.
    expect(row.source).toBe("actual");
    expect(row.userId).toBe(123);
    expect(row.snapshotDate.toISOString().split("T")[0]).toBe(todayKey);

    // The contract: every bucket the re-anchor writes must equal the
    // value the live dashboard would compute, to the cent. If anyone
    // ever rewires the script to a different valuation path this test
    // breaks immediately.
    expect(row.totalValue).toBe(live.totalValue.toFixed(2));
    expect(row.fiatValue).toBe(live.fiatValue.toFixed(2));
    expect(row.cryptoValue).toBe(live.cryptoValue.toFixed(2));
    expect(row.stablecoinValue).toBe(live.stablecoinValue.toFixed(2));
    expect(row.investmentValue).toBe(live.investmentValue.toFixed(2));

    // And the `newTodayTotal` reported back to the operator matches too.
    expect(result.newTodayTotal).toBeCloseTo(live.totalValue, 6);
  });

  it("rebuilds a multi-day window with each day's snapshot matching the live calculation for that date", async () => {
    seedFixtureUser();

    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 2); // 3-day window

    const result = await rebuildForUser(456, start, end, true);

    expect(result.daysRebuilt).toBe(3);
    const inserts = getInserts();
    expect(inserts).toHaveLength(3);

    // For each day in the window, the inserted totals must match what
    // calculatePortfolioTotalsAtDate would compute for the same date.
    for (const row of inserts) {
      const live = await calculatePortfolioTotalsAtDate(456, row.snapshotDate);
      expect(row.totalValue).toBe(live.totalValue.toFixed(2));
      expect(row.fiatValue).toBe(live.fiatValue.toFixed(2));
      expect(row.cryptoValue).toBe(live.cryptoValue.toFixed(2));
      expect(row.stablecoinValue).toBe(live.stablecoinValue.toFixed(2));
      expect(row.investmentValue).toBe(live.investmentValue.toFixed(2));
    }

    // Today is `actual`; the older days are `historical_estimate`.
    const todayKey = end.toISOString().split("T")[0];
    for (const row of inserts) {
      const dayKey = row.snapshotDate.toISOString().split("T")[0];
      expect(row.source).toBe(dayKey === todayKey ? "actual" : "historical_estimate");
    }
  });

  it("does not write to the DB in dry-run mode", async () => {
    seedFixtureUser();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const result = await rebuildForUser(789, today, today, false);

    // The computed totals are still returned, but no transaction runs.
    expect(result.daysRebuilt).toBe(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(getInserts()).toHaveLength(0);
  });
});
