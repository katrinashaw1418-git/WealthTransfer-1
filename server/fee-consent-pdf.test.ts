// =============================================================================
// Task #353 — regression coverage for the AMAX consent PDF renderer.
// =============================================================================
// What this file locks down:
//
//   1. GET /api/admin/fee-consent-requests/:id/pdf
//        - HTTP 200, content-type application/pdf, %PDF- magic bytes,
//          page count within the expected band (≤ 4 for a fresh signed
//          consent), and the captured signature name + IP appear in the
//          rendered text. A footer that drifts past the bottom margin
//          would push the body to a second page each cycle and trip the
//          page-count cap.
//        - The audit row `fee_consent_request_pdf_exported` is written
//          exactly ONCE per download — not zero (silent download, no
//          paper trail) and not twice (an extra writeAuditLog call hidden
//          in a refactor would turn a single download into two compliance
//          events).
//
//   2. GET /api/admin/fee-consents/:id/pdf
//        - Same shape as (1), but for the executed consent endpoint, with
//          its own `fee_consent_pdf_exported` audit invariant.
//
//   3. buildConsentSupersedeChain — unit test against a hand-built
//      FCR-1 → FC-1 → FCR-2 → FC-2 fixture. Asserts:
//        - chain entries are in chronological order regardless of which
//          end of the chain you call into,
//        - every artefact is deduped (the DFS-with-memo cannot revisit an
//          id), and
//        - both the request and consent walks return the same set of
//          nodes (i.e. forward + backward traversals agree).
//
// Fixture isolation mirrors server/fee-consents.test.ts: every row this
// file inserts carries a per-run `seedKey` so re-running cannot collide
// with leftovers from an earlier failed run.
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
  process.env.JWT_SECRET ||= "fee-consent-pdf-task-353-test-secret";
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { signToken } from "./auth";
import {
  registerAdminRoutes,
  buildConsentSupersedeChain,
} from "./admin-routes";
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

let adminToken: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  seedKey = `t353_${randomBytes(4).toString("hex")}`;

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
    email: adminRow.email,
    role: "admin",
  });
});

afterAll(async () => {
  // Same rule as fee-consents.test.ts: audit_logs is INSERT-ONLY at the DB
  // layer and references users(id), so we leave the seed users + their
  // audit rows behind. The seedKey scopes everything to this run.
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
  await db
    .delete(feeConsentRequests)
    .where(eq(feeConsentRequests.adviserUserId, adviserUserId));
  await db.delete(feeConsents).where(eq(feeConsents.clientId, clientUserId));
});

// -----------------------------------------------------------------------------
// Fixture builders
// -----------------------------------------------------------------------------
type SignedConsentSeed = {
  request: { id: number };
  consent: { id: number };
  signatureName: string;
  signedIp: string;
};

// Insert a request → consent pair the way the live sign path does:
// (a) request inserted as 'pending', (b) consent inserted, (c) request
// flipped to 'consented' with signedFeeConsentId in a single UPDATE so the
// "status='consented' iff signedFeeConsentId IS NOT NULL" CHECK constraint
// holds. Also writes a `fee_consent_created` audit row carrying the IP, so
// the request-PDF route can resolve `signature.ipAddress`.
async function seedSignedConsent(opts: {
  accountNumber: string;
  signatureName: string;
  signedIp: string;
  supersedesRequestId?: number | null;
  // Optional offset (ms) to push createdAt/consentedAt earlier so the chain
  // test sees a real chronological ordering instead of two same-millisecond
  // ties resolved by the FCR/FC tie-breaker only.
  ageMs?: number;
}): Promise<SignedConsentSeed> {
  const ref = new Date(Date.now() + 30 * DAY_MS);
  const stamp = new Date(Date.now() - (opts.ageMs ?? 0));

  const [request] = await db
    .insert(feeConsentRequests)
    .values({
      adviserUserId,
      clientUserId,
      adviceRecordId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "150.0000",
      accountNumber: opts.accountNumber,
      accountName: "Test Account",
      deductionFrequency: "monthly",
      proposedReferenceDay: ref,
      proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
      proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
      proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
      status: "pending",
      supersedesRequestId: opts.supersedesRequestId ?? null,
      createdAt: stamp,
      updatedAt: stamp,
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
      amount: "150.0000",
      accountNumber: opts.accountNumber,
      accountName: "Test Account",
      deductionFrequency: "monthly",
      referenceDay: ref,
      renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
      renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
      consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
      renewalStatus: "active",
      clientSignatureName: opts.signatureName,
      consentedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning();

  await db
    .update(feeConsentRequests)
    .set({ status: "consented", signedFeeConsentId: consent.id })
    .where(eq(feeConsentRequests.id, request.id));

  await db.insert(auditLogs).values({
    userId: clientUserId,
    action: "fee_consent_created",
    entityType: "fee_consent",
    entityId: String(consent.id),
    metadata: { signatureName: opts.signatureName },
    ipAddress: opts.signedIp,
  });

  return {
    request: { id: request.id },
    consent: { id: consent.id },
    signatureName: opts.signatureName,
    signedIp: opts.signedIp,
  };
}

// Mark a previously-signed consent as superseded by a fresh pending request
// — the same atomic write pair the admin Supersede endpoint produces. We
// use this to build the FCR-1 → FC-1 → FCR-2 → FC-2 fixture for the chain
// test (FCR-2 is then turned into a signed consent FC-2 in a follow-up
// `seedSignedConsent` call).
async function seedSupersedeRequest(opts: {
  oldConsentId: number;
  oldRequestId: number;
  newAccountNumber: string;
  ageMs?: number;
}): Promise<{ newRequestId: number }> {
  const ref = new Date(Date.now() + 30 * DAY_MS);
  const stamp = new Date(Date.now() - (opts.ageMs ?? 0));

  const [newReq] = await db
    .insert(feeConsentRequests)
    .values({
      adviserUserId,
      clientUserId,
      adviceRecordId,
      feeType: "ongoing_service_fee",
      amountType: "fixed",
      amount: "150.0000",
      accountNumber: opts.newAccountNumber,
      accountName: "Test Account v2",
      deductionFrequency: "monthly",
      proposedReferenceDay: ref,
      proposedRenewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
      proposedRenewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
      proposedConsentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
      status: "pending",
      supersedesRequestId: opts.oldRequestId,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning();

  await db
    .update(feeConsents)
    .set({
      renewalStatus: "superseded",
      supersededByRequestId: newReq.id,
      supersededAt: stamp,
      supersededReason: "test fixture supersede",
    })
    .where(eq(feeConsents.id, opts.oldConsentId));

  return { newRequestId: newReq.id };
}

// -----------------------------------------------------------------------------
// PDF text extraction (best-effort, just enough to assert the signature
// name + IP made it into the rendered document).
//
// pdfkit emits text via the `TJ` operator with hex-encoded literal strings:
//   [<48656c6c6f> 50 <2057 6f72 6c64> 0] TJ
// Standard Helvetica/Helvetica-Bold are Type1 fonts with WinAnsi encoding,
// so each hex byte decodes to the original ASCII character — no glyph-id
// remapping needed. We:
//   1. load the PDF with pdf-lib,
//   2. enumerate every PDFRawStream and decode it (pulls FlateDecode
//      apart for us),
//   3. concatenate all `<...>` hex literals, decoded to bytes.
// The result is whitespace-stripped and ordering is approximate, so we
// only use it for substring matching — never for layout assertions.
// -----------------------------------------------------------------------------
async function extractPdfText(pdfBuf: Buffer): Promise<string> {
  const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  let raw = "";
  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        const decoded = decodePDFRawStream(obj).decode();
        raw += Buffer.from(decoded).toString("latin1") + "\n";
      } catch {
        // some streams (e.g. images) won't decode — ignore.
      }
    }
  }
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const hex = m[1].replace(/\s+/g, "");
    if (hex.length === 0 || hex.length % 2 !== 0) continue;
    let s = "";
    for (let i = 0; i < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    out += s;
  }
  return out;
}

async function getPdf(path: string): Promise<{
  status: number;
  contentType: string | null;
  buffer: Buffer;
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const ab = await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    buffer: Buffer.from(ab),
  };
}

async function countAuditEvents(opts: {
  action: string;
  entityType: string;
  entityId: string;
}): Promise<number> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, opts.action),
        eq(auditLogs.entityType, opts.entityType),
        eq(auditLogs.entityId, opts.entityId),
      ),
    );
  return rows.length;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe("GET /api/admin/fee-consent-requests/:id/pdf — Task #353", () => {
  it(
    "renders a valid PDF, stays within the page-count band, exposes the signature, and audits exactly once",
    async () => {
      const sigName = `Signer-${seedKey}-Req`;
      const signedIp = "203.0.113.42";
      const seed = await seedSignedConsent({
        accountNumber: `${seedKey}_req_pdf`,
        signatureName: sigName,
        signedIp,
      });

      const before = await countAuditEvents({
        action: "fee_consent_request_pdf_exported",
        entityType: "fee_consent_request",
        entityId: String(seed.request.id),
      });

      const { status, contentType, buffer } = await getPdf(
        `/api/admin/fee-consent-requests/${seed.request.id}/pdf`,
      );

      expect(status).toBe(200);
      expect(contentType).toMatch(/^application\/pdf/);

      // Magic bytes: every PDF starts with "%PDF-".
      expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();
      // Title block + audit appendix on its own page = 2; allow a little
      // headroom for natural overflow but trip loudly if the renderer
      // starts ballooning to dozens of pages because the footer escaped
      // the bottom margin.
      expect(pageCount).toBeGreaterThanOrEqual(1);
      expect(pageCount).toBeLessThanOrEqual(4);

      const text = await extractPdfText(buffer);
      expect(text).toContain(sigName);
      expect(text).toContain(signedIp);

      const after = await countAuditEvents({
        action: "fee_consent_request_pdf_exported",
        entityType: "fee_consent_request",
        entityId: String(seed.request.id),
      });
      expect(after - before).toBe(1);
    },
  );

  it("404s on an unknown request id without writing an audit row", async () => {
    const before = await countAuditEvents({
      action: "fee_consent_request_pdf_exported",
      entityType: "fee_consent_request",
      entityId: "999999999",
    });
    const { status } = await getPdf(
      `/api/admin/fee-consent-requests/999999999/pdf`,
    );
    expect(status).toBe(404);
    const after = await countAuditEvents({
      action: "fee_consent_request_pdf_exported",
      entityType: "fee_consent_request",
      entityId: "999999999",
    });
    expect(after).toBe(before);
  });
});

describe("GET /api/admin/fee-consents/:id/pdf — Task #353", () => {
  it(
    "renders a valid PDF, stays within the page-count band, exposes the signature, and audits exactly once",
    async () => {
      const sigName = `Signer-${seedKey}-Con`;
      const signedIp = "198.51.100.7";
      const seed = await seedSignedConsent({
        accountNumber: `${seedKey}_consent_pdf`,
        signatureName: sigName,
        signedIp,
      });

      const before = await countAuditEvents({
        action: "fee_consent_pdf_exported",
        entityType: "fee_consent",
        entityId: String(seed.consent.id),
      });

      const { status, contentType, buffer } = await getPdf(
        `/api/admin/fee-consents/${seed.consent.id}/pdf`,
      );

      expect(status).toBe(200);
      expect(contentType).toMatch(/^application\/pdf/);
      expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();
      expect(pageCount).toBeGreaterThanOrEqual(1);
      expect(pageCount).toBeLessThanOrEqual(4);

      const text = await extractPdfText(buffer);
      expect(text).toContain(sigName);
      expect(text).toContain(signedIp);

      const after = await countAuditEvents({
        action: "fee_consent_pdf_exported",
        entityType: "fee_consent",
        entityId: String(seed.consent.id),
      });
      expect(after - before).toBe(1);
    },
  );

  it("404s on an unknown consent id without writing an audit row", async () => {
    const before = await countAuditEvents({
      action: "fee_consent_pdf_exported",
      entityType: "fee_consent",
      entityId: "999999999",
    });
    const { status } = await getPdf(`/api/admin/fee-consents/999999999/pdf`);
    expect(status).toBe(404);
    const after = await countAuditEvents({
      action: "fee_consent_pdf_exported",
      entityType: "fee_consent",
      entityId: "999999999",
    });
    expect(after).toBe(before);
  });
});

describe("buildConsentSupersedeChain — Task #353 unit coverage", () => {
  it(
    "walks the FCR-1 → FC-1 → FCR-2 → FC-2 fixture in chronological order with no duplicates",
    async () => {
      // Stagger ages so consentedAt / createdAt are strictly increasing,
      // independent of the same-millisecond tie-breaker.
      const seed1 = await seedSignedConsent({
        accountNumber: `${seedKey}_chain_v1`,
        signatureName: "Chain Signer v1",
        signedIp: "203.0.113.10",
        ageMs: 4 * DAY_MS,
      });
      const supersede = await seedSupersedeRequest({
        oldConsentId: seed1.consent.id,
        oldRequestId: seed1.request.id,
        newAccountNumber: `${seedKey}_chain_v2`,
        ageMs: 2 * DAY_MS,
      });
      // Promote FCR-2 → signed → FC-2. We can't reuse seedSignedConsent
      // here because that helper inserts its own request — instead, mint
      // FC-2 directly and link the existing pending FCR-2 to it.
      const ref = new Date(Date.now() + 30 * DAY_MS);
      const stamp = new Date(Date.now() - 1 * DAY_MS);
      const [consent2] = await db
        .insert(feeConsents)
        .values({
          adviceRecordId,
          clientId: clientUserId,
          adviserId: adviserUserId,
          feeType: "ongoing_service_fee",
          amountType: "fixed",
          amount: "150.0000",
          accountNumber: `${seedKey}_chain_v2`,
          accountName: "Test Account v2",
          deductionFrequency: "monthly",
          referenceDay: ref,
          renewalWindowStart: new Date(ref.getTime() - 60 * DAY_MS),
          renewalWindowEnd: new Date(ref.getTime() + 150 * DAY_MS),
          consentExpiryDate: new Date(ref.getTime() + 150 * DAY_MS),
          renewalStatus: "active",
          clientSignatureName: "Chain Signer v2",
          consentedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .returning();
      await db
        .update(feeConsentRequests)
        .set({ status: "consented", signedFeeConsentId: consent2.id })
        .where(eq(feeConsentRequests.id, supersede.newRequestId));

      // ----- Walk from the freshest consent (kind=consent, FC-2) -----
      const fromConsent = await buildConsentSupersedeChain({
        kind: "consent",
        id: consent2.id,
      });
      expect(fromConsent.requestIds.sort()).toEqual(
        [seed1.request.id, supersede.newRequestId].sort(),
      );
      expect(fromConsent.consentIds.sort()).toEqual(
        [seed1.consent.id, consent2.id].sort(),
      );
      expect(fromConsent.chain.map((c) => c.ref)).toEqual([
        `FCR-${seed1.request.id}`,
        `FC-${seed1.consent.id}`,
        `FCR-${supersede.newRequestId}`,
        `FC-${consent2.id}`,
      ]);
      // Dedupe: each ref appears exactly once.
      const refsFromConsent = fromConsent.chain.map((c) => c.ref);
      expect(new Set(refsFromConsent).size).toBe(refsFromConsent.length);
      // The "THIS DOCUMENT" marker is on FC-2 only.
      const thisDocRefs = fromConsent.chain
        .filter((c) => c.label.includes("THIS DOCUMENT"))
        .map((c) => c.ref);
      expect(thisDocRefs).toEqual([`FC-${consent2.id}`]);

      // ----- Walk from the oldest request (kind=request, FCR-1) ----
      // Forward + backward traversals must agree on the node set.
      const fromRequest = await buildConsentSupersedeChain({
        kind: "request",
        id: seed1.request.id,
      });
      expect(fromRequest.requestIds.sort()).toEqual(
        fromConsent.requestIds.sort(),
      );
      expect(fromRequest.consentIds.sort()).toEqual(
        fromConsent.consentIds.sort(),
      );
      expect(fromRequest.chain.map((c) => c.ref)).toEqual([
        `FCR-${seed1.request.id}`,
        `FC-${seed1.consent.id}`,
        `FCR-${supersede.newRequestId}`,
        `FC-${consent2.id}`,
      ]);
      // The "THIS DOCUMENT" marker now points at FCR-1 instead.
      const thisDocFromRequest = fromRequest.chain
        .filter((c) => c.label.includes("THIS DOCUMENT"))
        .map((c) => c.ref);
      expect(thisDocFromRequest).toEqual([`FCR-${seed1.request.id}`]);
    },
  );

  it("returns an empty chain for an unknown id (DFS visits nothing it can't load)", async () => {
    const result = await buildConsentSupersedeChain({
      kind: "consent",
      id: 999999999,
    });
    // The contract the renderer cares about is "chain has no entries to
    // draw" — nothing is rendered for the missing row. The DFS memo adds
    // 999999999 to consentIds BEFORE the DB lookup (memo first, fetch
    // second — the memo is what blocks cycles), so the id list legitimately
    // contains the requested id even when no row exists. Asserting both
    // halves keeps that distinction explicit so a future refactor can't
    // accidentally start drawing chain entries for missing rows.
    expect(result.chain).toEqual([]);
    expect(result.consentIds).toEqual([999999999]);
    expect(result.requestIds).toEqual([]);
  });
});
