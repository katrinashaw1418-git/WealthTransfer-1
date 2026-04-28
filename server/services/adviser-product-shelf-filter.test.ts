// =============================================================================
// Task #308 — adviser product-shelf hygiene on per-client surfaces
// -----------------------------------------------------------------------------
// Locks in the regression on `getAdviserClientHoldings`: any holding whose
// underlying product carries a non-canonical category (e.g. the historical
// `InRange825` with category `x`) must be dropped from the adviser holdings
// table, mirroring the `listAdviserProducts` shelf filter and the
// `createAdviserInstruction` write-path filter so a real adviser never sees
// a leaked test/fixture product on any of the three surfaces.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => {
  // Per-call result queue, identical pattern to the existing
  // adviser-clients-list-live-totals test.
  const dbResults: any[] = [];
  const makeChain = (rows: any) => {
    const p: any = new Proxy(
      { then: (res: any) => Promise.resolve(rows).then(res) },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          return () => p;
        },
      },
    );
    return p;
  };
  const select = vi.fn(() => makeChain(dbResults.shift() ?? []));
  return {
    db: { select, __stage: (rows: any[]) => dbResults.push(rows) },
  };
});

import { db } from "../db";
import { getAdviserClientHoldings } from "./adviser-access";

const stage = (db as any).__stage as (rows: any[]) => void;

const ADVISER = 10;
const CLIENT = 200;

const holding = (id: number, productId: number, category: string, name: string) => ({
  id,
  productId,
  productName: name,
  productCategory: category,
  productSubCategory: null,
  investedAmount: "1000.00",
  currentValue: "1100.00",
  totalReturn: "100.00",
  returnPercent: "10.00",
  status: "active",
  investmentDate: new Date("2025-01-01"),
  maturityDate: null,
});

describe("getAdviserClientHoldings — Task #308 product-shelf hygiene", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("drops holdings whose product category is not on the canonical shelf", async () => {
    // 1st select: assertAdviserClientLink — return a non-empty link row.
    stage([{ adviserUserId: ADVISER, clientUserId: CLIENT, isActive: true }]);
    // 2nd select: holdings join — three rows, only two on the canonical shelf.
    stage([
      holding(1, 11, "venture_capital", "Real Product A"),
      holding(2, 12, "x", "InRange825 (legacy fixture)"),
      holding(3, 13, "real_estate", "Real Product B"),
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await getAdviserClientHoldings(ADVISER, CLIENT);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    expect(rows.map((r) => r.id)).toEqual([1, 3]);
    // The dropped row is logged once with its product id and category so
    // future contamination remains investigable without log spam.
    expect(
      warnings.some(
        (w) =>
          w.includes("excluded holding with unknown product category") &&
          w.includes("productId=12") &&
          w.includes('category="x"'),
      ),
    ).toBe(true);
  });

  it("returns every holding unchanged when all categories are on the canonical shelf", async () => {
    stage([{ adviserUserId: ADVISER, clientUserId: CLIENT, isActive: true }]);
    stage([
      holding(1, 11, "venture_capital", "VC Product"),
      holding(2, 12, "real_estate", "RE Product"),
      holding(3, 13, "cash_deposit", "Cash Product"),
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await getAdviserClientHoldings(ADVISER, CLIENT);
    warnSpy.mockRestore();

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("rejects with 403 when the adviser is not linked to the client", async () => {
    // assertAdviserClientLink returns no rows → throws 403 before holdings query.
    stage([]);

    await expect(getAdviserClientHoldings(ADVISER, CLIENT)).rejects.toMatchObject({
      status: 403,
    });
  });
});
