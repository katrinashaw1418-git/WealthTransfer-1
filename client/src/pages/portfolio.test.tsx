// @vitest-environment jsdom
//
// Task #397 — guardrail for the expanded-lot subtotal strip.
//
// The subtotal row added in Task #355 must report the SAME invested,
// current and return values as the parent product row. The risk we are
// catching here is a subtle regression where someone re-sums per-lot
// values to produce the subtotal — that reintroduces the historical
// drift between the headline and the lot drawer (lots can be deleted,
// re-priced, or otherwise diverge from the aggregated parent fields
// returned by /api/investment-breakdown). This test pins the contract:
// the strip MUST read the parent `product.investedAmount`, `product.value`
// and `product.returnPercentage` directly.
//
// To detect a re-sum regression deterministically the fixture below uses
// per-lot values whose sums DO NOT equal the parent product fields. If
// the implementation switches to summing lots, the assertions on the
// rendered text will fail with an unmistakable mismatch.

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";

const SINGLE_LOT_PRODUCT = {
  productId: 11,
  name: "Single-Lot Venture Fund",
  value: 50_000,
  investedAmount: 40_000,
  returnAmount: 10_000,
  returnPercentage: 25,
  percentage: 33.3,
  lots: [
    {
      investmentId: 101,
      investedAmount: 40_000,
      currentValue: 50_000,
      returnAmount: 10_000,
      returnPercentage: 25,
      investmentDate: "2026-02-01T00:00:00.000Z",
    },
  ],
};

// Multi-lot fixture — lot sums (75_000 invested / 95_000 current /
// 25_000 return, ~33.33%) are intentionally DIFFERENT from the parent
// product fields (80_000 invested / 100_000 current / 25.00%) so a
// regression that re-sums per-lot values cannot accidentally produce
// the same rendered output.
const MULTI_LOT_PRODUCT = {
  productId: 22,
  name: "Real Estate Credit Fund",
  value: 100_000,
  investedAmount: 80_000,
  returnAmount: 20_000,
  returnPercentage: 25,
  percentage: 66.6,
  lots: [
    {
      investmentId: 201,
      investedAmount: 50_000,
      currentValue: 65_000,
      returnAmount: 15_000,
      returnPercentage: 30,
      investmentDate: "2026-03-15T00:00:00.000Z",
    },
    {
      investmentId: 202,
      investedAmount: 25_000,
      currentValue: 30_000,
      returnAmount: 5_000,
      returnPercentage: 20,
      investmentDate: "2026-01-10T00:00:00.000Z",
    },
  ],
};

const BREAKDOWN_FIXTURE = {
  totalInvested: 120_000,
  totalCurrentValue: 150_000,
  totalReturn: 30_000,
  totalReturnPercent: 25,
  categories: [
    {
      name: "Venture Capital",
      value: 50_000,
      percentage: 33.3,
      products: [SINGLE_LOT_PRODUCT],
    },
    {
      name: "Real Estate",
      value: 100_000,
      percentage: 66.6,
      products: [MULTI_LOT_PRODUCT],
    },
  ],
};

// recharts measures DOM dimensions through ResponsiveContainer; in jsdom
// every element has zero width/height which floods stderr with warnings
// and contributes nothing to this test. Stub each named export the page
// imports with a no-op component that simply renders its children.
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: any }) => children ?? null;
  return {
    PieChart: Stub,
    Pie: Stub,
    Cell: Stub,
    ResponsiveContainer: Stub,
    BarChart: Stub,
    Bar: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
    LineChart: Stub,
    Line: Stub,
  };
});

vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolio: () => ({
    data: { monthlyPnl: null, monthlyPnlPercent: null },
    isLoading: false,
  }),
  useWallets: () => ({ data: [], isLoading: false }),
  useUserInvestments: () => ({ data: [], isLoading: false }),
  usePortfolioAllocation: () => ({
    data: {
      totalValue: 150_000,
      fiat: { value: 0, percentage: 0 },
      crypto: { value: 0, percentage: 0 },
      stablecoin: { value: 0, percentage: 0 },
      investment: { value: 150_000, percentage: 100 },
    },
    isLoading: false,
  }),
}));

// The page imports useQuery / useQueryClient directly for the breakdown,
// performance chart, history, etc. We keep the rest of react-query intact
// and only stub the hooks the page consumes so the test renders
// synchronously with the fixture above and never touches the network.
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: unknown }) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === "/api/investment-breakdown") {
        return { data: BREAKDOWN_FIXTURE, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    },
    useQueryClient: () => ({
      invalidateQueries: () => {},
      refetchQueries: () => {},
      getQueryData: () => undefined,
      setQueryData: () => {},
    }),
  };
});

describe("Portfolio — expanded lot drawer subtotal strip", () => {
  beforeEach(() => {
    // ResizeObserver is referenced by some shadcn/radix primitives during
    // mount; jsdom doesn't ship one.
    if (!(globalThis as any).ResizeObserver) {
      (globalThis as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  afterEach(() => {
    cleanup();
  });

  async function renderPortfolio() {
    const { default: Portfolio } = await import("./portfolio");
    return render(<Portfolio />);
  }

  it("renders the multi-lot subtotal from the parent product fields, not summed lots", async () => {
    await renderPortfolio();

    const productKey = `Real Estate-${MULTI_LOT_PRODUCT.productId}`;

    // Expand the lot drawer so the subtotal strip mounts.
    fireEvent.click(screen.getByTestId(`toggle-lots-${productKey}`));

    const subtotal = screen.getByTestId(`lots-subtotal-${productKey}`);
    const text = subtotal.textContent ?? "";

    // Lot count + invested basis come from the PARENT product, not Σ lots.
    expect(text).toContain(`${MULTI_LOT_PRODUCT.lots.length} lots`);
    expect(text).toContain("Invested $80,000");
    expect(text).toContain("Current $100,000");
    expect(text).toContain("Return +25.00%");

    // Sanity: re-summing the lots would yield $75,000 / $95,000 — these
    // strings MUST NOT appear if the implementation reads parent fields.
    expect(text).not.toContain("Invested $75,000");
    expect(text).not.toContain("Current $95,000");

    // The headline next to the product name shows the same `value` field
    // that drives the subtotal "Current" amount; both are derived from
    // product.value so they stay in lockstep.
    const productRow = screen.getByTestId(`product-row-${productKey}`);
    expect(within(productRow).getAllByText("$100K").length).toBeGreaterThan(0);
  });

  it("renders the single-lot subtotal with singular wording and parent values", async () => {
    await renderPortfolio();

    const productKey = `Venture Capital-${SINGLE_LOT_PRODUCT.productId}`;

    fireEvent.click(screen.getByTestId(`toggle-lots-${productKey}`));

    const subtotal = screen.getByTestId(`lots-subtotal-${productKey}`);
    const text = subtotal.textContent ?? "";

    // Singular noun, not "1 lots".
    expect(text).toMatch(/\b1 lot\b/);
    expect(text).not.toMatch(/\b1 lots\b/);

    expect(text).toContain("Invested $40,000");
    expect(text).toContain("Current $50,000");
    expect(text).toContain("Return +25.00%");
  });
});
