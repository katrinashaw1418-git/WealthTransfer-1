// =============================================================================
// Task #360 — pin the admin `isPublished` toggle on product create + update
// =============================================================================
// Task #350 added an investor-visibility flag (`isPublished`) to the
// investment_products table and exposed it on both:
//
//   * POST  /api/admin/products            — create-time flag, optional,
//                                            DB default `true`. Admins can
//                                            stage a product as a draft by
//                                            passing `isPublished: false`.
//   * PATCH /api/admin/products/:id        — toggle from Published <-> Draft.
//                                            The handler writes an
//                                            `admin_product_updated` audit
//                                            row whose metadata captures
//                                            `previousIsPublished` and
//                                            `newIsPublished` so the change
//                                            is regulator-traceable.
//
// Investor-facing reads (Task #336) filter on `isActive=true AND
// isPublished=true`, so a regression that drops or ignores the flag would
// silently leak draft products to clients. There were no automated tests
// pinning the contract — this file fixes that.
//
// What this file pins:
//
//   1. POST /api/admin/products with `{ isPublished: false }` is accepted,
//      persists `is_published = false` on the row, and the
//      `admin_product_created` audit row's metadata records
//      `isPublished: false`.
//
//   2. PATCH /api/admin/products/:id with `{ isPublished: false }` updates
//      the row and writes an `admin_product_updated` audit row whose
//      metadata contains `previousIsPublished: true` (DB default for the
//      newly-created fixture) and `newIsPublished: false`. The same audit
//      row also lists `"isPublished"` under `updatedFields`.
//
// Implementation notes:
//   * Mirrors the loopback-server pattern from the existing
//     `admin-routes-product-history.test.ts` and
//     `admin-routes-product-risk-profile.test.ts` files (own seedKey, real
//     admin user so the audit_logs FK is satisfied, products cleaned up
//     in afterAll, the seeded admin user is intentionally left behind
//     because audit_logs is INSERT-ONLY).
//   * JWT_SECRET is set inside `vi.hoisted` so it lands BEFORE the
//     transitive import of `server/auth.ts`, which throws at module init
//     when the secret is missing outside local-dev.
//   * We drive the real POST/PATCH endpoints to GENERATE the audit rows
//     rather than inserting fake `audit_logs` by hand — this proves the
//     test stays compatible with whatever the write path actually emits.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-360-product-is-published-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { db } from "./db";
import { auditLogs, investmentProducts, users } from "@shared/schema";

let server: http.Server;
let baseUrl: string;
let seedKey: string;
let adminUserId: number;
let adminToken: string;

const createdProductIds: number[] = [];

// A complete, schema-valid product payload. We default `isActive: false`
// so the create-time invariant "active product must have annualReturn"
// never fires — this test is about the `isPublished` flag, not the
// activation rule (covered separately).
function buildProductPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${seedKey}_is_published_test_product`,
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Test product for the Task #360 isPublished toggle.",
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

beforeAll(async () => {
  seedKey = `t360_${randomBytes(4).toString("hex")}`;

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

describe("admin product `isPublished` toggle (Task #360)", () => {
  it("POST /api/admin/products accepts `isPublished: false` on creation and audits it", async () => {
    const created = await postProduct(
      buildProductPayload({
        name: `${seedKey}_create_draft`,
        isPublished: false,
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body.isPublished).toBe(false);
    createdProductIds.push(created.body.id);

    // Round-trip the row from the DB to prove persistence (not just the
    // returning() projection).
    const [persisted] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, created.body.id))
      .limit(1);
    expect(persisted).toBeDefined();
    expect(persisted.isPublished).toBe(false);

    // The create handler writes an `admin_product_created` audit row whose
    // metadata snapshot includes `isPublished`. There is no read endpoint
    // for the created action, so query audit_logs directly.
    const createAuditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_product_created"),
          eq(auditLogs.entityType, "investment_product"),
          eq(auditLogs.entityId, String(created.body.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(createAuditRows.length).toBe(1);
    const meta = (createAuditRows[0].metadata ?? {}) as Record<string, unknown>;
    expect(meta.isPublished).toBe(false);
  });

  it("POST /api/admin/products defaults `isPublished` to true when omitted", async () => {
    // Pin the DB default behaviour (Task #350 set `.default(true)`), so a
    // future schema change away from that default surfaces here rather
    // than silently flipping every untouched create call to draft.
    const created = await postProduct(
      buildProductPayload({ name: `${seedKey}_create_default` }),
    );
    expect(created.status).toBe(200);
    expect(created.body.isPublished).toBe(true);
    createdProductIds.push(created.body.id);
  });

  it("PATCH /api/admin/products/:id flips `isPublished` to false and audits previous/new state", async () => {
    // Seed a fresh product that defaults to `isPublished: true`, then
    // flip it to false in a separate PATCH call so the audit row records
    // the transition, not the create.
    const created = await postProduct(
      buildProductPayload({ name: `${seedKey}_patch_target` }),
    );
    expect(created.status).toBe(200);
    expect(created.body.isPublished).toBe(true);
    createdProductIds.push(created.body.id);

    const patched = await patchProduct(created.body.id, { isPublished: false });
    expect(patched.status).toBe(200);
    expect(patched.body.isPublished).toBe(false);

    // Re-read from the DB to confirm persistence.
    const [persisted] = await db
      .select()
      .from(investmentProducts)
      .where(eq(investmentProducts.id, created.body.id))
      .limit(1);
    expect(persisted.isPublished).toBe(false);

    // The PATCH handler emits an `admin_product_updated` audit row whose
    // metadata captures `previousIsPublished` / `newIsPublished` plus the
    // list of patched field names. Find the most recent one for this
    // product.
    const updateAuditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_product_updated"),
          eq(auditLogs.entityType, "investment_product"),
          eq(auditLogs.entityId, String(created.body.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(updateAuditRows.length).toBe(1);
    const meta = (updateAuditRows[0].metadata ?? {}) as Record<string, unknown>;
    expect(meta.previousIsPublished).toBe(true);
    expect(meta.newIsPublished).toBe(false);
    expect(Array.isArray(meta.updatedFields)).toBe(true);
    expect(meta.updatedFields as string[]).toContain("isPublished");
    expect(updateAuditRows[0].userId).toBe(adminUserId);
  });
});
