// =============================================================================
// Task #342 — invariants for the CLIENT-facing fee-consent surface
// =============================================================================
// Task #300 extended `GET /api/client/fee-consent-requests` and
// `GET /api/client/fee-consents` to mirror the admin projection so the
// client UI can render the supersede chain and the inline "deductions
// blocked" reason. The admin shape is locked by `server/fee-consents.test.ts`;
// this file locks the equivalent CLIENT shape so a future contributor can't
// quietly drop:
//   - `supersedesRequestId` from the requests endpoint,
//   - `supersededByRequestId` / `supersededAt` / `supersededReason`
//     / cross-table `supersedesRequestId` / `clientSignatureName` from the
//     consents endpoint, or
//   - the server-computed `deductionsBlockedReason` mapping.
//
// We also lock the ownership boundary: a different client must NOT see
// the first client's rows.
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
  process.env.JWT_SECRET ||= "client-fee-consents-task-342-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { signToken } from "./auth";
import { registerClientRoutes } from "./client-routes";
import { db } from "./db";
import {
  users,
  adviserClients,
  adviceRecords,
  feeConsents,
  feeConsentRequests,
} from "@shared/schema";

// -----------------------------------------------------------------------------
// Test runtime + fixtures
// -----------------------------------------------------------------------------
let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let clientUserId: number;
let otherClientUserId: number;
let adviceRecordId: number;

let clientToken: string;
let otherClientToken: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  seedKey = `t342_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerClientRoutes(app);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

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

  const [otherClientRow] = await db
    .insert(users)
    .values({
      username: `${seedKey}_cli2`,
      email: `${seedKey}_cli2@test.invalid`,
      password: "x",
      firstName: "Other",
      lastName: "Client",
      role: "client",
    })
    .returning();
  otherClientUserId = otherClientRow.id;

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    relationshipType: "servicing",
    isActive: true,
  });
  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId: otherClientUserId,
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

  clientToken = signToken({
    userId: clientUserId,
    username: clientRow.username,
    email: clientRow.email,
    role: "client",
  });
  otherClientToken = signToken({
    userId: otherClientUserId,
    username: otherClientRow.username,
    email: otherClientRow.email,
    role: "client",
  });
});

afterAll(async () => {
  // Clean up the consent/request rows. We deliberately leave the seeded
  // users (and any audit-log rows referencing them) behind because
  // audit_logs.user_id has an FK back to users(id) and audit_logs is
  // INSERT-ONLY at the DB layer.
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  await db
    .delete(feeConsents)
    .where(eq(feeConsents.clientId, otherClientUserId));
  await db.delete(adviceRecords).where(eq(adviceRecords.clientId, clientUserId));
  await db
    .delete(adviserClients)
    .where(eq(adviserClients.adviserUserId, adviserUserId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  // Each test starts with a clean slate of consent/request rows so the
  // ordering/filtering assertions are deterministic. Users + advice
  // records survive across tests.
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
  await db
    .delete(feeConsents)
    .where(eq(feeConsents.clientId, otherClientUserId));
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------
type RequestOverrides = Partial<{
  status: string;
  adviceRecordId: number | null;
  accountNumber: string;
  proposedConsentExpiryDate: Date;
  proposedReferenceDay: Date;
  proposedRenewalWindowStart: Date;
  proposedRenewalWindowEnd: Date;
  supersedesRequestId: number | null;
  signedFeeConsentId: number | null;
  clientUserId: number;
}>;

async function insertRequest(overrides: RequestOverrides = {}) {
  const ref = overrides.proposedReferenceDay ?? new Date(Date.now() + 30 * DAY_MS);
  const [row] = await db
    .insert(feeConsentRequests)
    .values({
      adviserUserId,
      clientUserId: overrides.clientUserId ?? clientUserId,
      adviceRecordId:
        overrides.adviceRecordId === undefined
          ? adviceRecordId
          : overrides.adviceRecordId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "100.0000",
      accountNumber:
        overrides.accountNumber ??
        `${seedKey}_req_${randomBytes(2).toString("hex")}`,
      deductionFrequency: "monthly",
      proposedReferenceDay: ref,
      proposedRenewalWindowStart:
        overrides.proposedRenewalWindowStart ??
        new Date(ref.getTime() - 60 * DAY_MS),
      proposedRenewalWindowEnd:
        overrides.proposedRenewalWindowEnd ??
        new Date(ref.getTime() + 150 * DAY_MS),
      proposedConsentExpiryDate:
        overrides.proposedConsentExpiryDate ??
        new Date(ref.getTime() + 150 * DAY_MS),
      status: overrides.status ?? "pending",
      supersedesRequestId: overrides.supersedesRequestId ?? null,
      signedFeeConsentId: overrides.signedFeeConsentId ?? null,
    })
    .returning();
  return row;
}

type ConsentOverrides = Partial<{
  accountNumber: string;
  renewalStatus: string;
  consentExpiryDate: Date;
  referenceDay: Date;
  renewalWindowStart: Date;
  renewalWindowEnd: Date;
  supersededByRequestId: number | null;
  supersededAt: Date | null;
  supersededReason: string | null;
  clientSignatureName: string;
  clientId: number;
}>;

async function insertConsent(overrides: ConsentOverrides = {}) {
  const ref = overrides.referenceDay ?? new Date(Date.now() + 30 * DAY_MS);
  const [row] = await db
    .insert(feeConsents)
    .values({
      adviceRecordId,
      clientId: overrides.clientId ?? clientUserId,
      adviserId: adviserUserId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "100.0000",
      accountNumber:
        overrides.accountNumber ??
        `${seedKey}_cons_${randomBytes(2).toString("hex")}`,
      deductionFrequency: "monthly",
      referenceDay: ref,
      renewalWindowStart:
        overrides.renewalWindowStart ?? new Date(ref.getTime() - 60 * DAY_MS),
      renewalWindowEnd:
        overrides.renewalWindowEnd ?? new Date(ref.getTime() + 150 * DAY_MS),
      consentExpiryDate:
        overrides.consentExpiryDate ?? new Date(ref.getTime() + 150 * DAY_MS),
      renewalStatus: overrides.renewalStatus ?? "active",
      clientSignatureName: overrides.clientSignatureName ?? "Test Client",
      supersededByRequestId: overrides.supersededByRequestId ?? null,
      supersededAt: overrides.supersededAt ?? null,
      supersededReason: overrides.supersededReason ?? null,
    })
    .returning();
  return row;
}

type JsonResponse<T> = { status: number; body: T };

async function getAsClient<T = unknown>(
  path: string,
  token = clientToken,
): Promise<JsonResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, body: json };
}

// -----------------------------------------------------------------------------
// Tests — GET /api/client/fee-consent-requests
// -----------------------------------------------------------------------------
describe("GET /api/client/fee-consent-requests — Task #342 client projection", () => {
  it("returns rows that include supersedesRequestId and the right deductionsBlockedReason mapping", async () => {
    // 1) "pending" reason — pending request with an advice record attached.
    const pendingReq = await insertRequest({
      accountNumber: `${seedKey}_pending_acct`,
      status: "pending",
    });

    // 2) "expired" reason — non-pending request whose proposedConsentExpiryDate
    //    is in the past. The DB CHECK constraint requires status='consented'
    //    iff signedFeeConsentId IS NOT NULL, so we have to back this with a
    //    real feeConsents row.
    const past = new Date(Date.now() - 200 * DAY_MS);
    const expiredConsent = await insertConsent({
      accountNumber: `${seedKey}_expired_req_acct`,
      referenceDay: past,
      renewalWindowStart: new Date(past.getTime() - 60 * DAY_MS),
      renewalWindowEnd: new Date(past.getTime() + 150 * DAY_MS),
      consentExpiryDate: new Date(past.getTime() + 150 * DAY_MS),
      renewalStatus: "expired",
    });
    const expiredReq = await insertRequest({
      accountNumber: `${seedKey}_expired_req_acct`,
      status: "consented",
      proposedReferenceDay: past,
      proposedRenewalWindowStart: new Date(past.getTime() - 60 * DAY_MS),
      proposedRenewalWindowEnd: new Date(past.getTime() + 150 * DAY_MS),
      proposedConsentExpiryDate: new Date(past.getTime() + 150 * DAY_MS),
      signedFeeConsentId: expiredConsent.id,
    });

    // 3) "no_advice_record" reason — request without an advice record.
    //    The partial unique index on (client, adviceRecord, feeType, account)
    //    only fires when adviceRecordId IS NOT NULL, so a null-advice-record
    //    pending request can coexist with the others.
    const noAdviceReq = await insertRequest({
      accountNumber: `${seedKey}_no_advice_acct`,
      adviceRecordId: null,
      status: "pending",
    });

    // 4) null reason — pending->consented, future expiry, advice record set.
    const okConsent = await insertConsent({
      accountNumber: `${seedKey}_ok_req_acct`,
      renewalStatus: "active",
    });
    const supersededRequest = await insertRequest({
      accountNumber: `${seedKey}_prior_acct`,
      status: "withdrawn_by_adviser",
    });
    const okReq = await insertRequest({
      accountNumber: `${seedKey}_ok_req_acct`,
      status: "consented",
      signedFeeConsentId: okConsent.id,
      // Use the supersede back-pointer so we can assert it round-trips.
      supersedesRequestId: supersededRequest.id,
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consent-requests",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const byId = new Map(body.map((r) => [r.id as number, r]));
    const pendingRow = byId.get(pendingReq.id);
    const expiredRow = byId.get(expiredReq.id);
    const noAdviceRow = byId.get(noAdviceReq.id);
    const okRow = byId.get(okReq.id);

    expect(pendingRow, "pending request missing from response").toBeTruthy();
    expect(expiredRow, "expired request missing from response").toBeTruthy();
    expect(noAdviceRow, "no-advice-record request missing").toBeTruthy();
    expect(okRow, "active consented request missing").toBeTruthy();

    // The shape — every row must carry the supersede back-pointer column,
    // even when it is null. A future contributor dropping it from the
    // SELECT will trip these `toHaveProperty` checks.
    for (const row of [pendingRow, expiredRow, noAdviceRow, okRow]) {
      expect(row).toHaveProperty("supersedesRequestId");
      expect(row).toHaveProperty("deductionsBlockedReason");
    }

    // The values — the server-computed reason must match the documented
    // priority: no_advice_record > pending > expired > null.
    expect(pendingRow?.deductionsBlockedReason).toBe("pending");
    expect(expiredRow?.deductionsBlockedReason).toBe("expired");
    expect(noAdviceRow?.deductionsBlockedReason).toBe("no_advice_record");
    expect(okRow?.deductionsBlockedReason).toBeNull();

    // The supersede back-pointer round-trips.
    expect(okRow?.supersedesRequestId).toBe(supersededRequest.id);
    expect(pendingRow?.supersedesRequestId).toBeNull();
  });

  it("does not leak another client's requests (ownership boundary)", async () => {
    // Seed a request that belongs to OTHER client.
    const theirs = await insertRequest({
      clientUserId: otherClientUserId,
      accountNumber: `${seedKey}_theirs_req`,
      adviceRecordId: null, // avoid the per-advice-record unique index
      status: "pending",
    });
    // And one that belongs to OUR client, for the negative control.
    const mine = await insertRequest({
      accountNumber: `${seedKey}_mine_req`,
      status: "pending",
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consent-requests",
    );
    expect(status).toBe(200);
    const ids = body.map((r) => r.id as number);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });
});

// -----------------------------------------------------------------------------
// Tests — GET /api/client/fee-consents
// -----------------------------------------------------------------------------
describe("GET /api/client/fee-consents — Task #342 client projection", () => {
  it("returns the supersede chain (both directions), signature, and a null deductionsBlockedReason for an active consent", async () => {
    // The "live" consent. The cross-table supersedesRequestId is read by
    // joining feeConsentRequests on signed_fee_consent_id; create that
    // signing request explicitly so we can assert the join lands a value.
    const acct = `${seedKey}_live_consent`;
    const consent = await insertConsent({
      accountNumber: acct,
      renewalStatus: "active",
      clientSignatureName: "Jane Test",
    });
    const priorRequest = await insertRequest({
      accountNumber: `${acct}_prior`,
      status: "withdrawn_by_adviser",
    });
    const signingRequest = await insertRequest({
      accountNumber: acct,
      status: "consented",
      signedFeeConsentId: consent.id,
      supersedesRequestId: priorRequest.id,
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consents",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((r) => r.id === consent.id);
    expect(found, "live consent missing from response").toBeTruthy();

    // Forward chain (set on feeConsents directly) — null on a live consent
    // but the columns must still be present on the projection.
    expect(found).toHaveProperty("supersededByRequestId");
    expect(found).toHaveProperty("supersededAt");
    expect(found).toHaveProperty("supersededReason");
    expect(found?.supersededByRequestId).toBeNull();
    expect(found?.supersededAt).toBeNull();
    expect(found?.supersededReason).toBeNull();

    // Cross-table back pointer — joined from the request that signed this
    // consent. Confirms the SQL subselect in the route is intact.
    expect(found).toHaveProperty("supersedesRequestId");
    expect(found?.supersedesRequestId).toBe(priorRequest.id);

    // Identity / shape columns the client UI depends on.
    expect(found).toHaveProperty("clientSignatureName", "Jane Test");
    expect(found).toHaveProperty("renewalStatus", "active");
    expect(found).toHaveProperty("referenceDay");
    expect(found).toHaveProperty("renewalWindowStart");
    expect(found).toHaveProperty("renewalWindowEnd");
    expect(found).toHaveProperty("consentExpiryDate");

    // Active + linked + non-expired => null block reason.
    expect(found).toHaveProperty("deductionsBlockedReason");
    expect(found?.deductionsBlockedReason).toBeNull();

    // Signing request is irrelevant to this assertion but referenced so
    // the variable doesn't read as dead code in future edits.
    expect(signingRequest.signedFeeConsentId).toBe(consent.id);
  });

  it("flips deductionsBlockedReason to 'expired' when renewalStatus='expired' (even if expiry date is still in the future)", async () => {
    // Future expiry date, but renewalStatus has been flipped to 'expired'
    // (e.g. by a renewal job). The server must trust the explicit status,
    // not the date.
    const consent = await insertConsent({
      accountNumber: `${seedKey}_status_expired`,
      renewalStatus: "expired",
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consents",
    );
    expect(status).toBe(200);
    const found = body.find((r) => r.id === consent.id);
    expect(found?.deductionsBlockedReason).toBe("expired");
  });

  it("flips deductionsBlockedReason to 'expired' when consentExpiryDate is in the past", async () => {
    // Date-driven branch of the same reason — an "active" row whose
    // expiry date has slipped into the past must still be flagged.
    const past = new Date(Date.now() - 200 * DAY_MS);
    const consent = await insertConsent({
      accountNumber: `${seedKey}_date_expired`,
      renewalStatus: "active",
      referenceDay: past,
      renewalWindowStart: new Date(past.getTime() - 60 * DAY_MS),
      renewalWindowEnd: new Date(past.getTime() + 150 * DAY_MS),
      consentExpiryDate: new Date(past.getTime() + 150 * DAY_MS),
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consents",
    );
    expect(status).toBe(200);
    const found = body.find((r) => r.id === consent.id);
    expect(found?.deductionsBlockedReason).toBe("expired");
  });

  it("does not leak another client's consents (ownership boundary)", async () => {
    const theirs = await insertConsent({
      clientId: otherClientUserId,
      accountNumber: `${seedKey}_theirs_cons`,
      clientSignatureName: "Other Client",
    });
    const mine = await insertConsent({
      accountNumber: `${seedKey}_mine_cons`,
      clientSignatureName: "My Client",
    });

    const { status, body } = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consents",
    );
    expect(status).toBe(200);
    const ids = body.map((r) => r.id as number);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    // And the converse — the other client signed in MUST see only their row.
    const other = await getAsClient<Array<Record<string, unknown>>>(
      "/api/client/fee-consents",
      otherClientToken,
    );
    expect(other.status).toBe(200);
    const otherIds = other.body.map((r) => r.id as number);
    expect(otherIds).toContain(theirs.id);
    expect(otherIds).not.toContain(mine.id);
  });
});
