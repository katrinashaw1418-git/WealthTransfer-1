// =============================================================================
// Task #348 — adviser product-shelf hygiene on the instructions list
// -----------------------------------------------------------------------------
// Locks in the regression on `listAdviserInstructions`: any instruction
// whose underlying product carries a non-canonical category (e.g. the
// historical `InRange825` with category `x`) must be dropped from the
// adviser instructions table, mirroring the existing
// `getAdviserClientHoldings` regression in
// `adviser-product-shelf-filter.test.ts` and the `listAdviserProducts`
// dropdown / `createAdviserInstruction` write-path filters so a real
// adviser never sees a leaked test/fixture product on any of the four
// surfaces.
//
// Uses the same per-call db.select() result queue the holdings test uses
// — `listAdviserInstructions` issues exactly one db.select() and then
// runs the synchronous category filter in memory, so a single staged
// result set drives the whole assertion. Client emails on the staged
// rows are deliberately non-fixture so `filterFixtureClientRows` returns
// the input unchanged without hitting the db a second time.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => {
  // Per-call result queue, identical pattern to the existing
  // adviser-product-shelf-filter test.
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
import { listAdviserInstructions } from "./adviser-access";

const stage = (db as any).__stage as (rows: any[]) => void;

const ADVISER = 10;
const CLIENT = 200;

const instruction = (
  id: number,
  productId: number,
  category: string,
  productName: string,
) => ({
  id,
  adviserUserId: ADVISER,
  clientUserId: CLIENT,
  productId,
  action: "buy",
  amount: "1000.00",
  status: "pending_consent",
  adviceRecordId: null,
  feeConsentId: null,
  executionAuthorisationId: null,
  adviceRecordNotLinked: false,
  suitabilityBasis: null,
  switchFromProductId: null,
  expiresAt: new Date("2026-02-01"),
  notes: null,
  rejectionReason: null,
  consentedAt: null,
  rejectedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  // Non-fixture client email so filterFixtureClientRows returns the
  // input unchanged without issuing a second db.select() (which would
  // not be staged and would resolve to []).
  clientFirstName: "Real",
  clientLastName: "Client",
  clientEmail: "real-client@test.invalid",
  productName,
  productCategory: category,
});

describe("listAdviserInstructions — Task #348 product-shelf hygiene", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("drops instructions whose product category is not on the canonical shelf", async () => {
    // Single select: the joined instructions query — three rows, only two
    // on the canonical shelf.
    stage([
      instruction(1, 11, "venture_capital", "Real Product A"),
      instruction(2, 12, "x", "InRange825 (legacy fixture)"),
      instruction(3, 13, "real_estate", "Real Product B"),
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await listAdviserInstructions(ADVISER);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    expect(rows.map((r) => r.id)).toEqual([1, 3]);
    // The dropped row is logged once with its product id and category so
    // future contamination remains investigable without log spam.
    expect(
      warnings.some(
        (w) =>
          w.includes("excluded instruction with unknown product category") &&
          w.includes("instructionId=2") &&
          w.includes("productId=12") &&
          w.includes('category="x"'),
      ),
    ).toBe(true);
  });

  it("returns every instruction unchanged when all categories are on the canonical shelf", async () => {
    stage([
      instruction(1, 11, "venture_capital", "VC Product"),
      instruction(2, 12, "real_estate", "RE Product"),
      instruction(3, 13, "cash_deposit", "Cash Product"),
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await listAdviserInstructions(ADVISER);
    warnSpy.mockRestore();

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
