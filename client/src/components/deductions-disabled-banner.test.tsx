// =============================================================================
// Task #471 — DeductionsDisabledBanner mount/unmount contract
// -----------------------------------------------------------------------------
// The banner is the visual signal advisers rely on to know that the
// fee_deductions kill switch is engaged. Two contracts are pinned here so a
// future refactor can't silently break either:
//
//   1. When the server reports `enabled: false` (kill switch ON) the banner
//      mounts with the canonical copy.
//   2. When the server reports `enabled: true` (kill switch OFF) the banner
//      unmounts within the cache lifetime — we simulate this by changing the
//      cached query data and re-rendering, mirroring how tanstack-query
//      propagates a fresh poll result.
//
// The banner reads `/api/system/deduction-execution-state` via tanstack-query.
// Pre-seeding the QueryClient cache lets us test the render contract without
// a real fetch.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import DeductionsDisabledBanner from "./deductions-disabled-banner";

afterEach(() => {
  cleanup();
});

const KEY = ["/api/system/deduction-execution-state"];

function renderWith(enabled: boolean) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Seed the cache so the component skips its initial fetch entirely.
  qc.setQueryData(KEY, { enabled });
  const utils = render(
    <QueryClientProvider client={qc}>
      <DeductionsDisabledBanner />
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

describe("DeductionsDisabledBanner", () => {
  it("mounts with the canonical copy when the kill switch is engaged", () => {
    renderWith(false);
    const banner = screen.getByTestId("banner-deductions-disabled");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain(
      "Deduction execution is currently disabled",
    );
    // Forward-looking copy — the brief specifies "no new deductions will settle".
    expect(banner.textContent).toContain("No new fee deductions will settle");
    // Accessibility: status role is set so screen readers announce on mount.
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
  });

  it("default-shows the banner when the cache has no value yet", () => {
    // Mirror the first-paint / network-error case: nothing in the cache.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    render(
      <QueryClientProvider client={qc}>
        <DeductionsDisabledBanner />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("banner-deductions-disabled")).toBeTruthy();
  });

  it("default-shows the banner when the network query errors", async () => {
    // The compliance-first contract: if we cannot positively confirm the
    // kill switch is OFF, we MUST show the banner. Simulate a real query
    // error by registering a queryFn that throws and letting react-query
    // surface the error state.
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: async () => {
            throw new Error("network down");
          },
        },
      },
    });
    render(
      <QueryClientProvider client={qc}>
        <DeductionsDisabledBanner />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const state = qc.getQueryState(KEY);
      expect(state?.status).toBe("error");
    });
    expect(screen.getByTestId("banner-deductions-disabled")).toBeTruthy();
  });

  it("renders no dismiss control (non-dismissable contract)", () => {
    renderWith(false);
    const banner = screen.getByTestId("banner-deductions-disabled");
    // No interactive close affordance of any kind — buttons, links, or
    // anything labelled as a dismiss/close action.
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(within(banner).queryByRole("link")).toBeNull();
    expect(within(banner).queryByLabelText(/close|dismiss/i)).toBeNull();
  });

  it("polls the kill-switch endpoint with a refetch interval", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(KEY, { enabled: false });
    render(
      <QueryClientProvider client={qc}>
        <DeductionsDisabledBanner />
      </QueryClientProvider>,
    );
    // Inspect the live observer set rather than internal options — react-query
    // exposes which queries have active subscribers, and we assert that the
    // banner registered a subscriber that polls (refetchInterval is defined
    // on the observer's options).
    await waitFor(() => {
      const cache = qc.getQueryCache().find({ queryKey: KEY });
      expect(cache).toBeTruthy();
      const observers = cache!.observers;
      expect(observers.length).toBeGreaterThan(0);
      const opts = observers[0].options as { refetchInterval?: number };
      expect(typeof opts.refetchInterval).toBe("number");
      expect(opts.refetchInterval! > 0).toBe(true);
    });
  });

  it("unmounts when the kill switch is cleared", async () => {
    const { qc } = renderWith(false);
    expect(screen.getByTestId("banner-deductions-disabled")).toBeTruthy();

    // Simulate a fresh poll returning enabled:true (kill switch off). The
    // observer notification is async (microtask) so we wait for the next
    // render cycle to observe the unmount.
    act(() => {
      qc.setQueryData(KEY, { enabled: true });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("banner-deductions-disabled")).toBeNull();
    });
  });
});
