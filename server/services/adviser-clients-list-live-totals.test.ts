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

  // Per Task #288 the list endpoint also returns the soonest active
  // fee-consent expiry per client and a `lastActivityAt` derived from
  // adviser_clients.linked_at + the latest investmentInstructions /
  // adviceRecords / adviserTasks / adviserNotes touch. Helper to stage
  // the four "no activity" rowsets after the two fee-consent rowsets.
  const stageNoActivity = () => {
    stage([]); // investmentInstructions max-by-client
    stage([]); // adviceRecords max-by-client
    stage([]); // adviserTasks max-by-client
    stage([]); // adviserNotes max-by-client
  };

  // Task #287 added a third fee-consents query (max(consentExpiryDate) over
  // expired consents grouped by client) used to amber-flag recently-lapsed
  // relationships on the Business snapshot. Stages it as the "no expired
  // rows" case alongside the active-count + active-expiry stages.
  const stageNoExpired = () => {
    stage([]); // expired fee consents grouped by client
  };

  it("returns live per-client totals (ignoring the stale snapshot column)", async () => {
    stage([linkRow(20), linkRow(21)]); // adviser_clients ⨝ users
    stage([{ clientId: 20, count: 2 }]); // active fee consents grouped by client
    stageNoExpired();
    stage([
      { clientId: 20, expiringAt: new Date("2026-09-01T00:00:00.000Z") },
    ]); // soonest active expiry grouped by client
    stageNoActivity();

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(1_000_000);
      if (clientId === 21) return ok(250_000.5);
      throw new Error(`unexpected clientId ${clientId}`);
    });

    const { clients: rows, asOfDate } = await listAdviserClients(ADVISER);

    expect(valuation).toHaveBeenCalledTimes(2);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("1000000.00");
    expect(byUser.get(20)!.activeFeeConsents).toBe(2);
    expect(byUser.get(20)!.feeConsentExpiringAt?.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(byUser.get(21)!.portfolioValueAud).toBe("250000.50");
    expect(byUser.get(21)!.activeFeeConsents).toBe(0);
    expect(byUser.get(21)!.feeConsentExpiringAt).toBeNull();
    // Snapshot timestamp is a server-derived Date — same instant the live
    // valuation engine was called with — so the UI can render a "Snapshot
    // as at <ts>" line that can never disagree with the figures it qualifies.
    expect(asOfDate).toBeInstanceOf(Date);
    expect(valuation).toHaveBeenCalledWith(20, asOfDate);
    expect(valuation).toHaveBeenCalledWith(21, asOfDate);
  });

  it("falls back to '0' for a client whose valuation throws, without breaking the rest", async () => {
    stage([linkRow(20), linkRow(21)]);
    stage([]); // no active fee consent rows
    stageNoExpired();
    stage([]); // no fee expiry rows
    stageNoActivity();

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(750_000);
      throw new Error("boom — pricing service down");
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { clients: rows } = await listAdviserClients(ADVISER);
    errSpy.mockRestore();

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("750000.00");
    // Failed client degrades to "0" rather than poisoning the whole list.
    expect(byUser.get(21)!.portfolioValueAud).toBe("0");
  });

  // Task #288 reverses the Task #278 hasUnpricedWallets→"0" rule on this
  // code path: the per-client detail endpoint surfaces the partial total in
  // that case, and the list MUST agree so a high-balance real client never
  // shows up as "$0" because of one stray unpriced wallet. The engine still
  // flags hasUnpricedWallets so the adviser-access logger can record the gap.
  it("surfaces the partial total when the live valuation reports unpriced wallets", async () => {
    stage([linkRow(20), linkRow(21)]);
    stage([]);
    stageNoExpired();
    stage([]); // no fee expiry rows
    stageNoActivity();

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 20) return ok(500_000);
      return {
        fiatValue: 4_800_000,
        cryptoValue: 0,
        stablecoinValue: 0,
        investmentValue: 49_850,
        totalValue: 4_849_850,
        hasUnpricedWallets: true,
        unpricedCurrencies: ["XYZ"],
      };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clients: rows } = await listAdviserClients(ADVISER);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(20)!.portfolioValueAud).toBe("500000.00");
    // Real $4.8M total survives — only the unpriced slice is excluded by
    // the engine; the rest of the book is still counted.
    expect(byUser.get(21)!.portfolioValueAud).toBe("4849850.00");
    // We still log the partial valuation so ops can chase the missing FX rate.
    expect(
      warnings.some((w) => w.includes("unpriced wallets") && w.includes("client 21")),
    ).toBe(true);
  });

  it("returns lastActivityAt = max(linkedAt, latest touches across all sources)", async () => {
    stage([
      linkRow(50, { linkedAt: new Date("2025-01-01T00:00:00.000Z") }),
      linkRow(51, { linkedAt: new Date("2025-06-01T00:00:00.000Z") }),
    ]);
    stage([]); // fee counts
    stageNoExpired();
    stage([]); // fee expiry
    // Client 50: latest is from adviceRecords (2025-08-01)
    stage([{ clientId: 50, lastAt: new Date("2025-03-15T00:00:00.000Z") }]); // instructions
    stage([{ clientId: 50, lastAt: new Date("2025-08-01T00:00:00.000Z") }]); // advice
    stage([{ clientId: 50, lastAt: new Date("2025-04-01T00:00:00.000Z") }]); // tasks
    stage([]); // notes — none for 51 either; only linkedAt for 51

    valuation.mockImplementation(async () => ok(0));

    const { clients: rows } = await listAdviserClients(ADVISER);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    // Client 50: adviceRecords' 2025-08-01 wins over linkedAt and the others.
    expect(byUser.get(50)!.lastActivityAt?.toISOString()).toBe(
      "2025-08-01T00:00:00.000Z",
    );
    // Client 51: no activity rows, falls back to linkedAt.
    expect(byUser.get(51)!.lastActivityAt?.toISOString()).toBe(
      "2025-06-01T00:00:00.000Z",
    );
  });

  it("returns an empty list (and never values anything) when adviser has no linked clients", async () => {
    stage([]); // no linkRows

    const result = await listAdviserClients(ADVISER);

    expect(result.clients).toEqual([]);
    expect(valuation).not.toHaveBeenCalled();
    // Even when the book is empty, the response MUST carry a server-derived
    // asOfDate so the UI can still render "Snapshot as at <ts>" without
    // having to fall back to the client's clock (which can drift).
    expect(result.asOfDate).toBeInstanceOf(Date);
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
    stage([{ clientId: 30, count: 1 }]); // active fee consents grouped by client
    stageNoExpired();
    stage([]); // fee expiry rows
    stageNoActivity();

    valuation.mockImplementation(async (clientId: number) => {
      if (clientId === 30) return ok(500_000);
      throw new Error(`fixture client ${clientId} should have been filtered`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clients: rows } = await listAdviserClients(ADVISER);

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
    stage([]); // no active fee consents
    stageNoExpired();
    stage([]); // no fee expiry
    stageNoActivity();

    valuation.mockImplementation(async (clientId: number) => ok(1_000));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clients: rows } = await listAdviserClients(ADVISER);
    warnSpy.mockRestore();

    expect(rows.map((r) => r.userId).sort()).toEqual([40, 41]);
    // Filter is a no-op for fixture-on-fixture: no warnings.
    expect(
      warnSpy.mock.calls.filter((c) => String(c[0]).includes("filtered fixture client")),
    ).toHaveLength(0);
  });
});
