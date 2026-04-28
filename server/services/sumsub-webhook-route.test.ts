// =============================================================================
// Task #403 — POST /api/kyc/sumsub-webhook end-to-end contract
// =============================================================================
// Three legs of coverage on the real route:
//
//   1. A signed webhook with reviewAnswer=GREEN flips the user's kycStatus
//      to "verified", stamps kycUpdatedAt, AND writes a `kyc_status_changed`
//      audit-log row with source=sumsub_webhook so admins can later trace
//      who flipped the row.
//
//   2. A request with a tampered/incorrect HMAC digest is refused with
//      HTTP 401 BEFORE we touch the DB. The user's kycStatus stays
//      unchanged and no audit row is written for that attempt.
//
//   3. A signed webhook for an externalUserId that doesn't map to any row
//      returns HTTP 404 cleanly (instead of 500). No DB mutation, no
//      audit row.
//
// Setup mirrors server/services/kill-switch.test.ts: real Express app,
// real registerRoutes, real DB. We must mount the route-scoped
// `express.raw` middleware BEFORE registerRoutes — otherwise the global
// `express.json()` will have already drained the request stream and the
// webhook handler will get a parsed object instead of the raw Buffer
// it needs to verify the HMAC over.
// =============================================================================

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "task-403-sumsub-webhook-test-secret";
  process.env.SUMSUB_APP_TOKEN ||= "sbx:task-403-app-token";
  process.env.SUMSUB_SECRET_KEY ||= "task-403-webhook-shared-secret";
});

import express from "express";
import request from "supertest";
import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Server } from "http";

import { db } from "../db";
import { auditLogs, users } from "@shared/schema";
import { registerRoutes } from "../routes";
import { buildExternalUserId } from "./sumsub";

const SECRET = process.env.SUMSUB_SECRET_KEY as string;

let testApp: express.Express;
let httpServer: Server;
let testUserId: number;
let seedKey: string;

function signBody(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function postWebhook(body: unknown, opts: { digest?: string; alg?: string } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const digest = opts.digest ?? signBody(raw);
  const req = request(testApp)
    .post("/api/kyc/sumsub-webhook")
    .set("Content-Type", "application/json")
    .set("X-Payload-Digest", digest);
  if (opts.alg) req.set("X-Payload-Digest-Alg", opts.alg);
  return req.send(raw);
}

beforeAll(async () => {
  seedKey = `t403_${randomBytes(4).toString("hex")}`;
  const [created] = await db
    .insert(users)
    .values({
      username: `${seedKey}_client`,
      email: `${seedKey}@test.invalid`,
      password: "not-a-real-password",
      firstName: "Sumsub",
      lastName: "Webhook",
      role: "client",
      kycStatus: "pending",
      emailVerified: true,
    })
    .returning();
  testUserId = created.id;

  // Mirror the production middleware order from server/index.ts: the
  // raw parser is mounted on the webhook path BEFORE the global JSON
  // parser so the handler still receives a Buffer for HMAC verification.
  testApp = express();
  testApp.set("trust proxy", true);
  testApp.use(
    "/api/kyc/sumsub-webhook",
    express.raw({ type: "*/*", limit: "1mb" }),
  );
  testApp.use(express.json());
  testApp.use(express.urlencoded({ extended: false }));
  httpServer = await registerRoutes(testApp);
}, 60_000);

afterAll(async () => {
  // Intentionally leave the seeded user row in place — registerRoutes can
  // attach FK referrers (portfolio_snapshots, audit_logs, etc.) that make
  // a hard DELETE unsafe across runs. The username carries a per-run
  // randomBytes(4) suffix so reruns never collide. Same convention used by
  // server/portfolio-benchmark-parity.test.ts.
  if (httpServer && typeof httpServer.close === "function") {
    httpServer.close();
  }
});

afterEach(async () => {
  // Reset kycStatus between tests so each scenario starts from a known
  // state. Use a direct UPDATE so kycUpdatedAt isn't stamped from the
  // test side (it would otherwise pollute the "stamped by webhook"
  // assertion below).
  await db
    .update(users)
    .set({ kycStatus: "pending" })
    .where(eq(users.id, testUserId));
});

describe("POST /api/kyc/sumsub-webhook (Task #403)", () => {
  it("flips kycStatus to verified, stamps kycUpdatedAt, and writes an audit row on a signed GREEN webhook", async () => {
    const before = await db
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(before[0].kycStatus).toBe("pending");
    const beforeStamp = before[0].kycUpdatedAt;

    const payload = {
      applicantId: "applicant-1",
      inspectionId: "inspection-1",
      correlationId: "corr-1",
      externalUserId: buildExternalUserId(testUserId),
      type: "applicantReviewed",
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "GREEN", reviewRejectType: "FINAL" },
    };

    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.kycStatus).toBe("verified");
    expect(res.body.userId).toBe(testUserId);

    const after = await db
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(after[0].kycStatus).toBe("verified");
    // kycUpdatedAt should be stamped by storage.updateUser when kycStatus
    // changes (Task #285 behaviour).
    expect(after[0].kycUpdatedAt).not.toBe(beforeStamp);
    expect(after[0].kycUpdatedAt).toBeInstanceOf(Date);

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, testUserId),
          eq(auditLogs.action, "kyc_status_changed"),
          eq(auditLogs.entityType, "user"),
          eq(auditLogs.entityId, String(testUserId)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(auditRows.length).toBe(1);
    const meta = auditRows[0].metadata as Record<string, unknown>;
    expect(meta.source).toBe("sumsub_webhook");
    expect(meta.before).toBe("pending");
    expect(meta.after).toBe("verified");
    expect(meta.reviewAnswer).toBe("GREEN");
    expect(meta.reviewStatus).toBe("completed");
    expect(meta.applicantId).toBe("applicant-1");
    expect(meta.externalUserId).toBe(buildExternalUserId(testUserId));
  });

  it("maps reviewAnswer=RED to rejected", async () => {
    const payload = {
      applicantId: "applicant-2",
      externalUserId: buildExternalUserId(testUserId),
      type: "applicantReviewed",
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL" },
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe("rejected");
    const after = await db
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(after[0].kycStatus).toBe("rejected");
  });

  it("rejects an unsigned / wrongly-signed webhook with 401 and does not mutate the user", async () => {
    const payload = {
      externalUserId: buildExternalUserId(testUserId),
      type: "applicantReviewed",
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "GREEN" },
    };
    // Tampered digest: sign with the wrong secret.
    const wrongDigest = createHmac("sha256", "not-the-real-secret")
      .update(JSON.stringify(payload))
      .digest("hex");
    const res = await postWebhook(payload, { digest: wrongDigest });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);

    const after = await db
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(after[0].kycStatus).toBe("pending");
  });

  it("returns 401 when the digest header is missing entirely", async () => {
    const payload = {
      externalUserId: buildExternalUserId(testUserId),
      reviewResult: { reviewAnswer: "GREEN" },
      reviewStatus: "completed",
    };
    const res = await request(testApp)
      .post("/api/kyc/sumsub-webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));
    expect(res.status).toBe(401);
  });

  it("returns 404 for a signed webhook whose externalUserId doesn't map to any user", async () => {
    const payload = {
      externalUserId: "amax-user-99999999",
      type: "applicantReviewed",
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "GREEN" },
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/externaluserid/i);
  });

  it("returns 404 (not 500) for a signed webhook with a malformed externalUserId shape", async () => {
    const payload = {
      externalUserId: "totally-not-our-prefix-7",
      type: "applicantReviewed",
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "GREEN" },
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(404);
  });

  it("acknowledges notification-style events without changing kycStatus", async () => {
    const payload = {
      externalUserId: buildExternalUserId(testUserId),
      type: "applicantCreated",
      // No reviewStatus / reviewResult.
    };
    const res = await postWebhook(payload);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    const after = await db
      .select()
      .from(users)
      .where(eq(users.id, testUserId));
    expect(after[0].kycStatus).toBe("pending");
  });
});
