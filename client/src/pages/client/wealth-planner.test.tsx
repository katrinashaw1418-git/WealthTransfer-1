// =============================================================================
// Task #390 — wealth planner progress + required-CAGR readouts
// -----------------------------------------------------------------------------
// Task #338 added per-objective progress bars and a required-CAGR figure to
// the client wealth planner. The math has several guards (target met, no
// current value, no/past target date, sub-5-week horizon → simple return)
// that are easy to silently regress, so this suite locks both the helper
// and the table render in place.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryObserverSuccessResult,
} from "@tanstack/react-query";

// usePortfolioAllocation drives the live portfolio total that feeds both the
// progress bar denominator and the required-CAGR `current` argument. We mock
// the hook so each test can pin the total to a deterministic value.
vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolioAllocation: vi.fn(),
}));

import ClientWealthPlanner, { computeRequiredCagr } from "./wealth-planner";
import { usePortfolioAllocation } from "@/hooks/use-portfolio";

const mockedUsePortfolioAllocation = vi.mocked(usePortfolioAllocation);

// Build a fully-typed `useQuery` success result so the hook stub is
// structurally compatible with the real return type — no `as any` escape
// hatch needed. Spelling the fields out is verbose but keeps the test
// honest: if react-query changes its result shape, this breaks loudly
// instead of silently lying to the component under test.
type AllocationData = { totalValue: number };
function buildAllocationSuccess(
  totalValue: number,
): QueryObserverSuccessResult<AllocationData, Error> {
  const data: AllocationData = { totalValue };
  const result: QueryObserverSuccessResult<AllocationData, Error> = {
    data,
    dataUpdatedAt: 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: "idle",
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    promise: Promise.resolve(data),
    refetch: () => Promise.resolve(result),
    status: "success",
  };
  return result;
}

const NOW = new Date("2026-04-28T00:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  cleanup();
});

// ---------------------------------------------------------------------------
// computeRequiredCagr
// ---------------------------------------------------------------------------
describe("computeRequiredCagr", () => {
  const inOneYear = new Date(NOW + 365.25 * 24 * 60 * 60 * 1000).toISOString();

  it("reports the goal as met when the portfolio already covers the target", () => {
    // Even with a far-future target date, current >= target short-circuits to
    // the "Met" badge so we don't show a misleading required return.
    expect(computeRequiredCagr(150_000, 100_000, inOneYear)).toEqual({
      value: 0,
      mode: "cagr",
    });
    expect(computeRequiredCagr(100_000, 100_000, inOneYear)).toEqual({
      value: 0,
      mode: "cagr",
    });
  });

  it("returns null when the portfolio has no value yet", () => {
    // A zero or negative starting balance would cause Math.pow(target/0, …) to
    // explode. The helper bails out instead of rendering Infinity.
    expect(computeRequiredCagr(0, 100_000, inOneYear)).toBeNull();
    expect(computeRequiredCagr(-50, 100_000, inOneYear)).toBeNull();
    expect(computeRequiredCagr(Number.NaN, 100_000, inOneYear)).toBeNull();
  });

  it("returns null when the objective has no target date", () => {
    // Without a horizon there is no honest annualised number to surface.
    expect(computeRequiredCagr(50_000, 100_000, null)).toBeNull();
  });

  it("returns null when the target date is already in the past", () => {
    // A past date would yield a negative `years`, which would produce a
    // negative or imaginary rate. The guard prevents that.
    const yesterday = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
    expect(computeRequiredCagr(50_000, 100_000, yesterday)).toBeNull();
  });

  it("falls back to a simple return for sub-5-week horizons", () => {
    // 21 days ≈ 0.057 years, well below the 0.1-year (~5 week) threshold.
    // Annualising over such a short horizon produces wild numbers, so the
    // helper returns the plain (target/current - 1) percentage instead.
    const in21Days = new Date(NOW + 21 * 24 * 60 * 60 * 1000).toISOString();
    const out = computeRequiredCagr(100_000, 110_000, in21Days);
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("simple");
    expect(out!.value).toBeCloseTo(10, 6);
  });

  it("computes a normal multi-year CAGR in annualised mode", () => {
    // Doubling 100k → 200k over 7 years compounds at ~10.4% p.a.
    // (2 ** (1/7) - 1) * 100 = 10.40895136...
    const in7Years = new Date(
      NOW + 7 * 365.25 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const out = computeRequiredCagr(100_000, 200_000, in7Years);
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("cagr");
    expect(out!.value).toBeCloseTo(10.4089, 3);
  });
});

// ---------------------------------------------------------------------------
// Objectives table render
// ---------------------------------------------------------------------------
describe("ClientWealthPlanner objectives table", () => {
  function renderWithObjectives(opts: {
    portfolioValue: number;
    objectives: Array<{
      id: number;
      label: string;
      targetAmount: string | null;
      targetDate: string | null;
      objectiveType?: string;
      priority?: string;
    }>;
  }) {
    mockedUsePortfolioAllocation.mockReturnValue(
      buildAllocationSuccess(opts.portfolioValue),
    );

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });
    // Pre-seed the cache so the page renders synchronously without hitting
    // fetch — we're testing the render path, not the network layer.
    client.setQueryData(["/api/client/objectives"], {
      items: opts.objectives.map((o) => ({
        id: o.id,
        adviceRecordId: 1,
        objectiveType: o.objectiveType ?? "retirement",
        label: o.label,
        targetAmount: o.targetAmount,
        targetCurrency: "AUD",
        targetDate: o.targetDate,
        priority: o.priority ?? "primary",
        notes: null,
        createdAt: null,
      })),
    });
    client.setQueryData(["/api/client/documents"], { items: [] });

    return render(
      <QueryClientProvider client={client}>
        <ClientWealthPlanner />
      </QueryClientProvider>,
    );
  }

  it("renders progress bars, percent readouts and CAGR cells for each objective", () => {
    // Two synthetic objectives against a fixed 50k portfolio total:
    //  - "House deposit"  target 100k in ~7 years → 50% progress, ~10.4% p.a.
    //  - "Emergency fund" target 25k, no date     → 100% progress, "Met"
    const in7Years = new Date(
      NOW + 7 * 365.25 * 24 * 60 * 60 * 1000,
    ).toISOString();

    renderWithObjectives({
      portfolioValue: 50_000,
      objectives: [
        {
          id: 101,
          label: "House deposit",
          targetAmount: "100000",
          targetDate: in7Years,
        },
        {
          id: 202,
          label: "Emergency fund",
          targetAmount: "25000",
          targetDate: null,
        },
      ],
    });

    // --- House deposit: in-flight goal, half covered ---
    const progressRow1 = screen.getByTestId("cell-objective-progress-101");
    const bar1 = within(progressRow1).getByTestId("progress-objective-101");
    // The shadcn Progress wrapper destructures `value` and applies it to the
    // indicator's `translateX` rather than forwarding it to Radix's root, so
    // `aria-valuenow` stays unset. The translateX percentage on the single
    // child indicator is therefore the canonical DOM signal of the value.
    const indicator1 = bar1.firstElementChild as HTMLElement;
    expect(indicator1.style.transform).toBe("translateX(-50%)");
    expect(progressRow1.textContent).toContain("50,000 / 100,000");
    expect(progressRow1.textContent).toContain("50.0%");

    const cagrCell1 = screen.getByTestId("cell-objective-required-cagr-101");
    // 100k / 50k over 7y → ~10.4% p.a., rendered with one decimal and a
    // leading "+" because the value is positive.
    expect(cagrCell1.textContent).toContain("+10.4%");
    expect(cagrCell1.textContent).toContain("p.a.");

    // --- Emergency fund: target already met, capped at 100% ---
    const progressRow2 = screen.getByTestId("cell-objective-progress-202");
    const bar2 = within(progressRow2).getByTestId("progress-objective-202");
    // Portfolio (50k) far exceeds target (25k); the helper caps the bar at
    // 100 so an over-funded goal still renders as a full bar instead of a
    // 200% glitch (which would translateX(+100%) and slide off the right).
    const indicator2 = bar2.firstElementChild as HTMLElement;
    expect(indicator2.style.transform).toBe("translateX(-0%)");
    expect(progressRow2.textContent).toContain("100.0%");

    const cagrCell2 = screen.getByTestId("cell-objective-required-cagr-202");
    // target <= current → "Met" badge (no numeric percentage shown).
    expect(cagrCell2.textContent).toContain("Met");
    expect(cagrCell2.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });
});
