// =============================================================================
// Task #365 — pin the canonical risk-profile enum on admin product writes
// =============================================================================
// Task #339 cleaned the historical `investment_products.risk_profile` drift
// (sentence-case "High" / "Very High" sneaking in and silently disabling the
// adviser suitability check + the investments-page risk filter, both of
// which compare with strict equality against the canonical lowercase keys
// from `shared/risk-profiles.ts`). The fix tightened the create/update zod
// schemas in `server/admin-routes.ts` to `z.enum(RISK_PROFILE_KEYS)`. There
// was no automated test pinning that behaviour — if a future contributor
// loosened the schema (for example, swapped the enum back to `z.string()`
// to "be lenient with seed data"), the silent drift would reappear and we
// would only notice when an investor saw an empty risk filter or an
// adviser flagged a "High" product as outside their permitted band.
//
// This file locks the contract end-to-end:
//
//   * POST /api/admin/products MUST reject sentence-case values like
//     "High" and "Very High" with a 4xx (400) response, AND must accept
//     the canonical lowercase keys.
//   * PATCH /api/admin/products/:id MUST reject the same sentence-case
//     values with a 4xx (400) response, AND must accept a switch to
//     another canonical lowercase key.
//
// Implementation notes:
//   * We register only `registerAdminRoutes` on a tiny loopback express
//     server — the only middleware needed is `express.json` because the
//     `adminRoute` wrapper does its own JWT check via `requireAuth`.
//   * JWT_SECRET is set inside `vi.hoisted` so it lands BEFORE the
//     transitive import of `server/auth.ts`, which throws at module init
//     when the secret is missing outside local-dev.
//   * A real admin user row is seeded so the audit-log INSERT performed
//     inside the create/update transactions satisfies its FK back to
//     `users(id)`. The seedKey embedded in the username keeps each run
//     scoped so leftover rows from a failed run never collide.
//   * Created products are deleted in afterAll. The seeded admin user is
//     intentionally left behind because audit_logs is INSERT-ONLY (DELETE
//     blocked at the DB layer) and audit_logs.user_id has an FK back to
//     users(id) — see fee-consents.test.ts for the same rationale.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-365-product-risk-profile-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { db } from "./db";
import { users, investmentProducts } from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;
let adminUserId: number;
let adminToken: string;

// Track every product id we create so afterAll can clean them up even if
// individual tests bail out early.
const createdProductIds: number[] = [];

// A complete, schema-valid product payload with `riskProfile` as the only
// variable. We default `isActive: false` so the create-time invariant
// "active product must have annualReturn" never fires — this test is about
// the risk-profile enum, not the activation rule, and a separate test
// covers the activation invariant.
function buildProductPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${seedKey}_risk_profile_test_product`,
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Test-only product for the Task #365 risk-profile enum guard.",
    targetNetIrr: "10% p.a.",
    term: "2 years",
    structure: "Test structure",
    distributions: "Quarterly",
    liquidity: "Fixed-term, no early redemptions",
    minimumInvestment: "100000.00",
    riskProfile: "high",
    returnType: "income",
    isActive: false,
    ...overrides,
  };
}

beforeAll(async () => {
  seedKey = `t365_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Real admin row so the audit-log INSERT inside the product create/update
  // transactions satisfies its FK back to users(id).
  const [adminRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_admin`,
      email: `${seedKey}_admin@test.invalid`,
      password: "x",
      firstName: "Test",
      lastName: "Admin",
      role: "admin",
    })
    .returning();
  adminUserId = adminRow.id;

  adminToken = signToken({
    userId: adminUserId,
    username: adminRow.username,
    email: adminRow.email,
    role: "admin",
  });
});

afterAll(async () => {
  // Drop any test products we created. The seeded admin user is left
  // behind on purpose — see the file header for the audit_logs FK reason.
  if (createdProductIds.length > 0) {
    await db
      .delete(investmentProducts)
      .where(inArray(investmentProducts.id, createdProductIds));
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function postProduct(
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/admin/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function patchProduct(
  id: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/admin/products/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

describe("POST /api/admin/products — riskProfile enum guard (Task #365)", () => {
  it("rejects sentence-case 'High' with a 400 and never creates the row", async () => {
    const before = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, `${seedKey}_create_reject_high`));
    expect(before.length).toBe(0);

    const { status, body } = await postProduct(
      buildProductPayload({
        name: `${seedKey}_create_reject_high`,
        riskProfile: "High",
      }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);

    // Belt-and-braces: confirm the row was never inserted.
    const after = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, `${seedKey}_create_reject_high`));
    expect(after.length).toBe(0);
  });

  it("rejects sentence-case 'Very High' with a 400 and never creates the row", async () => {
    const { status, body } = await postProduct(
      buildProductPayload({
        name: `${seedKey}_create_reject_very_high`,
        riskProfile: "Very High",
      }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);

    const after = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, `${seedKey}_create_reject_very_high`));
    expect(after.length).toBe(0);
  });

  it("accepts the canonical lowercase 'high' and creates the row", async () => {
    const productName = `${seedKey}_create_accept_high`;
    const { status, body } = await postProduct(
      buildProductPayload({
        name: productName,
        riskProfile: "high",
      }),
    );
    expect(status).toBe(200);
    expect(body.id).toEqual(expect.any(Number));
    expect(body.riskProfile).toBe("high");
    createdProductIds.push(body.id);

    const persisted = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, body.id))
      .limit(1);
    expect(persisted.length).toBe(1);
    expect(persisted[0].riskProfile).toBe("high");
  });
});

describe("PATCH /api/admin/products/:id — riskProfile enum guard (Task #365)", () => {
  let targetProductId: number;

  beforeAll(async () => {
    // Seed a product to mutate. We use the create endpoint itself so the
    // PATCH cases run against a row that the same admin path produced —
    // proving the enum guard is symmetric across create + update.
    const productName = `${seedKey}_patch_target`;
    const { status, body } = await postProduct(
      buildProductPayload({
        name: productName,
        riskProfile: "moderate",
      }),
    );
    expect(status).toBe(200);
    targetProductId = body.id;
    createdProductIds.push(targetProductId);
  });

  it("rejects sentence-case 'High' with a 400 and leaves the row unchanged", async () => {
    const { status, body } = await patchProduct(targetProductId, {
      riskProfile: "High",
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);

    const [row] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, targetProductId))
      .limit(1);
    expect(row.riskProfile).toBe("moderate");
  });

  it("rejects sentence-case 'Very High' with a 400 and leaves the row unchanged", async () => {
    const { status, body } = await patchProduct(targetProductId, {
      riskProfile: "Very High",
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);

    const [row] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, targetProductId))
      .limit(1);
    expect(row.riskProfile).toBe("moderate");
  });

  it("accepts the canonical lowercase 'very_high' and updates the row", async () => {
    const { status, body } = await patchProduct(targetProductId, {
      riskProfile: "very_high",
    });
    expect(status).toBe(200);
    expect(body.riskProfile).toBe("very_high");

    const [row] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, targetProductId))
      .limit(1);
    expect(row.riskProfile).toBe("very_high");
  });
});
