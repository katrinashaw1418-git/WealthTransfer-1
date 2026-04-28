// =============================================================================
// Task #363 — pin the canonical category enum on admin product writes
// =============================================================================
// Companion to `shared/product-categories.test.ts`. That file covers the
// schema-layer guard on `insertInvestmentProductSchema`. This file pins
// the equivalent guard on `adminUpdateProductSchema` (the PATCH-side
// schema in `server/admin-routes.ts`).
//
// `adminUpdateProductSchema` is declared inside the closure of
// `registerAdminRoutes` and is NOT exported — per the task spec, the
// regression boundary is therefore an HTTP-level assertion against
// `PATCH /api/admin/products/:id` returning 400 for `category: "x"`.
// We also assert that `POST /api/admin/products` enforces the same
// guard, since `adminCreateProductSchema` is built on top of
// `insertInvestmentProductSchema` and a future refactor that swaps
// the base out from under it would silently widen the create path.
//
// Pattern mirrors `admin-routes-product-risk-profile.test.ts` (Task
// #365), which is the immediately adjacent enum-guard contract test:
//   * Loopback express server with only `registerAdminRoutes` mounted.
//   * JWT_SECRET set inside `vi.hoisted` so it lands BEFORE
//     `server/auth.ts` is module-initialised.
//   * Real admin user seeded so the audit-log INSERT inside the create/
//     update transactions satisfies its FK back to `users(id)`.
//   * Created products are deleted in afterAll. The seeded admin user is
//     intentionally left behind because audit_logs is INSERT-ONLY (DELETE
//     blocked at the DB layer) and audit_logs.user_id has an FK back to
//     users(id) — see fee-consents.test.ts for the same rationale.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-363-product-category-validation-test-secret";
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
import { PRODUCT_CATEGORY_VALUES } from "@shared/product-categories";

let server: http.Server;
let baseUrl: string;
let seedKey: string;
let adminUserId: number;
let adminToken: string;

const createdProductIds: number[] = [];

// A complete, schema-valid product payload with `category` as the only
// variable. `isActive: false` keeps the active-product activation rule
// (annualReturn required) out of scope — this test is about the
// category enum guard only, and `admin-routes-product-history.test.ts`
// already covers the activation invariant.
function buildProductPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${seedKey}_category_test_product`,
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Test product for the Task #363 category enum guard.",
    targetNetIrr: "10% p.a.",
    term: "2 years",
    structure: "Test structure",
    distributions: "Quarterly",
    liquidity: "Fixed-term, no early redemptions",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    isActive: false,
    ...overrides,
  };
}

beforeAll(async () => {
  seedKey = `t363_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

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

describe("POST /api/admin/products — category enum guard (Task #363)", () => {
  it("rejects the historical bad category 'x' with a 400 and never creates the row", async () => {
    const productName = `${seedKey}_create_reject_x`;

    const before = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, productName));
    expect(before.length).toBe(0);

    const { status, body } = await postProduct(
      buildProductPayload({ name: productName, category: "x" }),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);
    // Surface the canonical enum so an operator reading the error knows
    // exactly what to switch to.
    for (const canonical of PRODUCT_CATEGORY_VALUES) {
      expect(String(body.error || "")).toContain(canonical);
    }

    // Belt-and-braces: confirm the row was never inserted.
    const after = await db
      .select({ id: investmentProducts.id })
      .from(investmentProducts)
      .where(eq(investmentProducts.name, productName));
    expect(after.length).toBe(0);
  });

  it("accepts every canonical category and creates the row", async () => {
    for (const category of PRODUCT_CATEGORY_VALUES) {
      const productName = `${seedKey}_create_accept_${category}`;
      const { status, body } = await postProduct(
        buildProductPayload({ name: productName, category }),
      );
      expect(status, `POST should accept canonical category '${category}'`).toBe(200);
      expect(body.id).toEqual(expect.any(Number));
      expect(body.category).toBe(category);
      createdProductIds.push(body.id);
    }
  });
});

describe("PATCH /api/admin/products/:id — category enum guard (Task #363)", () => {
  let targetProductId: number;

  beforeAll(async () => {
    const productName = `${seedKey}_patch_target`;
    const { status, body } = await postProduct(
      buildProductPayload({ name: productName, category: "real_estate" }),
    );
    expect(status).toBe(200);
    targetProductId = body.id;
    createdProductIds.push(targetProductId);
  });

  it("rejects the historical bad category 'x' with a 400 and leaves the row unchanged", async () => {
    const { status, body } = await patchProduct(targetProductId, {
      category: "x",
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(String(body.error || "")).toMatch(/Invalid payload/i);
    // The error must enumerate every canonical value so an admin sees
    // exactly what is permitted in the failure message.
    for (const canonical of PRODUCT_CATEGORY_VALUES) {
      expect(String(body.error || "")).toContain(canonical);
    }

    const [row] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, targetProductId))
      .limit(1);
    expect(row.category).toBe("real_estate");
  });

  it("accepts a switch to another canonical category and updates the row", async () => {
    const { status, body } = await patchProduct(targetProductId, {
      category: "corporate_credit",
    });
    expect(status).toBe(200);
    expect(body.category).toBe("corporate_credit");

    const [row] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, targetProductId))
      .limit(1);
    expect(row.category).toBe("corporate_credit");
  });
});
