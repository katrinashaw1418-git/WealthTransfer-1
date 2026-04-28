// =============================================================================
// Task #293 — invariants for the DBFO fee-consent surface
// =============================================================================
// Locks the contract for:
//   1. Adviser POST /api/adviser/fee-consent-requests
//        - rejects with 400 when adviceRecordId is missing
//        - rejects with 409 (kind=duplicate_pending_request) when the same
//          (client, adviceRecord, feeType, accountNumber) already has a
//          pending request, and returns the offending existingRequestId
//        - rejects with 409 (kind=duplicate_active_consent) when an
//          active/renewal_due consent already covers the same key, and
//          returns the offending existingConsentId
//        - on success, the row is created with status='pending' (i.e. NOT
//          flipped to 'consented' on the server's behalf)
//   2. Admin POST /api/admin/fee-consent-requests/:id/revoke
//        - rejects with 400 when the request is not in 'pending' status
//        - on success, status moves to 'withdrawn_by_adviser' AND the audit
//          row carries extra.revokedByAdmin=true
//   3. Admin POST /api/admin/fee-consents/:id/supersede
//        - atomically marks the existing consent renewalStatus='superseded',
//          stamps supersededByRequestId/At/Reason, AND inserts a fresh
//          pending request whose supersedesRequestId points at the original
//          request that signed the now-superseded consent
//   4. Admin GET /api/admin/fee-consents
//        - response carries the supersede chain links, signedIp, the
//          server-computed deductionsBlockedReason, and clientSignatureName
//
// Fixture isolation:
//   Every row inserted by this file uses a `seedKey` (a per-run uuid)
//   embedded in usernames and account numbers so re-running the file
//   never collides with rows left by an earlier failed run, and never
//   touches production-shaped data.
// =============================================================================

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "fee-consents-task-293-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdminRoutes } from "./admin-routes";
import { registerAdviserRoutes } from "./adviser-routes";
import { db } from "./db";
import {
  users,
  adviserClients,
  adviceRecords,
  feeConsents,
  feeConsentRequests,
  auditLogs,
} from "@shared/schema";

// -----------------------------------------------------------------------------
// Test runtime + fixtures
// -----------------------------------------------------------------------------
let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adminUserId: number;
let adviserUserId: number;
let clientUserId: number;
let adviceRecordId: number;
let secondAdviceRecordId: number;

let adminToken: string;
let adviserToken: string;

beforeAll(async () => {
  seedKey = `t293_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  registerAdviserRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Real DB rows so the partial unique index, the link enforcement check,
  // and the audit-log writer are all exercised end-to-end.
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

  const [adviserRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adv`,
      email: `${seedKey}_adv@test.invalid`,
      password: "x",
      firstName: "Test",
      lastName: "Adviser",
      role: "adviser",
    })
    .returning();
  adviserUserId = adviserRow.id;

  const [clientRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_cli`,
      email: `${seedKey}_cli@test.invalid`,
      password: "x",
      firstName: "Test",
      lastName: "Client",
      role: "client",
    })
    .returning();
  clientUserId = clientRow.id;

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    relationshipType: "servicing",
    isActive: true,
  });

  // Two advice records — the second is used for the "duplicate uniqueness
  // is scoped per advice record" test.
  const [ar1] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
    })
    .returning();
  adviceRecordId = ar1.id;
  const [ar2] = await db
    .insert(adviceRecords)
    .values({
      clientId: clientUserId,
      adviserId: adviserUserId,
      adviceType: "personal",
      adviceSource: "hybrid",
      status: "issued",
    })
    .returning();
  secondAdviceRecordId = ar2.id;

  adminToken = signToken({
    userId: adminUserId,
    username: adminRow.username,
    email: adminRow.email,
    role: "admin",
  });
  adviserToken = signToken({
    userId: adviserUserId,
    username: adviserRow.username,
    email: adviserRow.email,
    role: "adviser",
  });
});

afterAll(async () => {
  // Clean up the consent/request/link rows. We deliberately leave the
  // three seeded users (and their immutable audit-log rows) behind:
  //   - audit_logs is INSERT-ONLY (DELETE blocked at the DB layer), and
  //   - audit_logs.user_id has an FK back to users(id), so a follow-up
  //     DELETE on users would be rejected.
  // The seedKey embedded in usernames/emails keeps each test run scoped
  // so leftover rows never collide and never look like real data.
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  await db.delete(adviceRecords).where(eq(adviceRecords.clientId, clientUserId));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  // Each test starts from a clean slate of consent rows so duplicate
  // checks behave deterministically. Users + advice records survive.
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

function buildRequestPayload(overrides: Record<string, any> = {}) {
  // Reference day = ~30 days from now → renewal window opens 60d before
  // and closes 150d after, expiry == window end. Mirrors the validation
  // in adviser-routes.ts createFeeConsentRequestSchema.superRefine.
  const ref = new Date(Date.now() + 30 * DAY_MS);
  const start = new Date(ref.getTime() - 60 * DAY_MS);
  const end = new Date(ref.getTime() + 150 * DAY_MS);
  return {
    clientUserId,
    adviceRecordId,
    feeType: "ongoing_service_fee",
    amountType: "fixed",
    amount: "100.00",
    accountNumber: `${seedKey}_acct_${randomBytes(2).toString("hex")}`,
    accountName: "Test Account",
    deductionFrequency: "monthly",
    proposedReferenceDay: ref.toISOString(),
    proposedRenewalWindowStart: start.toISOString(),
    proposedRenewalWindowEnd: end.toISOString(),
    proposedConsentExpiryDate: end.toISOString(),
    requestNote: null,
    ...overrides,
  };
}

type JsonBody = Record<string, unknown>;
type JsonResponse = { status: number; body: Record<string, unknown> };

async function postAdviserRequest(body: JsonBody): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}/api/adviser/fee-consent-requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adviserToken}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function postAdminJson(
  path: string,
  body: JsonBody,
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

async function getAdminJson(path: string): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe("POST /api/adviser/fee-consent-requests — Task #293 invariants", () => {
  it("rejects missing adviceRecordId with 400 (advice record is required)", async () => {
    const payload = buildRequestPayload();
    delete (payload as any).adviceRecordId;
    const { status, body } = await postAdviserRequest(payload);
    expect(status).toBe(400);
    // Either Zod's "Required" (field missing) or our custom message — the
    // contract that matters is "this 400s, never silently inserts".
    expect(String(body.error || "")).toMatch(/adviceRecordId|advice record|Required/i);
  });

  it("creates a request with status='pending' (no auto-consent on the server)", async () => {
    const { status, body } = await postAdviserRequest(buildRequestPayload());
    expect(status).toBe(201);
    expect(body.status).toBe("pending");
    expect(body.signedFeeConsentId).toBeNull();
    expect(body.adviceRecordId).toBe(adviceRecordId);
  });

  it("returns 409 duplicate_pending_request with existingRequestId on a second send", async () => {
    const first = await postAdviserRequest(
      buildRequestPayload({ accountNumber: `${seedKey}_dup_pending` }),
    );
    expect(first.status).toBe(201);
    const second = await postAdviserRequest(
      buildRequestPayload({ accountNumber: `${seedKey}_dup_pending` }),
    );
    expect(second.status).toBe(409);
    expect(second.body.kind).toBe("duplicate_pending_request");
    expect(second.body.existingRequestId).toBe(first.body.id);
  });

  it("returns 409 duplicate_active_consent with existingConsentId when a live consent exists", async () => {
    // Seed a live consent that conflicts on (client, adviceRecord, feeType,
    // accountNumber). The route MUST refuse a fresh request for the same
    // key and surface the offending consent id.
    const acct = `${seedKey}_dup_live`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "100.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        referenceDay: ref,
        renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        renewalStatus: "active",
        clientSignatureName: "Test Client",
      })
      .returning();

    const { status, body } = await postAdviserRequest(
      buildRequestPayload({ accountNumber: acct }),
    );
    expect(status).toBe(409);
    expect(body.kind).toBe("duplicate_active_consent");
    expect(body.existingConsentId).toBe(consent.id);
  });

  it("does NOT consider a different advice record a duplicate (uniqueness is per-advice-record)", async () => {
    const acct = `${seedKey}_scoped_${randomBytes(2).toString("hex")}`;
    const first = await postAdviserRequest(
      buildRequestPayload({ accountNumber: acct, adviceRecordId }),
    );
    expect(first.status).toBe(201);
    // Same key but different advice record — should succeed.
    const second = await postAdviserRequest(
      buildRequestPayload({
        accountNumber: acct,
        adviceRecordId: secondAdviceRecordId,
      }),
    );
    expect(second.status).toBe(201);
    expect(second.body.adviceRecordId).toBe(secondAdviceRecordId);
  });
});

describe("POST /api/admin/fee-consent-requests/:id/revoke", () => {
  it("rejects revoking a non-pending request with 400", async () => {
    // Seed a request that is already in withdrawn_by_adviser state.
    const acct = `${seedKey}_revoked`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    const [row] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "50.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        proposedReferenceDay: ref,
        proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        status: "withdrawn_by_adviser",
      })
      .returning();
    const { status, body } = await postAdminJson(
      `/api/admin/fee-consent-requests/${row.id}/revoke`,
      { reason: "test" },
    );
    expect(status).toBe(400);
    expect(String(body.error || "")).toMatch(/pending/i);
  });

  it("rejects revoke for an admin-generated supersede request (only adviser-issued ones are revocable)", async () => {
    // Simulate the row shape the supersede endpoint creates: a pending
    // request with supersedesRequestId pointing at a prior request id.
    const acct = `${seedKey}_super_revoke_block`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    const [prior] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "50.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        proposedReferenceDay: ref,
        proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        status: "withdrawn_by_adviser",
      })
      .returning();
    const [supersedeRow] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "50.0000",
        accountNumber: `${acct}_v2`,
        deductionFrequency: "monthly",
        proposedReferenceDay: ref,
        proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        status: "pending",
        supersedesRequestId: prior.id,
      })
      .returning();

    const { status, body } = await postAdminJson(
      `/api/admin/fee-consent-requests/${supersedeRow.id}/revoke`,
      { reason: "should be blocked" },
    );
    expect(status).toBe(400);
    expect(String(body.error || "")).toMatch(/supersede|adviser-issued/i);
  });

  it("revokes a pending request, flips status, and stamps revokedByAdmin=true on the audit row", async () => {
    const created = await postAdviserRequest(
      buildRequestPayload({ accountNumber: `${seedKey}_revoke_ok` }),
    );
    expect(created.status).toBe(201);
    const id = created.body.id;
    const { status, body } = await postAdminJson(
      `/api/admin/fee-consent-requests/${id}/revoke`,
      { reason: "compliance review" },
    );
    expect(status).toBe(200);
    expect(body.status).toBe("withdrawn_by_adviser");

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "fee_consent_request"),
          eq(auditLogs.entityId, String(id)),
        ),
      );
    // The audit writer flattens `extra` into the top level of metadata
    // (see writeAuditLog: { before, after, ...extra }). The contract Task
    // #293 cares about is "audit row carries revokedByAdmin=true" — we
    // don't care about the exact nesting.
    const revoked = auditRows.find((r) => {
      const m = r.metadata as Record<string, unknown> | null;
      return m?.revokedByAdmin === true;
    });
    expect(revoked, "expected an audit row with revokedByAdmin=true").toBeTruthy();
  });
});

describe("POST /api/admin/fee-consents/:id/supersede", () => {
  it("atomically marks the consent superseded AND inserts a new pending request linked back via supersedesRequestId", async () => {
    // 1) Adviser-created request, then an executed consent rows are seeded
    //    directly so we can exercise just the supersede path.
    const acct = `${seedKey}_super`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    // The DB enforces "status='consented' iff signedFeeConsentId IS NOT NULL"
    // via a CHECK constraint, so we have to (a) insert the request as
    // pending, (b) insert the consent, then (c) flip both columns in a
    // single UPDATE — the same pattern the client-sign route uses.
    const [origRequest] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "75.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        proposedReferenceDay: ref,
        proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        status: "pending",
      })
      .returning();
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "75.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        referenceDay: ref,
        renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        renewalStatus: "active",
        clientSignatureName: "Test Client",
      })
      .returning();
    await db
      .update(feeConsentRequests)
      .set({ status: "consented", signedFeeConsentId: consent.id })
      .where(eq(feeConsentRequests.id, origRequest.id));

    // 2) Hit the admin Supersede endpoint.
    const { status, body } = await postAdminJson(
      `/api/admin/fee-consents/${consent.id}/supersede`,
      { reason: "client requested change of fee terms" },
    );
    expect(status).toBe(200);
    expect(body.supersededConsent.renewalStatus).toBe("superseded");
    expect(body.supersededConsent.supersededByRequestId).toBe(
      body.newRequest.id,
    );
    expect(body.newRequest.status).toBe("pending");
    expect(body.newRequest.supersedesRequestId).toBe(origRequest.id);
    expect(body.newRequest.adviceRecordId).toBe(adviceRecordId);

    // Re-read via DB to confirm atomicity (both writes landed).
    const [reReadConsent] = await db
      .select()
      .from(feeConsents)
      .where(eq(feeConsents.id, consent.id));
    expect(reReadConsent.renewalStatus).toBe("superseded");
    expect(reReadConsent.supersededAt).toBeTruthy();
    expect(reReadConsent.supersededReason).toBe(
      "client requested change of fee terms",
    );
    const [reReadNew] = await db
      .select()
      .from(feeConsentRequests)
      .where(eq(feeConsentRequests.id, body.newRequest.id));
    expect(reReadNew.status).toBe("pending");
    expect(reReadNew.signedFeeConsentId).toBeNull();
  });

  it("rejects superseding a non-active consent with a 400-shaped error", async () => {
    const acct = `${seedKey}_super_bad`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "advice_fee",
        amountType: "fixed",
        amount: "10.0000",
        accountNumber: acct,
        deductionFrequency: "annually",
        referenceDay: ref,
        renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        renewalStatus: "withdrawn",
        clientSignatureName: "Test Client",
      })
      .returning();
    const { status, body } = await postAdminJson(
      `/api/admin/fee-consents/${consent.id}/supersede`,
      { reason: "should not work" },
    );
    expect(status).toBe(400);
    expect(String(body.error || "")).toMatch(/superseded|withdrawn|status/i);
  });
});

describe("GET /api/admin/fee-consents — Task #293 columns", () => {
  it("returns the supersede chain links, signedIp slot, signature, and deductionsBlockedReason", async () => {
    const acct = `${seedKey}_admin_list`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "200.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        referenceDay: ref,
        renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        renewalStatus: "active",
        clientSignatureName: "Jane Test",
      })
      .returning();
    const { status, body } = await getAdminJson(
      `/api/admin/fee-consents?page=1&limit=200`,
    );
    expect(status).toBe(200);
    const items = (body.items ?? []) as Array<Record<string, unknown>>;
    const found = items.find((r) => r.id === consent.id);
    expect(found, "consent row missing from admin list").toBeTruthy();
    // The shape, not the values, is what we lock here.
    expect(found).toHaveProperty("supersededByRequestId");
    expect(found).toHaveProperty("supersededAt");
    expect(found).toHaveProperty("supersededReason");
    expect(found).toHaveProperty("supersedesRequestId");
    expect(found).toHaveProperty("signedIp");
    expect(found).toHaveProperty("clientSignatureName", "Jane Test");
    expect(found).toHaveProperty("referenceDay");
    expect(found).toHaveProperty("renewalWindowStart");
    expect(found).toHaveProperty("renewalWindowEnd");
    expect(found).toHaveProperty("deductionsBlockedReason");
    // Active + linked + non-expired → null block reason.
    expect(found?.deductionsBlockedReason).toBeNull();
  });

  // Task #372 — the previous tests in this block only used `toHaveProperty`
  // on `supersedesRequestId` and `signedIp`, which silently passed even
  // when the correlated subquery returned `null` for every row (because
  // the inline `${feeConsents.id}` was rendered as the bare column name
  // `"id"` and resolved to `fcr.id` / `al.id` inside the subquery).
  // This test asserts the actual VALUES round-trip for a seeded
  // supersede chain so the bug can never come back unnoticed.
  it("returns the correct cross-table supersedesRequestId and signedIp for a seeded supersede chain", async () => {
    const acct = `${seedKey}_admin_chain`;
    const ref = new Date(Date.now() + 30 * DAY_MS);

    // 1) The prior request — the one that the new (signing) request
    //    should declare it supersedes.
    const [priorRequest] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId,
        clientUserId,
        adviceRecordId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "150.0000",
        accountNumber: `${acct}_prior`,
        deductionFrequency: "monthly",
        proposedReferenceDay: ref,
        proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        status: "withdrawn_by_adviser",
      })
      .returning();

    // 2) The executed consent we'll be reading back via the admin GET.
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "150.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        referenceDay: ref,
        renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
        renewalStatus: "active",
        clientSignatureName: "Chain Test Client",
      })
      .returning();

    // 3) The signing request — it consented and points at the executed
    //    consent via signedFeeConsentId, AND declares the supersede chain
    //    back-pointer. The admin GET reads `supersedesRequestId` by joining
    //    feeConsentRequests on signed_fee_consent_id = feeConsents.id, so
    //    this is the row whose `supersedesRequestId` should round-trip.
    await db.insert(feeConsentRequests).values({
      adviserUserId,
      clientUserId,
      adviceRecordId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "150.0000",
      accountNumber: acct,
      deductionFrequency: "monthly",
      proposedReferenceDay: ref,
      proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
      proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
      proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
      status: "consented",
      signedFeeConsentId: consent.id,
      supersedesRequestId: priorRequest.id,
    });

    // 4) Audit row that simulates the sign-event the live route writes.
    //    The admin GET pulls signedIp from the most recent
    //    fee_consent_created row whose entityId matches the consent id.
    const SIGN_IP = "203.0.113.42";
    await db.insert(auditLogs).values({
      userId: clientUserId,
      action: "fee_consent_created",
      entityType: "fee_consent",
      entityId: String(consent.id),
      metadata: { test: true },
      ipAddress: SIGN_IP,
    });

    const { status, body } = await getAdminJson(
      `/api/admin/fee-consents?page=1&limit=200`,
    );
    expect(status).toBe(200);
    const items = (body.items ?? []) as Array<Record<string, unknown>>;
    const found = items.find((r) => r.id === consent.id);
    expect(found, "seeded consent missing from admin list").toBeTruthy();

    // The whole point of this test: the cross-table back-pointer is the
    // prior request id, NOT null and NOT the consent id. Catches the
    // `${feeConsents.id}` → `"id"` → `fcr.id` Drizzle bug.
    expect(found?.supersedesRequestId).toBe(priorRequest.id);
    // And the audit-log lookup on the SAME outer column resolves the
    // sign-event IP, not null.
    expect(found?.signedIp).toBe(SIGN_IP);
  });

  it("flags expired consents with deductionsBlockedReason='expired'", async () => {
    const acct = `${seedKey}_expired`;
    const past = new Date(Date.now() - 200 * DAY_MS);
    const [consent] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId,
        clientId: clientUserId,
        adviserId: adviserUserId,
        feeType: "ongoing_service_fee",
        amountType: "fixed",
        amount: "10.0000",
        accountNumber: acct,
        deductionFrequency: "monthly",
        referenceDay: past,
        renewalWindowStart: new Date(past.getTime() - 60 * DAY_MS),
        renewalWindowEnd: new Date(past.getTime() + 150 * DAY_MS),
        consentExpiryDate: new Date(past.getTime() + 150 * DAY_MS),
        renewalStatus: "active",
        clientSignatureName: "Past Client",
      })
      .returning();
    const { status, body } = await getAdminJson(
      `/api/admin/fee-consents?page=1&limit=200`,
    );
    expect(status).toBe(200);
    const items = (body.items ?? []) as Array<Record<string, unknown>>;
    const found = items.find((r) => r.id === consent.id);
    expect(found?.deductionsBlockedReason).toBe("expired");
  });
});
