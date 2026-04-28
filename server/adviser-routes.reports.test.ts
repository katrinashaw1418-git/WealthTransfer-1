// =============================================================================
// Task #298 / #315 / #345 — POST /api/adviser/reports route-level invariants
// =============================================================================
// These tests pin down the response envelope (status code + body shape) the
// adviser surface relies on. The service-layer dup guard / sweeper / chain
// walk are covered separately in server/services/reports.test.ts; this file
// exercises ONLY the HTTP handler:
//
//   1. 409 + code:"REPORT_ALREADY_IN_PROGRESS" + existingReport when an
//      in-flight (requested|generating) row exists for (adviser, client, type).
//   2. 409 + code:"REPORT_ALREADY_EXISTS" + existingReport when a still-valid
//      ready row exists (and the caller did NOT pass regenerate=true).
//   3. With regenerate=true, the prior ready row is superseded
//      (status='expired' + downloadUrl cleared), an
//      "adviser_report_superseded" audit row is written, AND a fresh
//      report request is created.
//   4. Schema validation: periodFrom > periodTo returns 400 BEFORE any DB
//      mutation happens.
//
// Test strategy
// -------------
//   - Spin up a real Express app with registerAdviserRoutes mounted, seed a
//     real adviser/client/link in the dev DB so requireAuth + requireRole +
//     assertAdviserClientLink all run end-to-end.
//   - Mock generateReportPdf so the regenerate happy path doesn't actually
//     write a PDF to disk on every test run. The contract under test is the
//     response envelope and the supersede + audit side-effects, not the PDF
//     bytes (which generate-report-pdf already covers via its own surface).
//   - Mock the adviser email notifications for the same reason — the
//     fee-consents test pattern proves SMTP-free defaults are OK.
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
  process.env.JWT_SECRET ||= "task-328-adviser-reports-route-test-secret";
});

vi.mock("./email", () => ({
  emailConfigured: true,
  sendVerificationEmail: vi.fn(async () => ({ sent: true })),
  sendInviteEmail: vi.fn(async () => ({ sent: true })),
  sendInsufficientFundsEmail: vi.fn(async () => ({ sent: true })),
  sendReportReadyEmail: vi.fn(async () => ({ sent: true })),
  sendReportFailedEmail: vi.fn(async () => ({ sent: true })),
  sendReportExpiringSoonEmail: vi.fn(async () => ({ sent: true })),
  sendFeeConsentRequestEmail: vi.fn(async () => ({
    sent: true,
    signLink: "/client/fee-consents",
  })),
  sendFeeRefundClientEmail: vi.fn(async () => ({ sent: true })),
}));

// Stub generateReportPdf so the regenerate path returns instantly without
// reading any client-portfolio data or writing a PDF to disk. We DO want
// every other export (sweepStaleReportJobs, findActiveReportRequest, etc.)
// to keep their real implementations, so we re-export the actual module
// and override only the PDF generator.
vi.mock("./services/reports", async () => {
  const actual = await vi.importActual<typeof import("./services/reports")>(
    "./services/reports",
  );
  return {
    ...actual,
    generateReportPdf: vi.fn(async (reportId: number) => {
      // Mark the row ready so the route's post-generation re-read returns a
      // sensible terminal shape. Any failure inside the test stub bubbles
      // back through the route's audit branch — that's fine.
      const { db } = await import("./db");
      const { reportRequests } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const downloadUrl = `/api/adviser/reports/${reportId}/download`;
      await db
        .update(reportRequests)
        .set({
          status: "ready",
          downloadUrl,
          generatedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          downloadLinkExpiresAt: new Date(Date.now() + 7 * 86_400_000),
        })
        .where(eq(reportRequests.id, reportId));
      return {
        status: "ready" as const,
        downloadUrl,
        filePath: `/tmp/${reportId}.pdf`,
      };
    }),
  };
});

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { signToken } from "./auth";
import { registerAdviserRoutes } from "./adviser-routes";
import { db } from "./db";
import {
  adviserClients,
  auditLogs,
  reportRequests,
  users,
} from "@shared/schema";

// -----------------------------------------------------------------------------
// Test runtime + fixtures
// -----------------------------------------------------------------------------
let server: http.Server;
let baseUrl: string;
let seedKey: string;

let adviserUserId: number;
let clientUserId: number;
let adviserToken: string;

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  seedKey = `t328_${randomBytes(4).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerAdviserRoutes(app);

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

  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    relationshipType: "servicing",
    isActive: true,
  });

  adviserToken = signToken({
    userId: adviserUserId,
    username: adviserRow.username,
    email: adviserRow.email,
    role: "adviser",
  });
});

afterAll(async () => {
  // Same cleanup stance as fee-consents.test.ts: leave the seeded users
  // (audit_logs.user_id has an FK to users + audit_logs is INSERT-ONLY),
  // but clear the report rows + the link this run created so a re-run
  // starts clean.
  await db
    .delete(reportRequests)
    .where(eq(reportRequests.adviserUserId, adviserUserId));
  await db
    .delete(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  // Each test starts with no report rows so the route's lookups
  // (findActiveReportRequest + findDuplicateRecentReport) are deterministic.
  await db
    .delete(reportRequests)
    .where(eq(reportRequests.adviserUserId, adviserUserId));
});

// -----------------------------------------------------------------------------
// Builders / helpers
// -----------------------------------------------------------------------------
function buildPayload(overrides: Record<string, unknown> = {}) {
  // periodFrom <= periodTo so the schema validation default-passes; tests
  // that want to exercise the inverted-range branch override these two.
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(today.getUTCDate()).padStart(2, "0");
  const periodTo = `${yyyy}-${mm}-${dd}`;
  const monthAgo = new Date(today.getTime() - 30 * DAY_MS);
  const periodFrom = `${monthAgo.getUTCFullYear()}-${String(monthAgo.getUTCMonth() + 1).padStart(2, "0")}-${String(monthAgo.getUTCDate()).padStart(2, "0")}`;
  return {
    clientUserId,
    reportType: "portfolio_summary",
    format: "pdf",
    periodFrom,
    periodTo,
    notes: null,
    ...overrides,
  };
}

type JsonBody = Record<string, unknown>;

// Typed shapes for the response envelopes the POST handler returns. Using
// per-test generics on `postReport` instead of one wide union keeps each
// call site self-documenting (the test names which envelope it expects)
// and means a shape change in the route handler shows up at compile time.
interface ExistingReportSummary {
  id: number;
  status: string;
  reportType: string;
  clientUserId: number;
  adviserUserId: number;
  downloadUrl: string | null;
  expiresAt: string | null;
  requestedAt: string | null;
}

interface DuplicateErrorBody {
  error: string;
  code: string;
  existingReport: ExistingReportSummary;
}

interface ValidationErrorBody {
  error: string;
}

interface CreatedReportBody {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  reportType: string;
  status: string;
  downloadUrl: string | null;
}

interface SupersedeAuditMetadata {
  clientUserId: number;
  reportType: string;
}

interface PostResponse<T> {
  status: number;
  body: T;
}

async function postReport<T>(body: JsonBody): Promise<PostResponse<T>> {
  const res = await fetch(`${baseUrl}/api/adviser/reports`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adviserToken}`,
    },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: parsed };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe("POST /api/adviser/reports — duplicate / regenerate / validation", () => {
  it("returns 409 + REPORT_ALREADY_IN_PROGRESS + existingReport when an in-flight row exists", async () => {
    // Seed a 'requested' row directly so the route's findActiveReportRequest
    // hits before any other branch. requestedAt is recent — it's the
    // *active* state that matters here, not the duplicate-window timer.
    const [inflight] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "requested",
        requestedAt: new Date(),
      })
      .returning();

    const { status, body } = await postReport<DuplicateErrorBody>(
      buildPayload(),
    );
    expect(status).toBe(409);
    expect(body.code).toBe("REPORT_ALREADY_IN_PROGRESS");
    expect(body.existingReport).toBeDefined();
    expect(body.existingReport.id).toBe(inflight.id);
    expect(body.existingReport.status).toBe("requested");

    // Defensive: the row count should NOT have grown — the route must NOT
    // insert a new request when it short-circuits with 409.
    const all = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.adviserUserId, adviserUserId));
    expect(all.length).toBe(1);
  });

  it("also returns REPORT_ALREADY_IN_PROGRESS when the existing row is in 'generating'", async () => {
    const [generatingRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "generating",
        requestedAt: new Date(),
      })
      .returning();

    const { status, body } = await postReport<DuplicateErrorBody>(
      buildPayload(),
    );
    expect(status).toBe(409);
    expect(body.code).toBe("REPORT_ALREADY_IN_PROGRESS");
    expect(body.existingReport.id).toBe(generatingRow.id);
  });

  it("returns 409 + REPORT_ALREADY_EXISTS + existingReport when a non-expired ready row exists and regenerate is omitted", async () => {
    // ready row whose expiresAt is in the future — the route must treat it
    // as the active version and refuse a fresh request unless the caller
    // explicitly asks to regenerate.
    const [readyRow] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        requestedAt: new Date(Date.now() - 2 * HOUR_MS),
        generatedAt: new Date(Date.now() - 2 * HOUR_MS),
        downloadUrl: "/api/adviser/reports/0/download",
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        downloadLinkExpiresAt: new Date(Date.now() + 7 * DAY_MS),
      })
      .returning();

    const { status, body } = await postReport<DuplicateErrorBody>(
      buildPayload(),
    );
    expect(status).toBe(409);
    expect(body.code).toBe("REPORT_ALREADY_EXISTS");
    expect(body.existingReport.id).toBe(readyRow.id);
    expect(body.existingReport.status).toBe("ready");

    // The ready row must be untouched: a 409 response must NOT clear the
    // downloadUrl or flip the status.
    const [after] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, readyRow.id));
    expect(after.status).toBe("ready");
    expect(after.downloadUrl).not.toBeNull();
  });

  it("with regenerate=true, supersedes the prior ready row, writes the audit event, and creates a new request", async () => {
    // Prior ready row. requestedAt is set OUTSIDE the 30-minute duplicate
    // guard window so the inner createReportRequest -> findDuplicateRecentReport
    // probe doesn't also fire and 409 us. The 30-min guard exists to stop
    // double-clicks; an intentional Regenerate of an old report is
    // deliberately allowed.
    const [priorReady] = await db
      .insert(reportRequests)
      .values({
        adviserUserId,
        clientUserId,
        reportType: "portfolio_summary",
        format: "pdf",
        status: "ready",
        requestedAt: new Date(Date.now() - 2 * HOUR_MS),
        generatedAt: new Date(Date.now() - 2 * HOUR_MS),
        downloadUrl: "/api/adviser/reports/0/download",
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        downloadLinkExpiresAt: new Date(Date.now() + 7 * DAY_MS),
      })
      .returning();

    const { status, body } = await postReport<CreatedReportBody>(
      buildPayload({ regenerate: true }),
    );
    // 200 OK because the route returns the freshly-inserted (now-ready via
    // our generateReportPdf stub) row as JSON.
    expect(status).toBe(200);
    expect(body.id).not.toBe(priorReady.id);
    expect(body.reportType).toBe("portfolio_summary");

    // The prior row was superseded: status flipped to 'expired' AND the
    // downloadUrl was cleared so the old PDF can no longer be served.
    const [priorAfter] = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, priorReady.id));
    expect(priorAfter.status).toBe("expired");
    expect(priorAfter.downloadUrl).toBeNull();

    // A fresh report row exists and is the row returned by the handler.
    const fresh = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.id, body.id))
      .limit(1);
    expect(fresh.length).toBe(1);
    expect(fresh[0].adviserUserId).toBe(adviserUserId);
    expect(fresh[0].clientUserId).toBe(clientUserId);
    expect(fresh[0].reportType).toBe("portfolio_summary");

    // Audit row written for the supersede event. Scope by entityId so
    // prior runs of this file (audit_logs is INSERT-ONLY in this DB)
    // can't false-match.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "adviser_report_superseded"),
          eq(auditLogs.entityType, "report_request"),
          eq(auditLogs.entityId, String(priorReady.id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.userId).toBe(adviserUserId);
    // audit_logs.metadata is jsonb in the schema (typed `unknown` here),
    // so narrow it once via a typed local instead of inline `as any`.
    const meta = audit.metadata as SupersedeAuditMetadata;
    expect(meta.clientUserId).toBe(clientUserId);
    expect(meta.reportType).toBe("portfolio_summary");
  });

  it("rejects the payload with 400 when periodFrom > periodTo (schema gate fires before any DB work)", async () => {
    // Inverted window. Note: NO existing rows are seeded — the schema gate
    // must fire BEFORE the route looks anything up so this 400s cleanly.
    const { status, body } = await postReport<ValidationErrorBody>(
      buildPayload({
        periodFrom: "2026-12-31",
        periodTo: "2026-01-01",
      }),
    );
    expect(status).toBe(400);
    expect(String(body.error ?? "")).toMatch(/end date|on or after|periodTo/i);

    // No row should have been created.
    const all = await db
      .select()
      .from(reportRequests)
      .where(eq(reportRequests.adviserUserId, adviserUserId));
    expect(all.length).toBe(0);
  });
});
