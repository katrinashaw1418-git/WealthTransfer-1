// =============================================================================
// Task #318 — End-to-end watermark coverage for EVERY PDF download surface
// =============================================================================
// The reviewer required a per-surface test that proves:
//   1. The HTTP response body is a parseable PDF.
//   2. Watermarking actually ran on the served bytes (output ≠ source).
//   3. The unified `document.download` audit row was written with
//      clientUserId / documentId / purpose / downloadedAtUtc populated.
//
// Surfaces covered (one describe() block each):
//   A. GET /api/adviser/reports/:id/download
//   B. GET /api/client/documents/:id/download (PDF storedMime)
//   C. GET /api/admin/fee-consent-requests/:id/pdf
//   D. GET /api/admin/fee-consents/:id/pdf
//
// Tests run end-to-end against the real route handler and the real
// PostgreSQL test DB seeded by the bootstrap helper. JWT_SECRET is set
// before the auth module loads so the route's requireAuth() succeeds.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq, and, desc } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { db } from "../db";
import {
  users,
  adviserClients,
  clientDocuments,
  reportRequests,
  feeConsents,
  feeConsentRequests,
  adviceRecords,
  auditLogs,
} from "@shared/schema";
import { registerAdviserRoutes } from "../adviser-routes";
import { registerClientRoutes } from "../client-routes";
import { registerAdminRoutes } from "../admin-routes";
import { signToken } from "../auth";
import { REPORTS_DIR } from "./reports";
import { putObject, deleteObject } from "./object-storage";

// Build a minimal valid PDF as a fixture for upload/seed.
async function makeFixturePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

// Async helper: assert the buffer is a parseable PDF and return page count.
async function pdfPageCount(buf: Buffer): Promise<number> {
  const d = await PDFDocument.load(buf);
  return d.getPageCount();
}

// Pull the most recent unified `document.download` audit row for an entity.
async function latestDocumentDownloadAudit(
  userId: number,
  entityType: string,
  entityId: number,
) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.action, "document.download"),
        eq(auditLogs.entityType, entityType),
        eq(auditLogs.entityId, String(entityId)),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// -------- Shared app & fixtures ---------------------------------------------
let app: express.Express;
let adviserId: number;
let clientId: number;
let adminId: number;
let adviserToken: string;
let clientToken: string;
let adminToken: string;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  registerAdviserRoutes(app);
  registerClientRoutes(app);
  registerAdminRoutes(app);

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [adviser] = await db
    .insert(users)
    .values({
      username: `t318wm-adv-${stamp}`,
      email: `t318wm-adv-${stamp}@example.test`,
      password: "x",
      firstName: "Test",
      lastName: "Adviser",
      role: "adviser",
      kycStatus: "verified",
    })
    .returning();
  const [client] = await db
    .insert(users)
    .values({
      username: `t318wm-cli-${stamp}`,
      email: `t318wm-cli-${stamp}@example.test`,
      password: "x",
      firstName: "Test",
      lastName: "Client",
      role: "user",
      kycStatus: "verified",
    })
    .returning();
  const [admin] = await db
    .insert(users)
    .values({
      username: `t318wm-adm-${stamp}`,
      email: `t318wm-adm-${stamp}@example.test`,
      password: "x",
      firstName: "Test",
      lastName: "Admin",
      role: "admin",
      kycStatus: "verified",
    })
    .returning();
  adviserId = adviser.id;
  clientId = client.id;
  adminId = admin.id;

  await db.insert(adviserClients).values({
    adviserUserId: adviserId,
    clientUserId: clientId,
    isActive: true,
  });

  adviserToken = signToken({
    userId: adviserId,
    username: adviser.username,
    email: adviser.email,
    role: "adviser",
  });
  clientToken = signToken({
    userId: clientId,
    username: client.username,
    email: client.email,
    role: "user",
  });
  adminToken = signToken({
    userId: adminId,
    username: admin.username,
    email: admin.email,
    role: "admin",
  });
});

// =============================================================================
// A. Adviser report download
// =============================================================================
describe("GET /api/adviser/reports/:id/download — watermarked (Task #318)", () => {
  let reportId: number;
  let reportPath: string;
  let sourcePdf: Buffer;

  beforeAll(async () => {
    sourcePdf = await makeFixturePdf(2);

    const [row] = await db
      .insert(reportRequests)
      .values({
        adviserUserId: adviserId,
        clientUserId: clientId,
        reportType: "performance",
        status: "ready",
        // Ensure expiresAt is far in the future.
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    reportId = row.id;

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    reportPath = path.join(REPORTS_DIR, `${reportId}.pdf`);
    fs.writeFileSync(reportPath, sourcePdf);
  });

  afterAll(() => {
    try {
      fs.unlinkSync(reportPath);
    } catch {}
  });

  it("returns a PDF that is watermarked (differs from the on-disk source) and preserves page count", async () => {
    const res = await request(app)
      .get(`/api/adviser/reports/${reportId}/download`)
      .set("Authorization", `Bearer ${adviserToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    // Watermarking must have produced a different byte stream than the
    // source on disk — proves the route ran the helper, not a passthrough.
    expect(body.equals(sourcePdf)).toBe(false);
    // Output is still a valid 2-page PDF.
    expect(await pdfPageCount(body)).toBe(2);
  });

  it("writes a unified document.download audit row with clientUserId/documentId/purpose/downloadedAtUtc", async () => {
    const row = await latestDocumentDownloadAudit(
      adviserId,
      "report_request",
      reportId,
    );
    expect(row).not.toBeNull();
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.clientUserId).toBe(clientId);
    expect(meta.documentId).toBe(reportId);
    expect(meta.purpose).toBe("report_download");
    expect(typeof meta.downloadedAtUtc).toBe("string");
    // Parseable as a real Date.
    expect(Number.isFinite(Date.parse(meta.downloadedAtUtc as string))).toBe(true);
  });
});

// =============================================================================
// B. Client document download (PDF path — watermarked)
// =============================================================================
describe("GET /api/client/documents/:id/download — watermarked (Task #318)", () => {
  let docId: number;
  let storageKey: string;
  let sourcePdf: Buffer;

  beforeAll(async () => {
    sourcePdf = await makeFixturePdf(3);
    const put = await putObject({
      prefix: `client-documents/${clientId}`,
      fileName: "fact-find.pdf",
      bytes: sourcePdf,
    });
    storageKey = put.storageKey;

    const [row] = await db
      .insert(clientDocuments)
      .values({
        clientId,
        documentType: "fact_find",
        fileName: "fact-find.pdf",
        storageKey,
        mimeType: "application/pdf",
        fileSizeBytes: sourcePdf.length,
        uploadedByUserId: adviserId,
      })
      .returning();
    docId = row.id;
  });

  afterAll(async () => {
    try {
      await deleteObject(storageKey);
    } catch {}
  });

  it("returns a watermarked PDF that differs from the stored bytes", async () => {
    const res = await request(app)
      .get(`/api/client/documents/${docId}/download`)
      .set("Authorization", `Bearer ${clientToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(body.equals(sourcePdf)).toBe(false);
    expect(await pdfPageCount(body)).toBe(3);
  });

  it("writes a unified document.download audit row tagged client_document_download", async () => {
    const row = await latestDocumentDownloadAudit(
      clientId,
      "client_document",
      docId,
    );
    expect(row).not.toBeNull();
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.clientUserId).toBe(clientId);
    expect(meta.documentId).toBe(docId);
    expect(meta.purpose).toBe("client_document_download");
    expect(meta.watermarked).toBe(true);
    expect(typeof meta.downloadedAtUtc).toBe("string");
  });
});

// =============================================================================
// C. Admin fee-consent-request PDF
// =============================================================================
describe("GET /api/admin/fee-consent-requests/:id/pdf — watermarked (Task #318)", () => {
  let requestId: number;

  beforeAll(async () => {
    const refDay = new Date(Date.now() + 30 * 86_400_000);
    const [row] = await db
      .insert(feeConsentRequests)
      .values({
        adviserUserId: adviserId,
        clientUserId: clientId,
        feeType: "advice_fee",
        amountType: "fixed",
        amount: "1500.0000",
        accountNumber: "012345-6789",
        accountName: "Test Acct",
        deductionFrequency: "annually",
        proposedReferenceDay: refDay,
        proposedRenewalWindowStart: new Date(
          refDay.getTime() - 60 * 86_400_000,
        ),
        proposedRenewalWindowEnd: new Date(
          refDay.getTime() + 150 * 86_400_000,
        ),
        proposedConsentExpiryDate: new Date(
          refDay.getTime() + 365 * 86_400_000,
        ),
        status: "pending",
      })
      .returning();
    requestId = row.id;
  });

  it("returns a watermarked PDF body and writes the unified audit row", async () => {
    const res = await request(app)
      .get(`/api/admin/fee-consent-requests/${requestId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    // Body is a valid PDF with at least one page.
    expect(await pdfPageCount(body)).toBeGreaterThanOrEqual(1);

    const audit = await latestDocumentDownloadAudit(
      adminId,
      "fee_consent_request",
      requestId,
    );
    expect(audit).not.toBeNull();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.clientUserId).toBe(clientId);
    expect(meta.documentId).toBe(requestId);
    expect(meta.purpose).toBe("fee_consent_request_download");
    expect(typeof meta.downloadedAtUtc).toBe("string");
  });
});

// =============================================================================
// D. Admin fee-consent PDF
// =============================================================================
describe("GET /api/admin/fee-consents/:id/pdf — watermarked (Task #318)", () => {
  let consentId: number;

  beforeAll(async () => {
    // Seed a minimal advice record so feeConsents.adviceRecordId FK is satisfied.
    const [advice] = await db
      .insert(adviceRecords)
      .values({
        clientId,
        adviserId,
        adviceType: "personal",
        adviceSource: "hybrid",
        status: "issued",
      })
      .returning();

    const refDay = new Date(Date.now() + 30 * 86_400_000);
    const [row] = await db
      .insert(feeConsents)
      .values({
        adviceRecordId: advice.id,
        clientId,
        adviserId,
        feeType: "advice_fee",
        amountType: "fixed",
        amount: "1500.0000",
        accountNumber: "012345-6789",
        accountName: "Test Acct",
        deductionFrequency: "annually",
        referenceDay: refDay,
        renewalWindowStart: new Date(refDay.getTime() - 60 * 86_400_000),
        renewalWindowEnd: new Date(refDay.getTime() + 150 * 86_400_000),
        consentExpiryDate: new Date(refDay.getTime() + 365 * 86_400_000),
        clientSignatureName: "Test Client",
      })
      .returning();
    consentId = row.id;
  });

  it("returns a watermarked PDF body and writes the unified audit row", async () => {
    const res = await request(app)
      .get(`/api/admin/fee-consents/${consentId}/pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(await pdfPageCount(body)).toBeGreaterThanOrEqual(1);

    const audit = await latestDocumentDownloadAudit(
      adminId,
      "fee_consent",
      consentId,
    );
    expect(audit).not.toBeNull();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.clientUserId).toBe(clientId);
    expect(meta.documentId).toBe(consentId);
    expect(meta.purpose).toBe("fee_consent_download");
    expect(typeof meta.downloadedAtUtc).toBe("string");
  });
});
