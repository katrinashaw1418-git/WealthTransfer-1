// =============================================================================
// Task #386 — pin the admin product edit flow (PATCH /api/admin/products/:id)
// =============================================================================
// Task #371 added an "Edit" action to the admin products table that opens the
// existing dialog pre-populated with the row's current values and PATCHes
// only the fields the admin actually changed (see `submitDialog` in
// `client/src/pages/admin/products.tsx`, which builds the patch from
// react-hook-form's `dirtyFields` map). The PATCH handler in
// `server/admin-routes.ts` accepts the full editable field set partially via
// `adminUpdateProductSchema` and writes one `audit_logs` row per edit.
//
// There was no automated coverage of that flow, so a future change to either
// the dialog's field list or the validator could silently break editing — for
// example, a typo in the schema's `subCategory` key would just drop the field
// from the payload without erroring, and nothing in CI would catch it.
//
// What this file pins, end-to-end, against the real PATCH endpoint:
//
//   1. Every editable field exposed by the dialog (name, category,
//      subCategory, investmentStrategy, targetNetIrr, term, structure,
//      distributions, liquidity, minimumInvestment, riskProfile, returnType,
//      returnMethod, annualReturn, isPublished) can be patched in isolation,
//      the row reflects the new value, and the `admin_product_updated` audit
//      row's `metadata.updatedFields` lists exactly that field.
//
//   2. A true partial PATCH does NOT clobber unchanged fields — for each
//      single-field edit we re-read the row and assert every OTHER editable
//      field is byte-identical to the baseline read taken right after create.
//      This is the regression we most care about: the dialog only sends dirty
//      fields, so silently zeroing the rest on the server would be invisible
//      to the user until they reopened the dialog (or, worse, never).
//
//   3. The audit row is attributable: `userId` matches the calling admin and
//      `entityId` matches the product id, so the Task #385 history endpoint
//      can join them.
//
// Implementation notes:
//   * Mirrors the loopback-server pattern from
//     `admin-routes-product-is-published.test.ts` and
//     `admin-routes-product-history.test.ts` (own seedKey, real admin user
//     so the `audit_logs.user_id` FK is satisfied, products cleaned up in
//     afterAll, the seeded admin user is intentionally left behind because
//     `audit_logs` is INSERT-ONLY and references it).
//   * `JWT_SECRET` is set inside `vi.hoisted` so it lands BEFORE the
//     transitive import of `server/auth.ts`, which throws at module init
//     when the secret is missing outside local-dev.
//   * We drive the real POST to seed and the real PATCH to mutate (rather
//     than inserting rows / audit_logs by hand) so the test stays compatible
//     with whatever the write paths actually emit — including any future
//     fields added to the audit metadata snapshot.
//   * Baseline values for `minimumInvestment` and `annualReturn` are
//     pre-normalised to the column's scale ("100000.00" at scale 2, "0.1100"
//     at scale 4) so the post-PATCH equality check on UNCHANGED fields does
//     not get tripped up by Postgres' decimal roundtrip formatting.
//   * The product is seeded with `isActive: false` so the create-time
//     "active product must have annualReturn" invariant never fires; this
//     test is about the partial-edit contract, not the activation rule
//     (covered by other admin-routes tests).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-386-product-edit-flow-test-secret";
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

// Baseline values shared by every per-field test. Each editable field has a
// distinct, recognisable value so a "wrong field clobbered" regression shows
// up as a visible mismatch rather than two fields happening to share a value.
function buildBaselinePayload(name: string): Record<string, unknown> {
  return {
    name,
    category: "real_estate",
    subCategory: "equity_fund",
    investmentStrategy: "Baseline strategy for the Task #386 edit-flow test.",
    targetNetIrr: "10% p.a.",
    term: "2 years",
    structure: "Unit trust",
    distributions: "Quarterly",
    liquidity: "Fixed-term, no early redemptions",
    minimumInvestment: "100000.00",
    riskProfile: "moderate",
    returnType: "income",
    returnMethod: "fixed_annual_compound",
    annualReturn: "0.1100",
    isActive: false,
    isPublished: true,
  };
}

// The editable field set covered by the dialog (Task #371). Each entry has the
// field key (matching both `adminUpdateProductSchema` and the
// `investmentProducts` column name) and a `newValue` that differs from the
// baseline above so the PATCH is observable.
const EDITABLE_FIELDS: ReadonlyArray<{
  key: string;
  newValue: unknown;
}> = [
  { key: "name", newValue: "renamed_after_edit" },
  { key: "category", newValue: "corporate_credit" },
  { key: "subCategory", newValue: "credit_fund" },
  { key: "investmentStrategy", newValue: "Updated strategy text." },
  { key: "targetNetIrr", newValue: "12% p.a." },
  { key: "term", newValue: "3 years" },
  { key: "structure", newValue: "Limited partnership" },
  { key: "distributions", newValue: "Annually" },
  { key: "liquidity", newValue: "Open-ended, monthly redemptions" },
  { key: "minimumInvestment", newValue: "75000.00" },
  { key: "riskProfile", newValue: "high" },
  { key: "returnType", newValue: "capital_gains" },
  { key: "returnMethod", newValue: "fixed_annual_simple" },
  { key: "annualReturn", newValue: "0.1500" },
  { key: "isPublished", newValue: false },
];

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

async function readProduct(id: number) {
  const [row] = await db
    .select()
    .from(investmentProducts)
    .where(eq(investmentProducts.id, id))
    .limit(1);
  return row;
}

async function seedBaselineProduct(suffix: string): Promise<{
  id: number;
  baseline: Record<string, unknown>;
}> {
  const created = await postProduct(
    buildBaselinePayload(`${seedKey}_${suffix}`),
  );
  expect(created.status).toBe(200);
  expect(typeof created.body.id).toBe("number");
  createdProductIds.push(created.body.id);
  // Read the row back from the DB so the "unchanged fields" comparison uses
  // exactly what Postgres actually stored (decimal scale, default isActive,
  // etc.) rather than what we sent on the wire.
  const baseline = await readProduct(created.body.id);
  expect(baseline).toBeDefined();
  return { id: created.body.id, baseline: baseline as Record<string, unknown> };
}

beforeAll(async () => {
  seedKey = `t386_${randomBytes(4).toString("hex")}`;

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

describe("admin product edit flow PATCH /api/admin/products/:id (Task #386)", () => {
  // One test per editable field. Each iteration:
  //   1. seeds a fresh product (so failures don't cascade and the baseline
  //      isn't polluted by a prior test's PATCH);
  //   2. PATCHes ONLY that field;
  //   3. asserts the row reflects the new value AND every other editable
  //      field still matches the baseline read (true partial-update);
  //   4. asserts the audit row exists, has updatedFields = [thatField], and
  //      is attributed to the calling admin user.
  for (const { key, newValue } of EDITABLE_FIELDS) {
    it(`PATCH with only \`${key}\` updates that field, leaves others intact, and audits it`, async () => {
      const { id, baseline } = await seedBaselineProduct(`patch_${key}`);

      const patched = await patchProduct(id, { [key]: newValue });
      expect(patched.status).toBe(200);
      expect(patched.body.id).toBe(id);
      // The PATCH response is the freshly-updated row; the patched field
      // must show the new value on the wire (the dialog re-renders from
      // this response after a successful save).
      expect((patched.body as Record<string, unknown>)[key]).toEqual(newValue);

      // Round-trip from the DB to prove persistence.
      const after = (await readProduct(id)) as Record<string, unknown>;
      expect(after).toBeDefined();
      expect(after[key]).toEqual(newValue);

      // Every OTHER editable field must still equal the baseline read. This
      // is the regression we care about: the dialog sends only dirty fields,
      // so a server-side bug that rewrote unchanged columns would be
      // invisible to the admin until they reopened the row.
      for (const other of EDITABLE_FIELDS) {
        if (other.key === key) continue;
        expect(
          after[other.key],
          `field "${other.key}" was clobbered by a partial PATCH that only changed "${key}"`,
        ).toEqual(baseline[other.key]);
      }

      // Audit row exists, is attributed to the calling admin, and lists
      // exactly this one field under updatedFields. We fetch the most
      // recent admin_product_updated row for this product id.
      const [auditRow] = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "admin_product_updated"),
            eq(auditLogs.entityType, "investment_product"),
            eq(auditLogs.entityId, String(id)),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      expect(auditRow).toBeDefined();
      expect(auditRow.userId).toBe(adminUserId);
      const meta = (auditRow.metadata ?? {}) as Record<string, unknown>;
      expect(Array.isArray(meta.updatedFields)).toBe(true);
      expect(meta.updatedFields as string[]).toEqual([key]);
    });
  }

  it("PATCH with multiple changed fields applies all of them and audits the full set", async () => {
    // Real edits typically touch more than one field at a time (e.g. the
    // admin tweaks the strategy text AND the minimum). This pins that the
    // multi-field path still works: every changed field is persisted, every
    // unchanged field is preserved, and updatedFields lists exactly the
    // patched keys (order-insensitive, since the handler derives it from
    // Object.keys on the parsed payload).
    const { id, baseline } = await seedBaselineProduct("patch_multi");

    const changes = {
      name: "renamed_multi",
      targetNetIrr: "13% p.a.",
      minimumInvestment: "50000.00",
      isPublished: false,
    };
    const patched = await patchProduct(id, changes);
    expect(patched.status).toBe(200);

    const after = (await readProduct(id)) as Record<string, unknown>;
    expect(after.name).toBe(changes.name);
    expect(after.targetNetIrr).toBe(changes.targetNetIrr);
    expect(after.minimumInvestment).toBe(changes.minimumInvestment);
    expect(after.isPublished).toBe(false);

    // Untouched editable fields must still match the baseline read.
    const changedKeys = new Set(Object.keys(changes));
    for (const { key } of EDITABLE_FIELDS) {
      if (changedKeys.has(key)) continue;
      expect(after[key], `untouched field "${key}" was clobbered`).toEqual(
        baseline[key],
      );
    }

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_product_updated"),
          eq(auditLogs.entityType, "investment_product"),
          eq(auditLogs.entityId, String(id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(auditRow).toBeDefined();
    const meta = (auditRow.metadata ?? {}) as Record<string, unknown>;
    expect(new Set(meta.updatedFields as string[])).toEqual(changedKeys);
  });
});
