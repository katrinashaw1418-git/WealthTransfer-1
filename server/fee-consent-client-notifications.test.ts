// =============================================================================
// Task #301 — client notification on fee-consent request creation / supersede
// =============================================================================
// Locks the contract:
//
//   1. POST /api/adviser/fee-consent-requests success
//        - calls sendFeeConsentRequestEmail with the new request id, the
//          client's email + first name, the adviser's display name, and
//          trigger='new_request'.
//        - writes ONE audit_logs row keyed to the new request id with
//          action `fee_consent_request.client_notified` (success) or
//          `_client_notification_failed` (any failure mode), carrying
//          the deep-link, recipient email, trigger, and feeType in
//          metadata so the audit trail proves WHAT the client was told.
//
//   2. POST /api/admin/fee-consents/:id/supersede success
//        - same call, but with trigger='supersede' so the renderer can
//          pick the replacement-consent subject + lead paragraph.
//        - audit row is keyed to the NEW request id (the freshly
//          inserted pending row), not the superseded consent.
//
//   3. Failure modes
//        - SMTP failure → `_client_notification_failed` audit row with
//          metadata.error carrying the SMTP error string.
//        - Client has no email → `_client_notification_failed` audit row
//          with metadata.error="client has no email address on file".
//        - The 2xx response from the route is NEVER affected by a
//          notification failure (caller has already created the row).
//
// Email is fully mocked at module scope so this file never sends real
// SMTP traffic — even in environments where GMAIL_USER / GMAIL_APP_PASSWORD
// are set in the dev shell.
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
  process.env.JWT_SECRET ||= "fee-consents-task-301-test-secret";
});

// IMPORTANT: vi.mock is hoisted by vitest to the top of the file, so this
// stub replaces the real `./email` module BEFORE the route files import it.
// The mock factory returns a fresh `vi.fn()` we can re-program per test.
vi.mock("./email", () => ({
  // sendFeeConsentRequestEmail is the only export the helper consumes.
  // Default implementation: pretend SMTP is configured and the send
  // succeeded. Tests override per-case via mockResolvedValueOnce /
  // mockRejectedValueOnce as needed.
  sendFeeConsentRequestEmail: vi.fn(async (args: any) => ({
    sent: true,
    signLink: `/client/fee-consents?request=${args.requestId}`,
  })),
  // Other exports stubbed out so unrelated imports don't fall over if the
  // route files happen to pull them in transitively.
  emailConfigured: true,
  sendVerificationEmail: vi.fn(async () => ({ sent: true })),
  sendInviteEmail: vi.fn(async () => ({ sent: true })),
  sendInsufficientFundsEmail: vi.fn(async () => ({ sent: true })),
  sendReportReadyEmail: vi.fn(async () => ({ sent: true })),
  sendReportFailedEmail: vi.fn(async () => ({ sent: true })),
  sendReportExpiringSoonEmail: vi.fn(async () => ({ sent: true })),
}));

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";

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
import { sendFeeConsentRequestEmail } from "./email";

const sendFeeConsentRequestEmailMock = vi.mocked(sendFeeConsentRequestEmail);

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

let adminToken: string;
let adviserToken: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  seedKey = `t301_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  registerAdviserRoutes(app);

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

  const [adviserRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_adv`,
      email: `${seedKey}_adv@test.invalid`,
      password: "x",
      firstName: "Eve",
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
      firstName: "Pat",
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

  adminToken = signToken({
    userId: adminUserId,
    username: adminRow.username,
    email: adminRow.email!,
    role: "admin",
  });
  adviserToken = signToken({
    userId: adviserUserId,
    username: adviserRow.username,
    email: adviserRow.email!,
    role: "adviser",
  });
});

afterAll(async () => {
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  await db.delete(adviceRecords).where(eq(adviceRecords.adviserId, adviserUserId));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  // Wipe rows AND reset the email mock state between tests so each test
  // starts from a clean ledger of mock-call records.
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  sendFeeConsentRequestEmailMock.mockReset();
  // Default: succeed. Per-test overrides come below.
  sendFeeConsentRequestEmailMock.mockImplementation(async (args: any) => ({
    sent: true,
    signLink: `/client/fee-consents?request=${args.requestId}`,
  }));
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function buildRequestPayload(overrides: Record<string, any> = {}) {
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

async function postAdviserRequest(body: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/adviser/fee-consent-requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adviserToken}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postAdminSupersede(
  consentId: number,
  reason: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${baseUrl}/api/admin/fee-consents/${consentId}/supersede`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ reason }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function findNotificationAuditRow(requestId: number) {
  // Use desc() to grab the most recent row in case a re-run leaves
  // historical rows behind (audit_logs is append-only).
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "fee_consent_request"),
        eq(auditLogs.entityId, String(requestId)),
        sql`${auditLogs.action} IN ('fee_consent_request.client_notified', 'fee_consent_request.client_notification_failed')`,
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(1);
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// Tests — POST /api/adviser/fee-consent-requests
// -----------------------------------------------------------------------------
describe("POST /api/adviser/fee-consent-requests — Task #301 client notification", () => {
  it("calls sendFeeConsentRequestEmail with the new request id, client email, adviser name, and trigger='new_request'", async () => {
    const { status, body } = await postAdviserRequest(buildRequestPayload());
    expect(status).toBe(201);

    expect(sendFeeConsentRequestEmailMock).toHaveBeenCalledTimes(1);
    const call = sendFeeConsentRequestEmailMock.mock.calls[0][0] as any;
    expect(call.to).toBe(`${seedKey}_cli@test.invalid`);
    expect(call.firstName).toBe("Pat");
    expect(call.requestId).toBe(body.id);
    expect(call.feeType).toBe("ongoing_service_fee");
    expect(call.trigger).toBe("new_request");
    // Adviser display name is rendered "First Last" (trimmed).
    expect(call.adviserName).toBe("Eve Adviser");
  });

  it("writes a `client_notified` audit row carrying signLink + trigger + recipientEmail when SMTP succeeds", async () => {
    const { status, body } = await postAdviserRequest(buildRequestPayload());
    expect(status).toBe(201);

    const row = await findNotificationAuditRow(body.id);
    expect(row, "audit row for new request missing").toBeTruthy();
    expect(row!.action).toBe("fee_consent_request.client_notified");
    expect(row!.userId).toBe(adviserUserId);
    expect(row!.entityType).toBe("fee_consent_request");
    expect(row!.entityId).toBe(String(body.id));

    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.trigger).toBe("new_request");
    expect(meta.signLink).toBe(`/client/fee-consents?request=${body.id}`);
    expect(meta.recipientEmail).toBe(`${seedKey}_cli@test.invalid`);
    expect(meta.clientUserId).toBe(clientUserId);
    expect(meta.adviserUserId).toBe(adviserUserId);
    expect(meta.feeType).toBe("ongoing_service_fee");
    // Success path must NOT carry an error key.
    expect(meta.error).toBeUndefined();
  });

  it("writes a `client_notification_failed` audit row carrying the SMTP error when send returns sent=false", async () => {
    sendFeeConsentRequestEmailMock.mockImplementationOnce(async (args: any) => ({
      sent: false,
      error: "mock SMTP outage",
      signLink: `/client/fee-consents?request=${args.requestId}`,
    }));

    const { status, body } = await postAdviserRequest(buildRequestPayload());
    // The route still 2xxs — notification failure must NEVER fail the row.
    expect(status).toBe(201);

    const row = await findNotificationAuditRow(body.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("fee_consent_request.client_notification_failed");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.error).toBe("mock SMTP outage");
    expect(meta.signLink).toBe(`/client/fee-consents?request=${body.id}`);
  });

  it("does NOT roll back the inserted request when the email helper throws unexpectedly", async () => {
    sendFeeConsentRequestEmailMock.mockImplementationOnce(async () => {
      throw new Error("boom — renderer crashed");
    });

    const { status, body } = await postAdviserRequest(buildRequestPayload());
    expect(status).toBe(201);
    expect(body.id).toBeTruthy();

    // Row must still exist in DB.
    const [persisted] = await db
      .select()
      .from(feeConsentRequests)
      .where(eq(feeConsentRequests.id, body.id));
    expect(persisted, "request row was rolled back by notification failure").toBeTruthy();

    // And the audit row records the throw.
    const row = await findNotificationAuditRow(body.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("fee_consent_request.client_notification_failed");
    const meta = row!.metadata as Record<string, unknown>;
    expect(String(meta.error)).toMatch(/boom — renderer crashed/);
  });
});

// -----------------------------------------------------------------------------
// Tests — POST /api/admin/fee-consents/:id/supersede
// -----------------------------------------------------------------------------
describe("POST /api/admin/fee-consents/:id/supersede — Task #301 client notification", () => {
  it("notifies the client with trigger='supersede' and writes an audit row keyed to the NEW request id", async () => {
    // Seed a live consent so admin Supersede can flip it.
    const acct = `${seedKey}_super_${randomBytes(2).toString("hex")}`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
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
        clientSignatureName: "Pat Client",
      })
      .returning();

    const { status, body } = await postAdminSupersede(
      consent.id,
      "client requested change of fee terms",
    );
    expect(status).toBe(200);
    const newRequestId = body.newRequest.id as number;

    // Sender called with trigger='supersede' and the NEW request id.
    expect(sendFeeConsentRequestEmailMock).toHaveBeenCalledTimes(1);
    const call = sendFeeConsentRequestEmailMock.mock.calls[0][0] as any;
    expect(call.requestId).toBe(newRequestId);
    expect(call.trigger).toBe("supersede");
    expect(call.to).toBe(`${seedKey}_cli@test.invalid`);
    expect(call.feeType).toBe("ongoing_service_fee");

    // Audit row keyed to the NEW request id (NOT the superseded consent).
    const row = await findNotificationAuditRow(newRequestId);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("fee_consent_request.client_notified");
    expect(row!.userId).toBe(adminUserId);
    expect(row!.entityId).toBe(String(newRequestId));
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.trigger).toBe("supersede");
    expect(meta.signLink).toBe(`/client/fee-consents?request=${newRequestId}`);
    expect(meta.recipientEmail).toBe(`${seedKey}_cli@test.invalid`);
  });

  it("records `client_notification_failed` (and 200s) when the SMTP send fails on the supersede path", async () => {
    sendFeeConsentRequestEmailMock.mockImplementationOnce(async (args: any) => ({
      sent: false,
      error: "supersede mock SMTP outage",
      signLink: `/client/fee-consents?request=${args.requestId}`,
    }));

    const acct = `${seedKey}_super_fail_${randomBytes(2).toString("hex")}`;
    const ref = new Date(Date.now() + 30 * DAY_MS);
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
        clientSignatureName: "Pat Client",
      })
      .returning();

    const { status, body } = await postAdminSupersede(consent.id, "fail path");
    expect(status).toBe(200);

    const row = await findNotificationAuditRow(body.newRequest.id);
    expect(row).toBeTruthy();
    expect(row!.action).toBe("fee_consent_request.client_notification_failed");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.error).toBe("supersede mock SMTP outage");
    expect(meta.trigger).toBe("supersede");
  });
});
