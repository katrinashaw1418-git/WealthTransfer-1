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
import { TooltipProvider } from "@/components/ui/tooltip";

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
    return render(
      <TooltipProvider>
        <Portfolio />
      </TooltipProvider>,
    );
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

// Task #412 — guardrail for the per-lot "X% of position" label added in
// Task #396. The shares are derived from the lot invested amounts and use
// largest-remainder rounding so the displayed integer percentages must
// always sum to exactly 100% (not 99% or 101%, which is what naive
// per-lot Math.round produces). A future change to the lot data shape,
// sort order, or rounding could quietly break that invariant; these
// tests pin it down. The zero-sum case also locks in that we never
// render "NaN%" (or any share label at all) when there's no basis to
// divide by.

// Three lots whose exact shares are 33.33% each — naive per-lot rounding
// would render 33/33/33 = 99%. Largest-remainder must bump one of them
// to 34% so the total lands on exactly 100.
const THREE_EQUAL_LOTS_PRODUCT = {
  productId: 33,
  name: "Even-Split Fund",
  value: 30_000,
  investedAmount: 30_000,
  returnAmount: 0,
  returnPercentage: 0,
  percentage: 50,
  lots: [
    {
      investmentId: 301,
      investedAmount: 10_000,
      currentValue: 10_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-01-01T00:00:00.000Z",
    },
    {
      investmentId: 302,
      investedAmount: 10_000,
      currentValue: 10_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-02-01T00:00:00.000Z",
    },
    {
      investmentId: 303,
      investedAmount: 10_000,
      currentValue: 10_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-03-01T00:00:00.000Z",
    },
  ],
};

// Uneven split chosen so the exact shares (16.66% / 33.33% / 50.00%)
// have non-trivial fractional parts and exercise the
// largest-remainder ordering — naive Math.round would give
// 17/33/50 = 100 (lucky), so we pick a fixture whose floors leave a
// remainder > 0 that has to be redistributed.
const UNEVEN_LOTS_PRODUCT = {
  productId: 44,
  name: "Uneven-Split Fund",
  value: 60_000,
  investedAmount: 60_000,
  returnAmount: 0,
  returnPercentage: 0,
  percentage: 50,
  lots: [
    {
      investmentId: 401,
      investedAmount: 10_000,
      currentValue: 10_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-01-01T00:00:00.000Z",
    },
    {
      investmentId: 402,
      investedAmount: 20_000,
      currentValue: 20_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-02-01T00:00:00.000Z",
    },
    {
      investmentId: 403,
      investedAmount: 30_000,
      currentValue: 30_000,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-03-01T00:00:00.000Z",
    },
  ],
};

// All-zero invested case — shares are undefined (0/0). The render must
// suppress the share label entirely so we never display "NaN%" or a
// misleading "0% of position" when there's literally no basis.
const ZERO_INVESTED_PRODUCT = {
  productId: 55,
  name: "Zero-Basis Fund",
  value: 0,
  investedAmount: 0,
  returnAmount: 0,
  returnPercentage: 0,
  percentage: 0,
  lots: [
    {
      investmentId: 501,
      investedAmount: 0,
      currentValue: 0,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-01-01T00:00:00.000Z",
    },
    {
      investmentId: 502,
      investedAmount: 0,
      currentValue: 0,
      returnAmount: 0,
      returnPercentage: 0,
      investmentDate: "2026-02-01T00:00:00.000Z",
    },
  ],
};

const SHARE_BREAKDOWN_FIXTURE = {
  totalInvested: 90_000,
  totalCurrentValue: 90_000,
  totalReturn: 0,
  totalReturnPercent: 0,
  categories: [
    {
      name: "Equal Splits",
      value: 30_000,
      percentage: 33.3,
      products: [THREE_EQUAL_LOTS_PRODUCT],
    },
    {
      name: "Uneven Splits",
      value: 60_000,
      percentage: 66.7,
      products: [UNEVEN_LOTS_PRODUCT],
    },
    {
      name: "Zero Basis",
      value: 0,
      percentage: 0,
      products: [ZERO_INVESTED_PRODUCT],
    },
  ],
};

describe("Portfolio — lot share-of-position percentages", () => {
  beforeEach(() => {
    if (!(globalThis as any).ResizeObserver) {
      (globalThis as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    // Re-point the module-scoped useQuery mock at this describe-block's
    // fixture by replacing the global the mock factory closes over. We
    // can't redefine the mock per-describe, so we swap the breakdown the
    // existing mock returns by overriding the module via vi.doMock.
    vi.doMock("@tanstack/react-query", async () => {
      const actual = await vi.importActual<
        typeof import("@tanstack/react-query")
      >("@tanstack/react-query");
      return {
        ...actual,
        useQuery: ({ queryKey }: { queryKey: unknown }) => {
          const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
          if (key === "/api/investment-breakdown") {
            return { data: SHARE_BREAKDOWN_FIXTURE, isLoading: false };
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
    // Drop the cached portfolio module so the re-mocked useQuery is the
    // one it picks up on the next dynamic import.
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.doUnmock("@tanstack/react-query");
  });

  async function renderPortfolio() {
    const { default: Portfolio } = await import("./portfolio");
    return render(
      <TooltipProvider>
        <Portfolio />
      </TooltipProvider>,
    );
  }

  // Helper: read every `lot-share-${productKey}-${idx}` label rendered
  // for the given product and return the integer percent values. Throws
  // if the test ids aren't sequential starting at 0 — that's a useful
  // signal that the render skipped a row unexpectedly.
  function readLotShares(productKey: string, expectedCount: number): number[] {
    const shares: number[] = [];
    for (let i = 0; i < expectedCount; i++) {
      const el = screen.getByTestId(`lot-share-${productKey}-${i}`);
      const match = (el.textContent ?? "").match(/(-?\d+)%/);
      expect(match, `lot ${i} should render an integer percent`).not.toBeNull();
      shares.push(Number(match![1]));
    }
    return shares;
  }

  it("renders a share label on every lot and the labels sum to 100% (equal split)", async () => {
    await renderPortfolio();

    const productKey = `Equal Splits-${THREE_EQUAL_LOTS_PRODUCT.productId}`;
    fireEvent.click(screen.getByTestId(`toggle-lots-${productKey}`));

    const shares = readLotShares(productKey, THREE_EQUAL_LOTS_PRODUCT.lots.length);

    // Each label must follow the documented "X% of position" format —
    // a regression that reverts to e.g. "X%" alone would silently break
    // the UX even if the math still summed to 100.
    for (let i = 0; i < THREE_EQUAL_LOTS_PRODUCT.lots.length; i++) {
      expect(
        screen.getByTestId(`lot-share-${productKey}-${i}`).textContent,
      ).toMatch(/^\d+% of position$/);
    }

    const total = shares.reduce((a, b) => a + b, 0);
    expect(total).toBe(100);

    // Spot-check the largest-remainder result: three equal lots must
    // render as 34/33/33 (one bumped from 33 to 34), not 33/33/33 = 99.
    const sorted = [...shares].sort((a, b) => b - a);
    expect(sorted).toEqual([34, 33, 33]);
  });

  it("renders shares that sum to exactly 100% for an uneven split", async () => {
    await renderPortfolio();

    const productKey = `Uneven Splits-${UNEVEN_LOTS_PRODUCT.productId}`;
    fireEvent.click(screen.getByTestId(`toggle-lots-${productKey}`));

    const shares = readLotShares(productKey, UNEVEN_LOTS_PRODUCT.lots.length);

    const total = shares.reduce((a, b) => a + b, 0);
    expect(total).toBe(100);

    // Each share must be a non-negative integer percent (the rounding
    // step floors then redistributes — never produces a negative or a
    // fractional value).
    for (const s of shares) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }

    // The 10k / 20k / 30k split (out of 60k) should produce shares
    // proportional to the invested amounts — the largest lot must get
    // the largest share. The page renders lots in invest-date DESC
    // order (Task #354), so for this fixture the display order is
    // 30k → 20k → 10k and the rendered shares must be monotonically
    // non-increasing. This catches a regression where the share is
    // computed against the wrong denominator (e.g. parent
    // investedAmount, or product.value) which would scramble the order.
    expect(shares[0]).toBeGreaterThanOrEqual(shares[1]);
    expect(shares[1]).toBeGreaterThanOrEqual(shares[2]);

    // Pin the exact rounded shares for the 50% / 33.33% / 16.67% split.
    expect(shares).toEqual([50, 33, 17]);
  });

  it("omits the share label when the lot invested sum is 0 (no NaN%)", async () => {
    await renderPortfolio();

    const productKey = `Zero Basis-${ZERO_INVESTED_PRODUCT.productId}`;
    fireEvent.click(screen.getByTestId(`toggle-lots-${productKey}`));

    // Every lot row must still render (the drawer is open) — but the
    // share span must be omitted entirely. queryByTestId returns null
    // when the element is absent.
    for (let i = 0; i < ZERO_INVESTED_PRODUCT.lots.length; i++) {
      expect(screen.getByTestId(`lot-row-${productKey}-${i}`)).toBeInTheDocument();
      expect(
        screen.queryByTestId(`lot-share-${productKey}-${i}`),
      ).toBeNull();
    }

    // Belt-and-braces: the rendered drawer text must not contain "NaN"
    // or the misleading "0% of position" string.
    const drawer = screen.getByTestId(`lots-list-${productKey}`);
    const text = drawer.textContent ?? "";
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/% of position/);
  });
});
