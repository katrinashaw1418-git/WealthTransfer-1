// =============================================================================
// Task #310 — instruction-create compliance gates
// -----------------------------------------------------------------------------
// Locks in the regression on `createAdviserInstruction` (Task #292): the
// service-layer write path must reject any payload that bypasses the
// adviser-shelf, advice-record, suitability or switch-source gates, and
// when it accepts a payload it must persist `expiresAt`,
// `adviceRecordNotLinked`, `suitabilityBasis` and `switchFromProductId`
// onto the inserted row.
//
// All gates are enforced inside the service (not just the route's Zod
// schema), so this test exercises the service directly. Mirrors the
// per-call db.select() result-queue pattern used by the existing
// `adviser-instructions-shelf-filter.test.ts` and
// `adviser-product-shelf-filter.test.ts`, extended with an `insert` mock
// that captures the `.values(...)` payload so the happy-path test can
// assert what would have been written.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => {
  const dbResults: any[] = [];
  const insertedValues: any[] = [];
  const insertReturning: any[] = [];

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

  const insert = vi.fn((_table: any) => {
    let captured: Record<string, unknown> = {};
    const chain: any = {
      values(vals: Record<string, unknown>) {
        captured = vals;
        insertedValues.push(vals);
        return chain;
      },
      returning() {
        const staged = insertReturning.shift();
        // Default to echoing back the captured values with a synthetic id so
        // the caller's destructure (`const [row] = ...`) sees a real row.
        const rows = staged ?? [{ id: 9999, ...captured }];
        return Promise.resolve(rows);
      },
    };
    return chain;
  });

  return {
    db: {
      select,
      insert,
      __stage: (rows: any[]) => dbResults.push(rows),
      __stageInsertReturning: (rows: any[]) => insertReturning.push(rows),
      __getInsertedValues: () => insertedValues,
      __reset: () => {
        dbResults.length = 0;
        insertedValues.length = 0;
        insertReturning.length = 0;
      },
    },
  };
});

import { db } from "./../db";
import { createAdviserInstruction } from "./adviser-access";

const stage = (db as any).__stage as (rows: any[]) => void;
const getInserted = (db as any).__getInsertedValues as () => any[];
const reset = (db as any).__reset as () => void;

const ADVISER = 10;
const CLIENT = 200;
const PRODUCT = 500;
const SWITCH_FROM = 501;
const ADVICE_RECORD = 700;

const linkRow = () => ({
  adviserUserId: ADVISER,
  clientUserId: CLIENT,
  isActive: true,
});

// Non-fixture email so the in-memory fixture filter is a no-op and does
// not issue an extra db.select() (which would fall through to []).
const clientRow = () => ({ email: "real-client@test.invalid" });

const productRow = (overrides: Partial<{
  id: number;
  isActive: boolean;
  category: string;
  riskProfile: string;
}> = {}) => ({
  id: PRODUCT,
  isActive: true,
  category: "venture_capital",
  riskProfile: "low",
  ...overrides,
});

describe("createAdviserInstruction — Task #310 compliance gates", () => {
  beforeEach(() => {
    reset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with 400 when the product's category is not on the canonical shelf", async () => {
    stage([linkRow()]);
    stage([clientRow()]);
    // Product carries the historical fixture-style category `x` that is not
    // a key in PRODUCT_CATEGORY_LABELS, so the shelf gate must fire.
    stage([productRow({ category: "x" })]);

    await expect(
      createAdviserInstruction(ADVISER, {
        clientUserId: CLIENT,
        productId: PRODUCT,
        action: "buy",
        amount: "1000.00",
        adviceRecordNotLinked: true,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("not on the adviser shelf"),
    });

    // No insert happened — gate fired before the write.
    expect(getInserted()).toHaveLength(0);
  });

  it("rejects with 400 when neither adviceRecordId nor adviceRecordNotLinked is provided", async () => {
    stage([linkRow()]);
    stage([clientRow()]);
    stage([productRow()]);

    await expect(
      createAdviserInstruction(ADVISER, {
        clientUserId: CLIENT,
        productId: PRODUCT,
        action: "buy",
        amount: "1000.00",
        // Both adviceRecordId and adviceRecordNotLinked deliberately omitted.
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("no linked advice record"),
    });

    expect(getInserted()).toHaveLength(0);
  });

  it("rejects with 400 when the product is high-risk and suitabilityBasis is empty", async () => {
    stage([linkRow()]);
    stage([clientRow()]);
    stage([productRow({ riskProfile: "high" })]);

    await expect(
      createAdviserInstruction(ADVISER, {
        clientUserId: CLIENT,
        productId: PRODUCT,
        action: "buy",
        amount: "1000.00",
        adviceRecordNotLinked: true,
        // Whitespace-only must also be treated as empty by the gate.
        suitabilityBasis: "   ",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Suitability basis is required"),
    });

    expect(getInserted()).toHaveLength(0);
  });

  it("rejects with 400 when action is 'switch' and switchFromProductId is missing", async () => {
    stage([linkRow()]);
    stage([clientRow()]);
    stage([productRow()]);

    await expect(
      createAdviserInstruction(ADVISER, {
        clientUserId: CLIENT,
        productId: PRODUCT,
        action: "switch",
        amount: "1000.00",
        adviceRecordNotLinked: true,
        // switchFromProductId deliberately omitted.
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Switch instructions require"),
    });

    expect(getInserted()).toHaveLength(0);
  });

  it("rejects with 400 when action is 'switch' and switchFromProductId equals productId", async () => {
    stage([linkRow()]);
    stage([clientRow()]);
    stage([productRow()]);

    await expect(
      createAdviserInstruction(ADVISER, {
        clientUserId: CLIENT,
        productId: PRODUCT,
        action: "switch",
        amount: "1000.00",
        adviceRecordNotLinked: true,
        switchFromProductId: PRODUCT,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(
        "Switch source and destination products must differ",
      ),
    });

    expect(getInserted()).toHaveLength(0);
  });

  it("persists expiresAt, adviceRecordNotLinked, suitabilityBasis, and switchFromProductId on the happy path", async () => {
    // 1. assertAdviserClientLink → link row exists.
    stage([linkRow()]);
    // 2. clientRow lookup for the fixture filter — non-fixture email, so
    //    the filter is a no-op and does not issue another select.
    stage([clientRow()]);
    // 3. Product lookup — high-risk so we can also exercise the
    //    suitabilityBasis persistence branch alongside the switch path.
    stage([
      productRow({
        id: PRODUCT,
        isActive: true,
        category: "venture_capital",
        riskProfile: "high",
      }),
    ]);
    // 4. Switch source product lookup — must be active and on the shelf.
    stage([
      {
        id: SWITCH_FROM,
        isActive: true,
        category: "real_estate",
      },
    ]);

    const before = Date.now();
    const result = await createAdviserInstruction(ADVISER, {
      clientUserId: CLIENT,
      productId: PRODUCT,
      action: "switch",
      amount: "2500.00",
      adviceRecordNotLinked: true,
      suitabilityBasis: "  Client objectives align with high-growth bucket  ",
      switchFromProductId: SWITCH_FROM,
    });
    const after = Date.now();

    const inserted = getInserted();
    expect(inserted).toHaveLength(1);
    const values = inserted[0];

    // adviceRecordNotLinked is derived from adviceRecordId == null, so the
    // happy-path "no linked advice record" choice persists as `true`.
    expect(values.adviceRecordNotLinked).toBe(true);
    expect(values.adviceRecordId).toBeNull();

    // Suitability basis is trimmed before persistence (and a whitespace-only
    // value would have been rejected upstream — see the high-risk test).
    expect(values.suitabilityBasis).toBe(
      "Client objectives align with high-growth bucket",
    );

    // Switch source persisted exactly as supplied.
    expect(values.switchFromProductId).toBe(SWITCH_FROM);

    // expiresAt is the consent TTL (7 days) measured from the call instant.
    // Verify it lands inside [before + 7d, after + 7d] so the gate is the
    // one writing the deadline (not a stale stub).
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    expect(values.expiresAt).toBeInstanceOf(Date);
    const expiresAtMs = (values.expiresAt as Date).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(after + SEVEN_DAYS_MS);

    // Sanity: status hard-coded to pending_consent (adviser cannot bypass).
    expect(values.status).toBe("pending_consent");

    // The function returned the synthesised row that the insert mock echoed.
    expect(result).toMatchObject({
      adviserUserId: ADVISER,
      clientUserId: CLIENT,
      productId: PRODUCT,
      action: "switch",
      amount: "2500.00",
      adviceRecordNotLinked: true,
      switchFromProductId: SWITCH_FROM,
    });
  });
});
