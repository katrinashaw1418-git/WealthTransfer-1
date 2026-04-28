// =============================================================================
// Task #385 — GET /api/admin/products/:id/history
// =============================================================================
// The PATCH /api/admin/products/:id handler writes one `audit_logs` row per
// edit (action `admin_product_updated`, entityType `investment_product`,
// entityId = the product id, metadata.updatedFields = the patched keys).
// Task #385 adds a read-only sibling endpoint that joins those rows back to
// the actor's username/email so the admin UI can show "who changed what,
// when" without going to the database.
//
// This file pins the contract end-to-end:
//
//   * GET /api/admin/products/:id/history returns ONLY rows for the
//     requested product (entityId match) AND only `admin_product_updated`
//     action rows (so unrelated audit traffic doesn't leak in).
//   * Rows are returned newest-first.
//   * Each row carries the actor's username + email (LEFT JOIN, so a NULL
//     userId or a deleted actor still surfaces the audit row rather than
//     vanishing from the timeline).
//   * Invalid product ids reject with a 400 BEFORE hitting the DB.
//   * The endpoint requires admin auth (a non-admin token gets 4xx).
//
// Implementation notes:
//   * Mirrors the loopback-server pattern from
//     `admin-routes-product-risk-profile.test.ts` (own seedKey, real admin
//     row so audit_logs FK satisfies, products cleaned up in afterAll,
//     admin user is intentionally left behind because audit_logs is
//     INSERT-ONLY).
//   * We drive the PATCH endpoint to GENERATE the audit rows rather than
//     inserting fake audit_logs by hand — this proves the read endpoint
//     stays compatible with whatever the write path actually emits.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-385-product-history-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { db } from "./db";
import { users, investmentProducts } from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;
let adminUserId: number;
let adminToken: string;
let clientToken: string;
let productAId: number;
let productBId: number;

const createdProductIds: number[] = [];

function buildProductPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${seedKey}_history_test_product`,
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Test product for the Task #385 history endpoint.",
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

async function postProduct(body: Record<string, unknown>) {
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

async function patchProduct(id: number, body: Record<string, unknown>) {
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

async function getHistory(id: number | string, token = adminToken) {
  const res = await fetch(`${baseUrl}/api/admin/products/${id}/history`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

beforeAll(async () => {
  seedKey = `t385_${randomBytes(4).toString("hex")}`;

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

  const [clientRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_client`,
      email: `${seedKey}_client@test.invalid`,
      password: "x",
      firstName: "Test",
      lastName: "Client",
      role: "client",
    })
    .returning();
  clientToken = signToken({
    userId: clientRow.id,
    username: clientRow.username,
    email: clientRow.email,
    role: "client",
  });

  // Create two distinct products so we can prove the entityId filter is
  // honoured (an edit to B must not appear in A's history).
  const a = await postProduct(buildProductPayload({ name: `${seedKey}_a` }));
  expect(a.status).toBe(200);
  productAId = a.body.id;
  createdProductIds.push(productAId);

  const b = await postProduct(buildProductPayload({ name: `${seedKey}_b` }));
  expect(b.status).toBe(200);
  productBId = b.body.id;
  createdProductIds.push(productBId);

  // Generate two PATCH events on A (newest first: targetNetIrr, then term)
  // and one on B. Small sleep between A's two patches so the createdAt
  // ordering is deterministic.
  const p1 = await patchProduct(productAId, { targetNetIrr: "11% p.a." });
  expect(p1.status).toBe(200);
  await new Promise((r) => setTimeout(r, 25));
  const p2 = await patchProduct(productAId, { term: "3 years" });
  expect(p2.status).toBe(200);
  const p3 = await patchProduct(productBId, { distributions: "Annually" });
  expect(p3.status).toBe(200);
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

describe("GET /api/admin/products/:id/history (Task #385)", () => {
  it("returns the product's own audit entries newest-first with actor + fields", async () => {
    const { status, body } = await getHistory(productAId);
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    // Two PATCH calls on A — exactly two history rows.
    expect(body.items.length).toBe(2);

    const [latest, earlier] = body.items;

    // Newest-first ordering: the `term` patch was sent AFTER targetNetIrr.
    expect(latest.metadata?.updatedFields).toEqual(["term"]);
    expect(earlier.metadata?.updatedFields).toEqual(["targetNetIrr"]);

    // Both rows carry the canonical action and the joined actor identity.
    for (const row of body.items) {
      expect(row.action).toBe("admin_product_updated");
      expect(row.userId).toBe(adminUserId);
      expect(row.actorUsername).toBe(`${seedKey}_admin`);
      expect(row.actorEmail).toBe(`${seedKey}_admin@test.invalid`);
      expect(typeof row.createdAt).toBe("string");
    }

    // createdAt must be monotonically non-increasing (newest first).
    const t0 = new Date(latest.createdAt).getTime();
    const t1 = new Date(earlier.createdAt).getTime();
    expect(t0).toBeGreaterThanOrEqual(t1);
  });

  it("scopes to the requested product — B's edit does NOT appear in A's history", async () => {
    const a = await getHistory(productAId);
    expect(a.status).toBe(200);
    for (const row of a.body.items) {
      expect(row.metadata?.updatedFields).not.toContain("distributions");
    }

    const b = await getHistory(productBId);
    expect(b.status).toBe(200);
    expect(b.body.items.length).toBe(1);
    expect(b.body.items[0].metadata?.updatedFields).toEqual(["distributions"]);
  });

  it("returns an empty list (not 404) for a product that has no edits yet", async () => {
    const fresh = await postProduct(
      buildProductPayload({ name: `${seedKey}_fresh_no_edits` }),
    );
    expect(fresh.status).toBe(200);
    createdProductIds.push(fresh.body.id);

    const { status, body } = await getHistory(fresh.body.id);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it("rejects an invalid product id with a 400", async () => {
    const a = await getHistory("not-a-number");
    expect(a.status).toBe(400);

    const b = await getHistory(0);
    expect(b.status).toBe(400);

    const c = await getHistory(-1);
    expect(c.status).toBe(400);
  });

  it("requires admin auth — a client-role token is rejected", async () => {
    const { status } = await getHistory(productAId, clientToken);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
