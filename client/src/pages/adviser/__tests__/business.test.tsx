// =============================================================================
// Task #303 — Adviser Business page snapshot polish
// -----------------------------------------------------------------------------
// Task #287 layered several pieces of UX polish onto the adviser Business page
// that have no dedicated frontend coverage. They are all easy to silently
// break in a future refactor:
//   - The snapshot timestamp under the page title comes from the same
//     `/api/adviser/clients` response that drove the AUM totals, so the two
//     can never drift; it must keep rendering for empty books.
//   - The Top Clients table renders KYC and Fee-consent columns with three
//     states (Active · exp <Mon YYYY>, Expired <Mon YYYY>, None) and uses
//     soonest-expiry as the tiebreaker for equal portfolios.
//   - The "Avg per client" caption shows "—" when nobody has a portfolio and
//     excludes zero-portfolio clients otherwise.
//   - The tier-mix bar swaps to client-count percentage when total AUM is
//     zero (e.g. "5 of 6 clients · 83% of book by client count").
//   - The Active fee consents card lists up to three clients + a "+N more"
//     pill when more exist.
//
// The matching server-side fields already have unit coverage in
// `server/services/adviser-clients-list-live-totals.test.ts` — this is the
// frontend half of that contract.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import AdviserBusiness from "../business";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
// Mirrors the AdviserClientRow shape inside business.tsx. We keep this local
// (rather than re-exporting from the page) so the page module stays a pure
// view component — adding test-only exports would be more coupling, not
// less. The shape is small enough that the duplication is worth it.
interface RowOverrides {
  userId: number;
  email?: string;
  firstName?: string;
  lastName?: string;
  kycStatus?: string;
  userTier?: string;
  linkedAt?: string | null;
  relationshipType?: string;
  activeFeeConsents?: number;
  portfolioValueAud?: string;
  feeConsentExpiringAt?: string | null;
  mostRecentExpiredConsentDate?: string | null;
}

function row(overrides: RowOverrides) {
  return {
    email: `c${overrides.userId}@clients.test`,
    firstName: `First${overrides.userId}`,
    lastName: `Last${overrides.userId}`,
    kycStatus: "verified",
    userTier: "standard",
    linkedAt: "2025-01-01T00:00:00.000Z",
    relationshipType: "primary",
    activeFeeConsents: 0,
    portfolioValueAud: "0",
    feeConsentExpiringAt: null,
    mostRecentExpiredConsentDate: null,
    ...overrides,
  };
}

// `asOfDate` is a fixed instant well inside Sydney's AEST window
// (2026-04-27T04:32 UTC = 2026-04-27 14:32 AEST) so the formatted
// snapshot string is deterministic regardless of the host machine TZ.
const AS_OF = "2026-04-27T04:32:00.000Z";

function renderBusiness(opts: {
  clients: ReturnType<typeof row>[];
  asOfDate?: string;
  dashboard?: {
    linkedClients?: number;
    openTasks?: number;
    feeConsentsExpiringSoon?: number;
    pendingReports?: number;
  };
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  // Pre-seed the query cache so the page renders synchronously without
  // hitting fetch — we are testing the render contract, not the network
  // layer. The asOfDate stays a sibling of `clients` (matching the wrapper
  // shape) so we can verify the empty-book case still surfaces a timestamp.
  client.setQueryData(["/api/adviser/clients"], {
    asOfDate: opts.asOfDate ?? AS_OF,
    clients: opts.clients,
  });
  client.setQueryData(["/api/adviser/dashboard"], {
    linkedClients: opts.dashboard?.linkedClients ?? opts.clients.length,
    openTasks: opts.dashboard?.openTasks ?? 0,
    feeConsentsExpiringSoon: opts.dashboard?.feeConsentsExpiringSoon ?? 0,
    pendingReports: opts.dashboard?.pendingReports ?? 0,
  });

  return render(
    <QueryClientProvider client={client}>
      <AdviserBusiness />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Snapshot timestamp — empty book and populated book
// ---------------------------------------------------------------------------
describe("AdviserBusiness — snapshot timestamp", () => {
  it("renders the server-derived snapshot timestamp even for an empty book", () => {
    // The wrapper carries asOfDate even when `clients` is `[]`, so the
    // timestamp must render. This is the regression guard for the bug
    // where an empty book caused the page to fall back to the client clock
    // (or omit the timestamp entirely).
    renderBusiness({ clients: [] });

    const ts = screen.getByTestId("text-snapshot-timestamp");
    // 2026-04-27 04:32 UTC → 2026-04-27 14:32 in Australia/Sydney (AEST).
    expect(ts.textContent).toBe("Snapshot as at 27 Apr 2026 · 14:32 AEST");
  });

  it("renders the snapshot timestamp from asOfDate, not the wall clock", () => {
    // Use a clearly different asOfDate so a regression that swapped to
    // `new Date()` would produce a different (today's) date string.
    renderBusiness({
      asOfDate: "2025-12-01T03:15:00.000Z",
      clients: [row({ userId: 1, portfolioValueAud: "10000" })],
    });
    const ts = screen.getByTestId("text-snapshot-timestamp");
    // 2025-12-01 03:15 UTC → 2025-12-01 14:15 in Sydney. The page passes
    // `day: "2-digit"` to Intl, so the day is zero-padded ("01"). The
    // timezone label stays "AEST" verbatim — the formatter is configured
    // in en-AU but the page hard-codes the suffix.
    expect(ts.textContent).toContain("Snapshot as at 01 Dec 2025");
    expect(ts.textContent).toContain("14:15 AEST");
  });
});

// ---------------------------------------------------------------------------
// Avg per client caption
// ---------------------------------------------------------------------------
describe("AdviserBusiness — Avg per client caption", () => {
  it("renders an em-dash when nobody has a portfolio", () => {
    // All three clients sit at zero. Computing 0/3 = $0 would be misleading
    // next to a populated client list — we want the dash instead.
    renderBusiness({
      clients: [
        row({ userId: 1, portfolioValueAud: "0" }),
        row({ userId: 2, portfolioValueAud: "0" }),
        row({ userId: 3, portfolioValueAud: "0" }),
      ],
    });
    const caption = screen.getByTestId("text-avg-per-client");
    expect(caption.textContent).toBe("Avg per client —");
  });

  it("excludes zero-portfolio clients from the average", () => {
    // Two clients hold $100k each, two hold $0. The honest average is
    // $100k (average over the funded set), not $50k (average over all
    // four). The caption should reflect the funded-only average.
    renderBusiness({
      clients: [
        row({ userId: 1, portfolioValueAud: "100000" }),
        row({ userId: 2, portfolioValueAud: "100000" }),
        row({ userId: 3, portfolioValueAud: "0" }),
        row({ userId: 4, portfolioValueAud: "0" }),
      ],
    });
    const caption = screen.getByTestId("text-avg-per-client");
    // Intl currency formatting may use a non-breaking space between symbol
    // and number on some locales; check for both the prefix and the value.
    expect(caption.textContent).toMatch(/Avg per client/);
    expect(caption.textContent).toMatch(/\$100,000/);
  });
});

// ---------------------------------------------------------------------------
// Tier mix — client-count fallback when total AUM is zero
// ---------------------------------------------------------------------------
describe("AdviserBusiness — tier mix bar", () => {
  it("falls back to client-count percentage when total AUM is zero", () => {
    // 5 standard + 1 platinum, all at $0 portfolio. Without the fallback,
    // every tier would render "0.0% of book", which reads as a math error.
    // The fallback should render "5 of 6 clients · 83% of book by client
    // count" for the standard bucket.
    const standards = Array.from({ length: 5 }, (_, i) =>
      row({ userId: 100 + i, userTier: "standard", portfolioValueAud: "0" }),
    );
    const platinum = row({
      userId: 200,
      userTier: "platinum",
      portfolioValueAud: "0",
    });
    renderBusiness({ clients: [...standards, platinum] });

    const standardLabel = screen.getByTestId("tier-standard-pct-label");
    expect(standardLabel.textContent).toBe(
      "5 of 6 clients · 83% of book by client count",
    );
    const platinumLabel = screen.getByTestId("tier-platinum-pct-label");
    expect(platinumLabel.textContent).toBe(
      "1 of 6 clients · 17% of book by client count",
    );
  });

  it("renders AUM-share percentages when the book has positive AUM", () => {
    // 75k + 25k = 100k total. The standard bucket should show 75.0% of book
    // (and NOT the client-count fallback string).
    renderBusiness({
      clients: [
        row({ userId: 1, userTier: "standard", portfolioValueAud: "75000" }),
        row({ userId: 2, userTier: "platinum", portfolioValueAud: "25000" }),
      ],
    });
    const standardLabel = screen.getByTestId("tier-standard-pct-label");
    expect(standardLabel.textContent).toBe("75.0% of book");
    expect(standardLabel.textContent).not.toContain("by client count");
  });
});

// ---------------------------------------------------------------------------
// Top Clients table — KYC + Fee-consent columns and tiebreaker
// ---------------------------------------------------------------------------
describe("AdviserBusiness — Top Clients KYC + fee consent columns", () => {
  it("renders the three fee-consent states and orders by soonest expiry as a tiebreaker", () => {
    // Three clients all sit at $50k portfolio so the secondary sort key
    // (soonest fee-consent expiry) decides their order in the Top Clients
    // table:
    //   - C1 active, expires May 2026  → should appear first
    //   - C2 active, expires Aug 2026  → second
    //   - C3 expired, last expiry Jan 2026 → third (Expired/None push to bottom)
    //   - C4 has none → last
    // We also check the KYC column reflects each row's status with the
    // expected badge text.
    renderBusiness({
      clients: [
        row({
          userId: 1,
          firstName: "Alice",
          lastName: "Active",
          kycStatus: "verified",
          portfolioValueAud: "50000",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-05-15T00:00:00.000Z",
        }),
        row({
          userId: 2,
          firstName: "Bob",
          lastName: "Active",
          kycStatus: "pending",
          portfolioValueAud: "50000",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-08-20T00:00:00.000Z",
        }),
        row({
          userId: 3,
          firstName: "Carol",
          lastName: "Expired",
          kycStatus: "rejected",
          portfolioValueAud: "50000",
          activeFeeConsents: 0,
          mostRecentExpiredConsentDate: "2026-01-10T00:00:00.000Z",
        }),
        row({
          userId: 4,
          firstName: "Dan",
          lastName: "None",
          kycStatus: "verified",
          portfolioValueAud: "50000",
          activeFeeConsents: 0,
        }),
      ],
    });

    // Fee consent column — exact label per kind.
    expect(
      screen.getByTestId("cell-top-client-fee-1").textContent,
    ).toBe("Active · exp May 2026");
    expect(
      screen.getByTestId("cell-top-client-fee-2").textContent,
    ).toBe("Active · exp Aug 2026");
    expect(
      screen.getByTestId("cell-top-client-fee-3").textContent,
    ).toBe("Expired Jan 2026");
    expect(screen.getByTestId("cell-top-client-fee-4").textContent).toBe(
      "None",
    );

    // KYC column — verifies each row renders the right status badge.
    expect(
      within(screen.getByTestId("cell-top-client-kyc-1")).getByTestId(
        "badge-kyc-verified",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("cell-top-client-kyc-2")).getByTestId(
        "badge-kyc-pending",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("cell-top-client-kyc-3")).getByTestId(
        "badge-kyc-rejected",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("cell-top-client-kyc-4")).getByTestId(
        "badge-kyc-verified",
      ),
    ).toBeTruthy();

    // Tiebreaker order — same portfolio, so soonest-expiry decides.
    // Row order in the DOM should be 1 (May), 2 (Aug), then 3/4 (both
    // pushed to the bottom by POSITIVE_INFINITY sort key — their relative
    // order is stable from the input array, so 3 before 4).
    const rows = screen
      .getAllByTestId(/^row-top-client-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual([
      "row-top-client-1",
      "row-top-client-2",
      "row-top-client-3",
      "row-top-client-4",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Active fee consents card — top three + "+N more" pill
// ---------------------------------------------------------------------------
describe("AdviserBusiness — Active fee consents card", () => {
  it("lists up to three soonest-expiring clients plus a +N more pill", () => {
    // Five clients with active consents, expiring in ascending months.
    // The card should show clients 1/2/3 (May/Jun/Jul) and a "+2 more"
    // pill — never the later expiries directly.
    renderBusiness({
      clients: [
        row({
          userId: 1,
          firstName: "May",
          lastName: "Client",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-05-01T00:00:00.000Z",
        }),
        row({
          userId: 2,
          firstName: "June",
          lastName: "Client",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-06-01T00:00:00.000Z",
        }),
        row({
          userId: 3,
          firstName: "July",
          lastName: "Client",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-07-01T00:00:00.000Z",
        }),
        row({
          userId: 4,
          firstName: "August",
          lastName: "Client",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-08-01T00:00:00.000Z",
        }),
        row({
          userId: 5,
          firstName: "Sept",
          lastName: "Client",
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
    });

    const list = screen.getByTestId("list-active-fee-clients");
    // Exactly the first three by expiry render as their own rows.
    expect(within(list).getByTestId("row-active-fee-client-1")).toBeTruthy();
    expect(within(list).getByTestId("row-active-fee-client-2")).toBeTruthy();
    expect(within(list).getByTestId("row-active-fee-client-3")).toBeTruthy();
    expect(
      within(list).queryByTestId("row-active-fee-client-4"),
    ).toBeNull();
    expect(
      within(list).queryByTestId("row-active-fee-client-5"),
    ).toBeNull();

    // The pill counts the overflow (5 - 3 = 2) and links to the consents page.
    const more = screen.getByTestId("link-active-fee-clients-more");
    expect(more.textContent).toBe("+2 more");
  });

  it("omits the +N more pill when three or fewer clients have active consents", () => {
    // Two active + one expired (which doesn't count toward the card).
    // The pill should not render at all.
    renderBusiness({
      clients: [
        row({
          userId: 1,
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-05-01T00:00:00.000Z",
        }),
        row({
          userId: 2,
          activeFeeConsents: 1,
          feeConsentExpiringAt: "2026-06-01T00:00:00.000Z",
        }),
        row({
          userId: 3,
          activeFeeConsents: 0,
          mostRecentExpiredConsentDate: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    const list = screen.getByTestId("list-active-fee-clients");
    expect(within(list).getByTestId("row-active-fee-client-1")).toBeTruthy();
    expect(within(list).getByTestId("row-active-fee-client-2")).toBeTruthy();
    expect(screen.queryByTestId("link-active-fee-clients-more")).toBeNull();
  });
});
