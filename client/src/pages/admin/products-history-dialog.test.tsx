// =============================================================================
// Task #385 — ProductHistoryDialog URL/render contract
// -----------------------------------------------------------------------------
// The dialog uses TanStack Query's default fetcher, which (see
// `client/src/lib/queryClient.ts`) reads `queryKey[0]` as the URL. A
// previous wiring used `["/api/admin/products", id, "history"]`, which
// silently fetched the catalogue list and crashed on `data.items.length`.
// This test pins the correct URL and the rendered timeline so a
// regression of either lights up immediately.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProductHistoryDialog, type InvestmentProduct } from "./products";
import { getQueryFn } from "@/lib/queryClient";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildProduct(overrides: Partial<InvestmentProduct> = {}): InvestmentProduct {
  return {
    id: 42,
    name: "Test Real Estate Fund",
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Strategy",
    targetNetIrr: "10%",
    grossIrr: null,
    moic: null,
    term: "2 years",
    structure: "Test",
    distributions: "Quarterly",
    liquidity: "Fixed",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    lvr: null,
    annualReturn: "0.10",
    returnMethod: "fixed_annual_compound",
    isActive: false,
    isPublished: false,
    createdAt: null,
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  // Mirror the production default fetcher so the dialog's query (which
  // doesn't define its own queryFn — by design, per the project's
  // fullstack-js conventions) actually fires a request to `queryKey[0]`.
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ProductHistoryDialog (Task #385)", () => {
  it("fetches /api/admin/products/:id/history and renders the entries", async () => {
    const product = buildProduct({ id: 42, name: "Test Real Estate Fund" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 1001,
              userId: 7,
              action: "admin_product_updated",
              metadata: { updatedFields: ["targetNetIrr", "term"] },
              createdAt: "2026-04-27T10:00:00.000Z",
              actorUsername: "admin_alice",
              actorEmail: "alice@example.test",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderWithClient(
      <ProductHistoryDialog product={product} onOpenChange={() => {}} />,
    );

    // The first call must be to the per-product history URL — NOT the
    // catalogue list URL. This is the regression guard for the original
    // bad wiring (queryKey of ["/api/admin/products", id, "history"]).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCallUrl = fetchMock.mock.calls[0]?.[0];
    expect(firstCallUrl).toBe("/api/admin/products/42/history");

    // The dialog renders the actor and the changed fields.
    expect(await screen.findByText("admin_alice")).toBeTruthy();
    expect(screen.getByText("targetNetIrr")).toBeTruthy();
    expect(screen.getByText("term")).toBeTruthy();
  });

  it("renders the empty state when the server returns no entries", async () => {
    const product = buildProduct({ id: 99 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderWithClient(
      <ProductHistoryDialog product={product} onOpenChange={() => {}} />,
    );

    expect(
      await screen.findByTestId("text-product-history-empty"),
    ).toBeTruthy();
  });

  it("does not fetch when no product is selected", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    renderWithClient(
      <ProductHistoryDialog product={null} onOpenChange={() => {}} />,
    );

    // Give the query a tick to misbehave; with `enabled: false` it
    // shouldn't fire any requests.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
