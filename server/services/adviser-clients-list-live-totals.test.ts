// =============================================================================
// listAdviserClients — live totals, with safe fallback for unpriced & errors
// -----------------------------------------------------------------------------
// Locks in the fix for Task #278: the adviser Business page, the dashboard
// "Client book" card, and the "Top portfolios" lists must reflect each
// client's LIVE wallets+investments total, not the stale `portfolios.totalValue`
// snapshot column. Per Task Step 2, a client whose live valuation throws OR
// returns hasUnpricedWallets must fall back to "0" rather than block the
// whole list or surface a partial total.
// =============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./portfolio-valuation", () => ({
  calculatePortfolioTotalsAtDate: vi.fn(),
}));

vi.mock("../db", () => {
  // Per-call result queue. Each top-level db.select() pops the next staged
  // result; the chainable proxy ignores method names and just resolves to
  // that result when awaited (or via .then). This handles innerJoin/where/
  // groupBy/limit chains without us hard-coding their order.
  const dbResults: any[] = [];
  const makeChain = (rows: any) => {
    const p: any = new Proxy(
      { then: (res: any) => Promise.resolve(rows).then(res) },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          // Any other method (from/innerJoin/where/groupBy/limit/...) returns
          // the same chain so callers can keep chaining or await at any point.
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
import { listAdviserClients } from "./adviser-access";
import { calculatePortfolioTotalsAtDate } from "./portfolio-valuation";

const stage = (db as any).__stage as (rows: any[]) => void;
const valuation = calculatePortfolioTotalsAtDate as unknown as ReturnType<
  typeof vi.fn
>;

const ADVISER = 10;

// NOTE: client emails deliberately use `@clients.test`, not `@example.com`,
// because Task #286 added a defence-in-depth filter that drops fixture-
// pattern emails (including any `@example.com` address) from adviser surfaces
// when the rendering adviser is real. Using `@example.com` here would cause
// every linked client to be filtered out before the live-totals math runs.
const linkRow = (userId: number, extras: Partial<any> = {}) => ({
  userId,
  email: `c${userId}@clients.test`,
  firstName: `First${userId}`,
  lastName: `Last${userId}`,
  kycStatus: "verified",
  userTier: "standard",
  linkedAt: new Date("2025-01-01"),
  relationshipType: "primary",
  ...extras,
});

const ok = (totalValue: number, parts: Partial<any> = {}) => ({
  fiatValue: parts.fiatValue ?? totalValue,
  cryptoValue: parts.cryptoValue ?? 0,
  stablecoinValue: parts.stablecoinValue ?? 0,
  investmentValue: parts.investmentValue ?? 0,
  totalValue,
  hasUnpricedWallets: false,
  unpricedCurrencies: [],
});

describe("listAdviserClients — live portfolio totals", () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Drain any leftover staged db results so tests don't bleed into each other.
    while ((db as any).__stage && (db as any).select.mock) {
      // no-op; the proxy queue is reset per-test by re-staging below.
      break;
    }
  });

  it("returns live per-client totals (ignoring the stale snapshot column)", async () => {
    stage([linkRow(20), linkRow(21)]); // adviser_clients ⨝ users
    stage([{ clientId: 20, count: 2 }]); // active fee consents grouped by client

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(1_000_000);
      if (clientId === 21) return ok(250_000.5);
      throw new Error(`unexpected clientId ${clientId}`);
    });

    const rows = await listAdviserClients(ADVISER);

    expect(valuation).toHaveBeenCalledTimes(2);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("1000000.00");
    expect(byUser.get(20)!.activeFeeConsents).toBe(2);
    expect(byUser.get(21)!.portfolioValueAud).toBe("250000.50");
    expect(byUser.get(21)!.activeFeeConsents).toBe(0);
  });

  it("falls back to '0' for a client whose valuation throws, without breaking the rest", async () => {
    stage([linkRow(20), linkRow(21)]);
    stage([]); // no fee consent rows

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(750_000);
      throw new Error("boom — pricing service down");
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = await listAdviserClients(ADVISER);
    errSpy.mockRestore();

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("750000.00");
    // Failed client degrades to "0" rather than poisoning the whole list.
    expect(byUser.get(21)!.portfolioValueAud).toBe("0");
  });

  it("falls back to '0' when the live valuation reports unpriced wallets", async () => {
    stage([linkRow(20), linkRow(21)]);
    stage([]);

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(500_000);
      // Client 21 has wallets the valuation engine couldn't price — must NOT
      // surface a partial number to the adviser (Task Step 2).
      return {
        fiatValue: 100,
        cryptoValue: 0,
        stablecoinValue: 0,
        investmentValue: 0,
        totalValue: 100,
        hasUnpricedWallets: true,
        unpricedCurrencies: ["XYZ"],
      };
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = await listAdviserClients(ADVISER);
    errSpy.mockRestore();

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("500000.00");
    expect(byUser.get(21)!.portfolioValueAud).toBe("0");
  });

  it("returns an empty list (and never values anything) when adviser has no linked clients", async () => {
    stage([]); // no linkRows

    const rows = await listAdviserClients(ADVISER);

    expect(rows).toEqual([]);
    expect(valuation).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Task #286 — fixture clients must never surface to a real adviser.
  // ---------------------------------------------------------------------------
  it("drops fixture-pattern client emails from a real adviser's list and warns", async () => {
    // Three "linked" clients — one real, two fixture-pattern emails. The
    // fixture filter MUST drop the two fixtures before valuation runs and
    // before the fee-consent join, so we only stage the consents query
    // for the surviving real client (id 30).
    stage([
      linkRow(30), // real → c30@clients.test
      linkRow(31, { email: "adviser-race-1761642930@example.com" }),
      linkRow(32, { email: "__prelaunch_fixture_99@gmail.com" }),
    ]);
    // The filter, on detecting fixture rows, peeks the rendering adviser's
    // email to confirm it isn't itself a fixture before dropping. Stage a
    // real adviser email next.
    stage([{ email: "real.adviser@advisers.test" }]);
    stage([{ clientId: 30, count: 1 }]); // fee consents grouped by client

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 30) return ok(500_000);
      throw new Error(`fixture client ${clientId} should have been filtered`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await listAdviserClients(ADVISER);

    // Only the real client survives, and pricing was only called for it.
    expect(rows.map((r) => r.userId)).toEqual([30]);
    expect(rows[0].portfolioValueAud).toBe("500000.00");
    expect(valuation).toHaveBeenCalledTimes(1);

    // One structured warning per dropped fixture row, with the matched
    // pattern hint — gives ops a single grep target ("filtered fixture
    // client") for production triage.
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();
    expect(warnings.filter((w) => w.includes("filtered fixture client"))).toHaveLength(2);
    expect(warnings.some((w) => w.includes("clientUserId=31"))).toBe(true);
    expect(warnings.some((w) => w.includes("clientUserId=32"))).toBe(true);
  });

  it("preserves fixture-on-fixture links when the rendering adviser is itself a fixture", async () => {
    // Both clients are fixture-pattern; the adviser is ALSO a fixture (a
    // legitimate test-script scenario, e.g. the planner gate). The filter
    // must short-circuit and return everything — otherwise CI gates that
    // build their own adviser/client universes would silently lose data.
    stage([
      linkRow(40, { email: "okadv-1@example.com" }),
      linkRow(41, { email: "__feegate_b_client@example.com" }),
    ]);
    // Adviser email lookup → also a fixture pattern.
    stage([{ email: "__feegate_b_adviser@example.com" }]);
    stage([]); // no fee consents

    valuation.mockImplementation(async (clientId: number) => ok(1_000));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await listAdviserClients(ADVISER);
    warnSpy.mockRestore();

    expect(rows.map((r) => r.userId).sort()).toEqual([40, 41]);
    // Filter is a no-op for fixture-on-fixture: no warnings.
    expect(
      warnSpy.mock.calls.filter((c) => String(c[0]).includes("filtered fixture client")),
    ).toHaveLength(0);
  });
});
