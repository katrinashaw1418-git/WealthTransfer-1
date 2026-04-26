// =============================================================================
// TASK #105 — WEALTH PLANNER COMPLIANCE PASS/FAIL ROLL-UP
// =============================================================================
// Single-shot, re-runnable verification script for the wealth-planner
// compliance surface introduced in:
//   - Task #94 (4 narrow tables + assertAdviserClientLink + retention defaults)
//   - Task #95 (audit metadata standardisation: metadata.before / .after)
//   - Task #96 (review-pending lock; PROPOSED at time of writing)
//   - Task #98 (planner UI write paths; PROPOSED at time of writing)
//
// This script proves — with a hard PASS/FAIL on every assertion — that the
// adviser-facing planner cannot be coerced into:
//   (a) leaking writes between advisers/clients/admins,
//   (b) mutating notes (append-only is enforced by route absence + schema),
//   (c) editing planner data while an advice record is review_pending,
//   (d) emitting any ledger / transactions side-effect,
//   (e) skipping the standardised before/after audit-log shape.
//
// Pattern follows scripts/test-fee-deduction-gate-b.ts byte-for-byte:
//   - dotenv/config FIRST so JWT_SECRET is in process.env before
//     server/auth.ts is module-initialised by any downstream import.
//   - JWT_SECRET hard-fail if .env is missing AND the safety-belt default
//     wasn't applied — refuses to silently sign tokens with an unknown key.
//   - Deterministic test usernames; cleans its own rows on every run via
//     PK-tracked deletes (never broad WHERE clauses on shared tables).
//   - Parameterised SQL only via Drizzle — no template-literal interpolation.
//   - No `as any` casts; the only narrowing is the canonical mock-app
//     boundary cast through `unknown` for the route-capture pattern.
//
// Each assertion fires REAL evidence: route-absence proofs use the captured
// (method, path) registry (never a hand-rolled allow-list), schema-shape
// assertions hit information_schema directly, and side-effect assertions
// re-read PostgreSQL after the route handler runs. Today's run intentionally
// surfaces hard FAILs for assertions whose dependent tasks (#95, #96, #98)
// have not yet merged — those flip green automatically when the dependent
// code lands, with no script edit required.
//
// Usage:
//   npm run test:planner
//   # or:
//   npx tsx scripts/test-planner.ts
// =============================================================================

// Task #105 spec step 1 — JWT_SECRET / env bootstrap. MUST be the first
// import lines in the file. `dotenv/config` runs as a side-effect import
// (declaration-ordered, before any other import is resolved) and populates
// process.env from .env so that downstream imports of `server/auth.ts` see
// JWT_SECRET set at module-init time. The body-code `||=` defaults are a
// safety belt for environments where .env is absent. We then hard-fail if
// JWT_SECRET still isn't set, refusing to run with an unknown signing key.
import "dotenv/config";

process.env.NODE_ENV ||= "test";
process.env.JWT_SECRET ||= "test-jwt-secret";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET not loaded — refusing to sign tokens with unknown key");
}

import type { Express, Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  adviserClients,
  adviceRecords,
  clientObjectives,
  clientDocuments,
  adviserNotes,
  adviceRecordVersions,
  auditLogs,
  ledgerEntries,
} from "../shared/schema";
import { signToken } from "../server/auth";
import { registerAdviserRoutes } from "../server/adviser-routes";
import { registerClientRoutes } from "../server/client-routes";

// ---------------------------------------------------------------------------
// Constants — deterministic test users, scoped by a unique prefix so a
// re-run finds and reuses the same rows. Never collide with real users.
// ---------------------------------------------------------------------------
const CLIENT_USERNAME = "__planner_test_client__";
const ADVISER_USERNAME = "__planner_test_adviser__";
const OTHER_ADVISER_USERNAME = "__planner_test_other_adviser__";
const ADMIN_USERNAME = "__planner_test_admin__";

// ---------------------------------------------------------------------------
// Result tracking — labels are byte-identical to the canonical PASS lines
// listed in .local/tasks/task-105.md. Reporter abuse (recording an unknown
// label) throws synchronously so a future spec drift can't silently inflate
// the green banner.
// ---------------------------------------------------------------------------
type TestResult = { passed: boolean; details: string };
const CANONICAL_ORDER: string[] = [
  "non-adviser cannot create advice record",
  "adviser blocked from another adviser's record",
  "client cannot write to advice tables",
  "admin cannot mutate advice record",
  "objectives blocked during review_pending",
  "recommendations blocked during review_pending",
  "notes allowed during review_pending",
  "objective POST succeeds on active record",
  "objective write creates version snapshot atomically",
  "PUT on adviserNotes rejected — append-only enforced",
  "DELETE on adviserNotes rejected",
  "adviserNotes has no updatedAt column",
  "previousNoteId chain is traversable",
  "objective supersession sets supersededAt on prior row",
  "plan writes produce audit logs with before/after state",
  "no ledger entries created by planner writes",
];
const results = new Map<string, TestResult>();

function record(name: string, passed: boolean, details: string): void {
  if (!CANONICAL_ORDER.includes(name)) {
    throw new Error(`Reporter abuse: '${name}' is not in CANONICAL_ORDER`);
  }
  results.set(name, { passed, details });
}
const pass = (name: string, details: string) => record(name, true, details);
const fail = (name: string, details: string) => record(name, false, details);

// ---------------------------------------------------------------------------
// PK-tracked cleanup. We never delete by broad WHERE clauses on shared
// tables; instead we track every PK we insert (or transitively created via
// a route handler) and delete by inArray(table.id, ids).
// ---------------------------------------------------------------------------
type Created = {
  userIds: number[];
  adviceRecordIds: number[];
  objectiveIds: number[];
  documentIds: number[];
  noteIds: number[];
  versionIds: number[];
  auditIds: number[];
  adviserClientIds: number[];
};
const created: Created = {
  userIds: [],
  adviceRecordIds: [],
  objectiveIds: [],
  documentIds: [],
  noteIds: [],
  versionIds: [],
  auditIds: [],
  adviserClientIds: [],
};

// ---------------------------------------------------------------------------
// Fixture helpers — parameterised SQL only. Re-uses rows on subsequent runs.
// ---------------------------------------------------------------------------
async function ensureUser(opts: {
  username: string;
  email: string;
  role: "client" | "adviser" | "admin";
}): Promise<number> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.username, opts.username));
  if (existing) {
    if (existing.role !== opts.role) {
      await db.update(users).set({ role: opts.role }).where(eq(users.id, existing.id));
    }
    created.userIds.push(existing.id);
    return existing.id;
  }
  const [row] = await db
    .insert(users)
    .values({
      username: opts.username,
      email: opts.email,
      password: "not-a-real-password",
      firstName: "Planner",
      lastName: "Test",
      role: opts.role,
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  created.userIds.push(row.id);
  return row.id;
}

async function ensureLink(adviserUserId: number, clientUserId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (existing) {
    if (!existing.isActive) {
      await db
        .update(adviserClients)
        .set({ isActive: true, unlinkedAt: null })
        .where(eq(adviserClients.id, existing.id));
    }
    created.adviserClientIds.push(existing.id);
    return;
  }
  const [row] = await db
    .insert(adviserClients)
    .values({
      adviserUserId,
      clientUserId,
      relationshipType: "servicing",
      isActive: true,
    })
    .returning({ id: adviserClients.id });
  created.adviserClientIds.push(row.id);
}

async function ensureUnlinked(adviserUserId: number, clientUserId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(adviserClients)
    .where(
      and(
        eq(adviserClients.adviserUserId, adviserUserId),
        eq(adviserClients.clientUserId, clientUserId),
      ),
    );
  if (existing && existing.isActive) {
    await db
      .update(adviserClients)
      .set({ isActive: false, unlinkedAt: new Date() })
      .where(eq(adviserClients.id, existing.id));
  }
}

async function makeAdviceRecord(clientUserId: number): Promise<number> {
  const [row] = await db
    .insert(adviceRecords)
    .values({ clientId: clientUserId })
    .returning({ id: adviceRecords.id });
  created.adviceRecordIds.push(row.id);
  return row.id;
}

async function setAdviceStatus(adviceRecordId: number, status: string): Promise<void> {
  await db
    .update(adviceRecords)
    .set({ status })
    .where(eq(adviceRecords.id, adviceRecordId));
}

// Snapshot every PK currently visible for these test users so that any rows
// the route handlers create on our behalf get added to the cleanup list.
async function trackHandlerSideEffects(opts: {
  clientUserIds: number[];
  adviceRecordIds: number[];
}): Promise<void> {
  if (opts.clientUserIds.length === 0) return;
  const objs = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(inArray(clientObjectives.clientId, opts.clientUserIds));
  for (const o of objs) {
    if (!created.objectiveIds.includes(o.id)) created.objectiveIds.push(o.id);
  }
  const docs = await db
    .select({ id: clientDocuments.id })
    .from(clientDocuments)
    .where(inArray(clientDocuments.clientId, opts.clientUserIds));
  for (const d of docs) {
    if (!created.documentIds.includes(d.id)) created.documentIds.push(d.id);
  }
  const notes = await db
    .select({ id: adviserNotes.id })
    .from(adviserNotes)
    .where(inArray(adviserNotes.clientUserId, opts.clientUserIds));
  for (const n of notes) {
    if (!created.noteIds.includes(n.id)) created.noteIds.push(n.id);
  }
  if (opts.adviceRecordIds.length > 0) {
    const vers = await db
      .select({ id: adviceRecordVersions.id })
      .from(adviceRecordVersions)
      .where(inArray(adviceRecordVersions.adviceRecordId, opts.adviceRecordIds));
    for (const v of vers) {
      if (!created.versionIds.includes(v.id)) created.versionIds.push(v.id);
    }
  }
}

// PK-only delete in dependency order. Never broad WHERE clauses.
async function cleanup(): Promise<void> {
  if (created.versionIds.length > 0) {
    await db
      .delete(adviceRecordVersions)
      .where(inArray(adviceRecordVersions.id, created.versionIds));
  }
  if (created.objectiveIds.length > 0) {
    await db
      .delete(clientObjectives)
      .where(inArray(clientObjectives.id, created.objectiveIds));
  }
  if (created.documentIds.length > 0) {
    await db
      .delete(clientDocuments)
      .where(inArray(clientDocuments.id, created.documentIds));
  }
  if (created.noteIds.length > 0) {
    await db
      .delete(adviserNotes)
      .where(inArray(adviserNotes.id, created.noteIds));
  }
  if (created.adviceRecordIds.length > 0) {
    await db
      .delete(adviceRecords)
      .where(inArray(adviceRecords.id, created.adviceRecordIds));
  }
  if (created.auditIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.id, created.auditIds));
  }
  // Leave adviser_clients linkage rows AND user rows in place between runs
  // so the next invocation reuses them — the username constants make that
  // safe and idempotent.
}

// ---------------------------------------------------------------------------
// Route capture (gate-b pattern). Records every (method, path) pair so the
// PUT/DELETE-absence and create-route-absence assertions are decisive
// against the actual production router registration, not a hand-rolled
// allow-list.
// ---------------------------------------------------------------------------
type CapturedHandler = (req: Request, res: MockResponse) => unknown;
type CaptureFn = (path: string, handler: CapturedHandler) => void;
type CapturingApp = {
  get: CaptureFn;
  post: CaptureFn;
  patch: CaptureFn;
  delete: CaptureFn;
  put: CaptureFn;
};
const captured = new Map<string, CapturedHandler>();
const capturedKeys = new Set<string>();

function makeCapturingApp(): CapturingApp {
  const recordRoute =
    (method: string): CaptureFn =>
    (p, handler) => {
      const key = `${method} ${p}`;
      captured.set(key, handler);
      capturedKeys.add(key);
    };
  return {
    get: recordRoute("GET"),
    post: recordRoute("POST"),
    patch: recordRoute("PATCH"),
    delete: recordRoute("DELETE"),
    put: recordRoute("PUT"),
  };
}

function captureAllRoutes(): void {
  const fakeApp = makeCapturingApp();
  // Single boundary cast through `unknown` — required because our captured
  // mock implements only the five method handlers we care about, not the
  // full Express surface. Canonical mock-bridging pattern, NOT a typing
  // escape hatch (no `as any` is used anywhere in this file).
  registerAdviserRoutes(fakeApp as unknown as Express);
  registerClientRoutes(fakeApp as unknown as Express);
}

type MockResponse = {
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  send: (body: unknown) => MockResponse;
};
type MockResult = { statusCode: number; body: unknown };

function makeMockReqRes(opts: {
  token: string;
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
}): { req: Request; res: MockResponse; result: MockResult } {
  const result: MockResult = { statusCode: 200, body: undefined };
  const req = {
    headers: { authorization: `Bearer ${opts.token}` },
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    path: "",
    method: "POST",
    ip: "127.0.0.1",
  } as unknown as Request;
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(b: unknown) {
      result.body = b;
      return this;
    },
    send(b: unknown) {
      result.body = b;
      return this;
    },
  };
  return { req, res, result };
}

function tokenFor(opts: {
  userId: number;
  username: string;
  email: string;
  role: "client" | "adviser" | "admin";
}): string {
  return signToken({
    userId: opts.userId,
    username: opts.username,
    email: opts.email,
    role: opts.role,
  });
}

// Returns true iff a POST handler is registered for any path that matches
// `/api/adviser/advice-records` AS A CREATE (i.e. NOT the
// `/:id/transition` sub-route). Used by assertion #1 to prove that today
// no non-adviser path even exists to leak through.
function findAdviceRecordCreateRoute(): string | undefined {
  for (const k of capturedKeys) {
    if (!k.startsWith("POST ")) continue;
    const path = k.slice("POST ".length);
    if (
      path === "/api/adviser/advice-records" ||
      path === "/api/adviser/advice-records/"
    ) {
      return path;
    }
  }
  return undefined;
}

// Same approach for the recommendations write surface (assertion #6).
function findRecommendationsRoute(): string | undefined {
  for (const k of capturedKeys) {
    if (!k.startsWith("POST ")) continue;
    const path = k.slice("POST ".length).toLowerCase();
    if (path.includes("recommendation")) {
      return k.slice("POST ".length);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests — labels are byte-identical to CANONICAL_ORDER.
// ---------------------------------------------------------------------------

// non-adviser cannot create advice record
//
// Two-mode assertion:
//   (a) If no POST advice-records create route is registered, that route-
//       absence IS the proof — no caller of any role can create one via
//       the public API today. PASS.
//   (b) If the route exists (e.g. once #98 lands a planner-UI write path),
//       call it with a CLIENT token and an ADMIN token; both must be
//       rejected (403) AND no advice_records row must appear with our
//       sentinel client id.
async function testNonAdviserCannotCreate(opts: {
  clientUserId: number;
  adminUserId: number;
}): Promise<void> {
  const NAME = "non-adviser cannot create advice record";
  const path = findAdviceRecordCreateRoute();
  if (!path) {
    pass(
      NAME,
      `no POST advice-records create route registered (proven via captured route table; ${capturedKeys.size} routes scanned)`,
    );
    return;
  }
  const handler = captured.get(`POST ${path}`);
  if (!handler) {
    fail(NAME, `internal: route handler for POST ${path} not captured`);
    return;
  }

  // Snapshot: how many advice records exist for this client RIGHT NOW.
  const [before] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(adviceRecords)
    .where(eq(adviceRecords.clientId, opts.clientUserId));

  for (const role of ["client", "admin"] as const) {
    const userId = role === "client" ? opts.clientUserId : opts.adminUserId;
    const username = role === "client" ? CLIENT_USERNAME : ADMIN_USERNAME;
    const token = tokenFor({
      userId,
      username,
      email: `planner-${role}@test.invalid`,
      role,
    });
    const { req, res, result } = makeMockReqRes({
      token,
      body: { clientId: opts.clientUserId },
    });
    await handler(req, res);
    if (result.statusCode !== 403) {
      fail(NAME, `${role} POST ${path} returned ${result.statusCode}; expected 403`);
      return;
    }
  }

  const [after] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(adviceRecords)
    .where(eq(adviceRecords.clientId, opts.clientUserId));
  if (after.c !== before.c) {
    fail(NAME, `advice_records count drifted ${before.c} -> ${after.c} for test client`);
    return;
  }
  pass(NAME, `client+admin POST ${path} both returned 403; no advice_records row written`);
}

// adviser blocked from another adviser's record
async function testCrossAdviserBlocked(opts: {
  otherAdviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "adviser blocked from another adviser's record";
  await ensureUnlinked(opts.otherAdviserUserId, opts.clientUserId);

  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }
  const token = tokenFor({
    userId: opts.otherAdviserUserId,
    username: OTHER_ADVISER_USERNAME,
    email: "planner-other-adviser@test.invalid",
    role: "adviser",
  });
  const labelMarker = "planner-cross-adviser-should-not-create";
  const { req, res, result } = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "income",
      label: labelMarker,
    },
  });
  await handler(req, res);

  const leaked = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelMarker));
  for (const r of leaked) {
    if (!created.objectiveIds.includes(r.id)) created.objectiveIds.push(r.id);
  }

  const rejected = result.statusCode === 403 || result.statusCode === 404;
  if (rejected && leaked.length === 0) {
    pass(NAME, `cross-adviser POST returned ${result.statusCode}; no row created`);
  } else {
    fail(
      NAME,
      `expected 403/404 + zero leaks; got status=${result.statusCode}, leaked=${leaked.length}`,
    );
  }
}

// client cannot write to advice tables (requireRole at route layer)
async function testClientCannotWrite(opts: {
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "client cannot write to advice tables";
  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }
  const token = tokenFor({
    userId: opts.clientUserId,
    username: CLIENT_USERNAME,
    email: "planner-client@test.invalid",
    role: "client",
  });
  const labelMarker = "planner-client-should-not-create";
  const { req, res, result } = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "income",
      label: labelMarker,
    },
  });
  await handler(req, res);

  const leaked = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelMarker));
  for (const r of leaked) {
    if (!created.objectiveIds.includes(r.id)) created.objectiveIds.push(r.id);
  }

  if (result.statusCode === 403 && leaked.length === 0) {
    pass(NAME, `client POST returned 403 from requireRole('adviser'); no row created`);
  } else {
    fail(
      NAME,
      `expected 403 + zero leaks; got status=${result.statusCode}, leaked=${leaked.length}`,
    );
  }
}

// admin cannot mutate advice record (requireRole('adviser') is exclusive,
// NOT a "client OR admin" allowlist).
async function testAdminCannotMutate(opts: {
  adminUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "admin cannot mutate advice record";
  const handler = captured.get("POST /api/adviser/advice-records/:id/transition");
  if (!handler) {
    fail(NAME, "internal: transition route not captured");
    return;
  }
  const token = tokenFor({
    userId: opts.adminUserId,
    username: ADMIN_USERNAME,
    email: "planner-admin@test.invalid",
    role: "admin",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
    body: { newStatus: "issued" },
  });
  await handler(req, res);

  const [reloaded] = await db
    .select({ status: adviceRecords.status })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  if (result.statusCode === 403 && reloaded?.status !== "issued") {
    pass(
      NAME,
      `admin transition returned 403; status remained '${reloaded?.status}' (no admin-bypass)`,
    );
  } else {
    fail(
      NAME,
      `expected 403 + unchanged status; got status=${result.statusCode}, reloaded='${reloaded?.status}'`,
    );
  }
}

// objectives blocked during review_pending
//
// Will FAIL until task #96 lands the assertNotReviewPending guard inside
// createClientObjective(). The spec is explicit about leaving it in (not
// commented out) so the gap is loud and visible — when #96 merges, the
// assertion flips green with no script edit needed.
async function testObjectivesBlockedDuringReviewPending(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "objectives blocked during review_pending";
  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }
  await setAdviceStatus(opts.adviceRecordId, "review_pending");
  try {
    const token = tokenFor({
      userId: opts.adviserUserId,
      username: ADVISER_USERNAME,
      email: "planner-adviser@test.invalid",
      role: "adviser",
    });
    const labelMarker = "planner-review-pending-objective-should-block";
    const { req, res, result } = makeMockReqRes({
      token,
      body: {
        clientId: opts.clientUserId,
        adviceRecordId: opts.adviceRecordId,
        objectiveType: "income",
        label: labelMarker,
      },
    });
    await handler(req, res);

    const leaked = await db
      .select({ id: clientObjectives.id })
      .from(clientObjectives)
      .where(eq(clientObjectives.label, labelMarker));
    for (const r of leaked) {
      if (!created.objectiveIds.includes(r.id)) created.objectiveIds.push(r.id);
    }

    if (result.statusCode === 423 && leaked.length === 0) {
      pass(NAME, `route returned 423 Locked during review_pending; no row created`);
    } else {
      fail(
        NAME,
        `expected 423 + zero leaks; got status=${result.statusCode}, leaked=${leaked.length} ` +
          `(gap: assertNotReviewPending guard from #96 not in createClientObjective)`,
      );
    }
  } finally {
    await setAdviceStatus(opts.adviceRecordId, "draft");
  }
}

// recommendations blocked during review_pending
//
// Two-mode (route-absence OR live-block). If the recommendations write
// route is not registered, recommendations are vacuously blocked — no
// caller can write one regardless of advice status. PASS via route
// absence. If the route appears (#98 lands), call it during
// review_pending and require 423.
async function testRecommendationsBlockedDuringReviewPending(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "recommendations blocked during review_pending";
  const path = findRecommendationsRoute();
  if (!path) {
    pass(
      NAME,
      `no recommendations write route registered — surface is closed (proven via captured route table; ${capturedKeys.size} routes scanned)`,
    );
    return;
  }
  const handler = captured.get(`POST ${path}`);
  if (!handler) {
    fail(NAME, `internal: handler for POST ${path} not captured`);
    return;
  }
  await setAdviceStatus(opts.adviceRecordId, "review_pending");
  try {
    const token = tokenFor({
      userId: opts.adviserUserId,
      username: ADVISER_USERNAME,
      email: "planner-adviser@test.invalid",
      role: "adviser",
    });
    const { req, res, result } = makeMockReqRes({
      token,
      body: {
        clientId: opts.clientUserId,
        adviceRecordId: opts.adviceRecordId,
      },
    });
    await handler(req, res);
    if (result.statusCode === 423) {
      pass(NAME, `POST ${path} returned 423 during review_pending`);
    } else {
      fail(
        NAME,
        `expected 423 from POST ${path} during review_pending; got ${result.statusCode}`,
      );
    }
  } finally {
    await setAdviceStatus(opts.adviceRecordId, "draft");
  }
}

// notes allowed during review_pending — append-only design intentionally
// permits notes during review (a reviewer's commentary IS part of the
// review). This is the inverse of the objectives lock and exists to prove
// the lock isn't over-broad.
async function testNotesAllowedDuringReviewPending(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "notes allowed during review_pending";
  const handler = captured.get("POST /api/adviser/client-notes");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-notes not captured");
    return;
  }
  await setAdviceStatus(opts.adviceRecordId, "review_pending");
  try {
    const token = tokenFor({
      userId: opts.adviserUserId,
      username: ADVISER_USERNAME,
      email: "planner-adviser@test.invalid",
      role: "adviser",
    });
    const bodyText = "planner-review-pending-note-should-be-allowed";
    const { req, res, result } = makeMockReqRes({
      token,
      body: {
        clientUserId: opts.clientUserId,
        body: bodyText,
        adviceRecordId: opts.adviceRecordId,
      },
    });
    await handler(req, res);

    const written = await db
      .select({ id: adviserNotes.id })
      .from(adviserNotes)
      .where(eq(adviserNotes.body, bodyText));
    for (const r of written) {
      if (!created.noteIds.includes(r.id)) created.noteIds.push(r.id);
    }

    if (result.statusCode === 200 && written.length === 1) {
      pass(NAME, `note POST during review_pending returned 200; 1 row written`);
    } else {
      fail(
        NAME,
        `expected 200 + 1 row; got status=${result.statusCode}, written=${written.length}`,
      );
    }
  } finally {
    await setAdviceStatus(opts.adviceRecordId, "draft");
  }
}

// objective POST succeeds on active record
//
// Positive control for the three rejection tests above — proves the
// rejections come from the guards, not from a generic breakage of the
// route. "Active" here means "not review_pending and not terminal":
// the planner state machine for adviceRecords is
//   draft | review_pending | issued | accepted | declined | superseded
// — `draft` is the canonical writable / active editing state. We set
// the status to `draft` EXPLICITLY before the assertion so the
// precondition is unambiguous and not order-dependent on prior tests.
async function testObjectivePostSucceeds(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "objective POST succeeds on active record";
  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }
  // Explicit precondition: advice record is in the active editing state.
  await setAdviceStatus(opts.adviceRecordId, "draft");
  const [precond] = await db
    .select({ status: adviceRecords.status })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId));
  if (precond?.status !== "draft") {
    fail(NAME, `precondition setup failed: expected status='draft', got '${precond?.status}'`);
    return;
  }

  const token = tokenFor({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "planner-adviser@test.invalid",
    role: "adviser",
  });
  const labelMarker = "planner-active-record-objective-should-succeed";
  const { req, res, result } = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "retirement",
      label: labelMarker,
    },
  });
  await handler(req, res);

  const written = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelMarker));
  for (const r of written) {
    if (!created.objectiveIds.includes(r.id)) created.objectiveIds.push(r.id);
  }

  if (result.statusCode === 200 && written.length === 1) {
    pass(NAME, `objective POST on advice record (status='draft') returned 200; 1 row written`);
  } else {
    fail(
      NAME,
      `expected 200 + 1 row; got status=${result.statusCode}, written=${written.length}`,
    );
  }
}

// objective write creates version snapshot atomically
//
// This is the central planner-write invariant: every objective POST that
// mutates the advice plan MUST snapshot the parent advice record into
// adviceRecordVersions inside the same transaction so the immutable
// version chain stays complete.
//
// We exercise the actual objective-write route (POST /api/adviser/client-
// objectives) — NOT the transition route, which is a different surface —
// and assert two things together as a single operation boundary:
//   (a) the objective row appears
//   (b) adviceRecordVersions count increments by exactly one
// If (a) happened without (b), the snapshot path is missing and atomicity
// is broken — we FAIL loudly with the explicit gap. If neither happened,
// the route is broken upstream. If both happened, the production write
// path is calling writeAdviceWithVersioning correctly.
//
// Today this FAILs because no objective-write hook calls the versioning
// helper; that's the gap #98 closes. The assertion flips green
// automatically the moment #98 wires the snapshot call.
async function testObjectiveWriteCreatesSnapshot(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "objective write creates version snapshot atomically";
  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }

  const [versionsBefore] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));

  const token = tokenFor({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "planner-adviser@test.invalid",
    role: "adviser",
  });
  const labelMarker = "planner-atomicity-objective-should-snapshot";
  const { req, res, result } = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "income",
      label: labelMarker,
    },
  });
  await handler(req, res);

  // Track everything we may have inserted via the handler so cleanup
  // catches both the objective row and any snapshot row.
  await trackHandlerSideEffects({
    clientUserIds: [opts.clientUserId],
    adviceRecordIds: [opts.adviceRecordId],
  });

  const objectiveRows = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelMarker));
  const objectiveWritten = objectiveRows.length === 1;

  const [versionsAfter] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));
  const snapshotWritten = versionsAfter.c === versionsBefore.c + 1;

  const ok = result.statusCode === 200 && objectiveWritten && snapshotWritten;
  if (ok) {
    pass(
      NAME,
      `objective POST wrote 1 client_objectives row AND 1 new adviceRecordVersions row in same operation`,
    );
  } else {
    fail(
      NAME,
      `expected objective row + snapshot row in same op; got status=${result.statusCode}, ` +
        `objectiveWritten=${objectiveWritten}, versions=${versionsBefore.c}->${versionsAfter.c} ` +
        `(gap: createClientObjective from #98 not yet calling writeAdviceWithVersioning)`,
    );
  }
}

// PUT on adviserNotes rejected — append-only enforced by the absence of
// any PUT route that mentions notes.
function testPutOnAdviserNotesRejected(): void {
  const NAME = "PUT on adviserNotes rejected — append-only enforced";
  const offenders = Array.from(capturedKeys).filter(
    (k) => k.startsWith("PUT ") && k.toLowerCase().includes("note"),
  );
  if (offenders.length === 0) {
    pass(
      NAME,
      `no PUT route mentioning 'note' is registered (checked ${capturedKeys.size} routes)`,
    );
  } else {
    fail(
      NAME,
      `unexpected PUT route(s) mentioning 'note' registered: ${offenders.join(", ")}`,
    );
  }
}

// DELETE on adviserNotes rejected — same pattern.
function testDeleteOnAdviserNotesRejected(): void {
  const NAME = "DELETE on adviserNotes rejected";
  const offenders = Array.from(capturedKeys).filter(
    (k) => k.startsWith("DELETE ") && k.toLowerCase().includes("note"),
  );
  if (offenders.length === 0) {
    pass(
      NAME,
      `no DELETE route mentioning 'note' is registered (checked ${capturedKeys.size} routes)`,
    );
  } else {
    fail(
      NAME,
      `unexpected DELETE route(s) mentioning 'note' registered: ${offenders.join(", ")}`,
    );
  }
}

// adviserNotes has no updatedAt column — append-only at the schema layer
// too, not just the route layer. Queries information_schema directly so
// it survives any future Drizzle introspection refactor.
async function testAdviserNotesNoUpdatedAt(): Promise<void> {
  const NAME = "adviserNotes has no updatedAt column";
  const rows = await db.execute(
    sql`select column_name from information_schema.columns where table_name = 'adviser_notes' and column_name = 'updated_at'`,
  );
  // pg returns { rows: [...] }; defend against either driver shape.
  const list: unknown[] = Array.isArray((rows as { rows?: unknown[] }).rows)
    ? ((rows as { rows: unknown[] }).rows as unknown[])
    : (rows as unknown as unknown[]);
  if (list.length === 0) {
    pass(NAME, `information_schema.columns confirms adviser_notes has no updated_at column`);
  } else {
    fail(NAME, `adviser_notes unexpectedly has an updated_at column — append-only contract violated`);
  }
}

// previousNoteId chain is traversable — proves edit-via-supersession keeps
// prior versions reachable rather than mutating in place.
async function testPreviousNoteIdChainTraversable(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "previousNoteId chain is traversable";
  const handler = captured.get("POST /api/adviser/client-notes");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-notes not captured");
    return;
  }
  const token = tokenFor({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "planner-adviser@test.invalid",
    role: "adviser",
  });

  const v1Body = "planner-chain-v1";
  {
    const { req, res } = makeMockReqRes({
      token,
      body: { clientUserId: opts.clientUserId, body: v1Body, adviceRecordId: opts.adviceRecordId },
    });
    await handler(req, res);
  }
  const [v1] = await db
    .select({ id: adviserNotes.id })
    .from(adviserNotes)
    .where(eq(adviserNotes.body, v1Body));
  if (v1 && !created.noteIds.includes(v1.id)) created.noteIds.push(v1.id);

  if (!v1) {
    fail(NAME, `failed to write v1 of note chain`);
    return;
  }

  const v2Body = "planner-chain-v2";
  {
    const { req, res } = makeMockReqRes({
      token,
      body: {
        clientUserId: opts.clientUserId,
        body: v2Body,
        adviceRecordId: opts.adviceRecordId,
        previousNoteId: v1.id,
      },
    });
    await handler(req, res);
  }
  const [v2] = await db
    .select({ id: adviserNotes.id, previousNoteId: adviserNotes.previousNoteId })
    .from(adviserNotes)
    .where(eq(adviserNotes.body, v2Body));
  if (v2 && !created.noteIds.includes(v2.id)) created.noteIds.push(v2.id);

  if (v2 && v2.previousNoteId === v1.id) {
    pass(NAME, `chain v1.id=${v1.id} -> v2.previousNoteId=${v2.previousNoteId} traversable`);
  } else {
    fail(
      NAME,
      `expected v2.previousNoteId=${v1.id}; got ${v2?.previousNoteId ?? "undefined"}`,
    );
  }
}

// objective supersession sets supersededAt on prior row
//
// Two-stage assertion that fails LOUDLY against current state:
//   stage 1 — assert clientObjectives has a `superseded_at` column
//   stage 2 — write v1 + v2 (with v2.supersedes = v1.id), assert v1.superseded_at
//             becomes non-null after the v2 write
// Today stage 1 fails (column doesn't exist), so the assertion fails and
// the script exits non-zero — making the structural gap impossible to miss.
// When #98 lands the schema migration AND the supersession write path,
// stage 2 takes over automatically.
async function testObjectiveSupersession(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "objective supersession sets supersededAt on prior row";
  const colRows = await db.execute(
    sql`select column_name from information_schema.columns where table_name = 'client_objectives' and column_name = 'superseded_at'`,
  );
  const cols: unknown[] = Array.isArray((colRows as { rows?: unknown[] }).rows)
    ? ((colRows as { rows: unknown[] }).rows as unknown[])
    : (colRows as unknown as unknown[]);

  if (cols.length === 0) {
    fail(
      NAME,
      `client_objectives.superseded_at column does not exist — supersession contract has no schema support yet ` +
        `(gap: #98 schema change required to add superseded_at + supersedes_id columns)`,
    );
    return;
  }

  // Stage 2 — schema is present; exercise the supersession write path.
  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: POST /api/adviser/client-objectives not captured");
    return;
  }
  const token = tokenFor({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "planner-adviser@test.invalid",
    role: "adviser",
  });
  const labelV1 = "planner-supersede-v1";
  {
    const { req, res } = makeMockReqRes({
      token,
      body: {
        clientId: opts.clientUserId,
        adviceRecordId: opts.adviceRecordId,
        objectiveType: "retirement",
        label: labelV1,
      },
    });
    await handler(req, res);
  }
  const [v1] = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelV1));
  if (v1 && !created.objectiveIds.includes(v1.id)) created.objectiveIds.push(v1.id);
  if (!v1) {
    fail(NAME, `failed to write v1 objective for supersession test`);
    return;
  }

  const labelV2 = "planner-supersede-v2";
  {
    const { req, res } = makeMockReqRes({
      token,
      body: {
        clientId: opts.clientUserId,
        adviceRecordId: opts.adviceRecordId,
        objectiveType: "retirement",
        label: labelV2,
        supersedes: v1.id,
      },
    });
    await handler(req, res);
  }
  const [v2] = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, labelV2));
  if (v2 && !created.objectiveIds.includes(v2.id)) created.objectiveIds.push(v2.id);

  // Re-read v1 via raw SQL so we don't depend on Drizzle exposing
  // superseded_at at type-time before #98 lands.
  const reloadV1 = await db.execute(
    sql`select superseded_at from client_objectives where id = ${v1.id}`,
  );
  const reloadList: Array<{ superseded_at: unknown }> = Array.isArray(
    (reloadV1 as { rows?: unknown[] }).rows,
  )
    ? ((reloadV1 as { rows: Array<{ superseded_at: unknown }> }).rows)
    : (reloadV1 as unknown as Array<{ superseded_at: unknown }>);
  const supersededAt = reloadList[0]?.superseded_at;

  if (supersededAt != null) {
    pass(NAME, `v1 supersededAt populated after v2 supersedes=v1.id write`);
  } else {
    fail(
      NAME,
      `expected v1.supersededAt to be non-null after v2 supersession; got null ` +
        `(gap: supersession write path not yet implemented in createClientObjective)`,
    );
  }
}

// plan writes produce audit logs with before/after state — standardised
// audit shape from #95.
//
// Scope: ADVICE-RECORD-scoped query, with schema-correct ID type
// comparison. auditLogs.entityId is `text` on the schema (it has to
// accommodate string-typed identifiers like email-typed invite IDs), so
// every PK we compare against is coerced to string via String(...).
// We pull every audit row this adviser wrote against THIS advice
// record OR any of its child planner rows (objectives / notes /
// documents created during this run), then assert each row carries
// metadata.before + metadata.after.
//
// Will FAIL until #95's writeStructuredAuditLog helper is adopted by
// the planner routes — today the routes either don't audit at all or
// don't standardise the metadata shape.
async function testAuditLogsHaveBeforeAfter(opts: {
  adviserUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "plan writes produce audit logs with before/after state";

  // Schema-correct ID comparison: entityId is text on the schema, so we
  // build the comparison set as strings, including the parent advice
  // record id and every child planner row PK we tracked during this run.
  const adviceRecordEntityId: string = String(opts.adviceRecordId);
  const childPlannerEntityIds: string[] = [
    ...created.objectiveIds.map(String),
    ...created.noteIds.map(String),
    ...created.documentIds.map(String),
  ];
  const allScopedEntityIds: string[] = [adviceRecordEntityId, ...childPlannerEntityIds];

  if (childPlannerEntityIds.length === 0) {
    fail(NAME, "internal: no planner-child writes produced any tracked entity id");
    return;
  }

  const rows = await db
    .select({ id: auditLogs.id, metadata: auditLogs.metadata, action: auditLogs.action })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, opts.adviserUserId),
        inArray(auditLogs.entityId, allScopedEntityIds),
      ),
    );
  for (const r of rows) {
    if (!created.auditIds.includes(r.id)) created.auditIds.push(r.id);
  }

  function hasBeforeAfter(meta: unknown): boolean {
    if (meta == null || typeof meta !== "object") return false;
    const m = meta as Record<string, unknown>;
    return "before" in m && "after" in m;
  }

  if (rows.length === 0) {
    fail(
      NAME,
      `expected adviser ${opts.adviserUserId} planner writes to leave audit rows scoped to advice record ${adviceRecordEntityId} or its children (${childPlannerEntityIds.length} child PKs); got 0 ` +
        `(gap: planner routes may not be calling audit() at all)`,
    );
    return;
  }
  const withShape = rows.filter((r) => hasBeforeAfter(r.metadata));
  if (withShape.length === rows.length) {
    pass(
      NAME,
      `${withShape.length}/${rows.length} advice-record-scoped planner audit rows carry metadata.before + metadata.after`,
    );
  } else {
    fail(
      NAME,
      `expected every advice-record-scoped planner audit row to carry metadata.before + metadata.after; ` +
        `got ${withShape.length}/${rows.length} (gap: writeStructuredAuditLog from #95 not adopted by planner routes)`,
    );
  }
}

// ---------------------------------------------------------------------------
// SOA placeholder (Task #97).
// ---------------------------------------------------------------------------
// Per the original task #105 checklist, the SOA (Statement of Advice)
// transition assertion is intentionally OUT-OF-SCOPE for this script
// until task #97 lands the SOA generation surface. The block below is
// kept as a commented placeholder — and explicitly NOT registered in
// CANONICAL_ORDER — so a future contributor can flip it on by:
//   (a) appending its label to CANONICAL_ORDER
//   (b) uncommenting the function body and its call site in main()
// without re-deriving the spec.
//
// async function testSoaTransitionRequired(opts: {
//   adviserUserId: number;
//   adviceRecordId: number;
// }): Promise<void> {
//   const NAME = "SOA generation gates issued transition";
//   // TODO #97: assert POST /api/adviser/advice-records/:id/transition
//   // to status='issued' is rejected (424 Failed Dependency or similar)
//   // when no SOA artefact has been generated for the advice record;
//   // succeeds once a generated SOA exists.
// }
// ---------------------------------------------------------------------------

// no ledger entries created by planner writes — money-isolation.
//
// Scoping: the only ledger drift the planner could plausibly cause is
// against the userIds it touched. We snapshot count(*) of ledger_entries
// rows whose userId is one of our test users (the test client and the
// servicing adviser) BEFORE planner ops begin and re-snapshot AFTER.
// Schema note: ledger_entries does NOT have a referenceType/reference_id
// column today — the natural scoping field is userId — so a global count
// would be noisy in shared databases (every unrelated user write
// inflates it). Planner-user-scoped count is the precise test: any
// drift means a planner route posted a ledger entry against one of our
// test users, which the planner surface MUST NEVER do.
async function testNoLedgerDrift(opts: {
  beforeCount: number;
  scopedUserIds: number[];
}): Promise<void> {
  const NAME = "no ledger entries created by planner writes";
  const [after] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.userId, opts.scopedUserIds));
  if (after.c === opts.beforeCount) {
    pass(
      NAME,
      `ledger_entries scoped to userIds=[${opts.scopedUserIds.join(",")}] unchanged: before=${opts.beforeCount}, after=${after.c}`,
    );
  } else {
    fail(
      NAME,
      `ledger_entries drift for userIds=[${opts.scopedUserIds.join(",")}]: before=${opts.beforeCount}, after=${after.c} ` +
        `(planner surface must NEVER post ledger entries against planner users)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  captureAllRoutes();

  const clientUserId = await ensureUser({
    username: CLIENT_USERNAME,
    email: "planner-client@test.invalid",
    role: "client",
  });
  const adviserUserId = await ensureUser({
    username: ADVISER_USERNAME,
    email: "planner-adviser@test.invalid",
    role: "adviser",
  });
  const otherAdviserUserId = await ensureUser({
    username: OTHER_ADVISER_USERNAME,
    email: "planner-other-adviser@test.invalid",
    role: "adviser",
  });
  const adminUserId = await ensureUser({
    username: ADMIN_USERNAME,
    email: "planner-admin@test.invalid",
    role: "admin",
  });

  await ensureLink(adviserUserId, clientUserId);
  await ensureUnlinked(otherAdviserUserId, clientUserId);

  const adviceRecordId = await makeAdviceRecord(clientUserId);

  // Snapshot ledger BEFORE every planner write happens, scoped to the
  // userIds the planner could plausibly post against. The matching
  // assertion re-snapshots AFTER every test runs, so it covers ALL
  // writes performed by this script — including the transition-route
  // write inside testObjectiveWriteCreatesSnapshot.
  const ledgerScopedUserIds = [clientUserId, adviserUserId];
  const [ledgerBefore] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.userId, ledgerScopedUserIds));

  try {
    await testNonAdviserCannotCreate({ clientUserId, adminUserId });
    await testCrossAdviserBlocked({ otherAdviserUserId, clientUserId, adviceRecordId });
    await testClientCannotWrite({ clientUserId, adviceRecordId });
    await testAdminCannotMutate({ adminUserId, adviceRecordId });
    await testObjectivesBlockedDuringReviewPending({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });
    await testRecommendationsBlockedDuringReviewPending({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });
    await testNotesAllowedDuringReviewPending({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });
    await testObjectivePostSucceeds({ adviserUserId, clientUserId, adviceRecordId });
    await testObjectiveWriteCreatesSnapshot({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });
    testPutOnAdviserNotesRejected();
    testDeleteOnAdviserNotesRejected();
    await testAdviserNotesNoUpdatedAt();
    await testPreviousNoteIdChainTraversable({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });
    await testObjectiveSupersession({
      adviserUserId,
      clientUserId,
      adviceRecordId,
    });

    // Track any rows the route handlers wrote on our behalf so the audit
    // assertion can scope its query tightly AND so cleanup catches them.
    await trackHandlerSideEffects({
      clientUserIds: [clientUserId],
      adviceRecordIds: [adviceRecordId],
    });

    await testAuditLogsHaveBeforeAfter({ adviserUserId, adviceRecordId });
    await testNoLedgerDrift({
      beforeCount: ledgerBefore.c,
      scopedUserIds: ledgerScopedUserIds,
    });
  } finally {
    await cleanup().catch((e) => {
      console.error("cleanup failed:", e);
    });
  }

  console.log("");
  for (const name of CANONICAL_ORDER) {
    const r = results.get(name);
    if (!r) {
      console.log(`MISSING ${name} — assertion was not recorded`);
      continue;
    }
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`${tag} ${name} — ${r.details}`);
  }

  const failedCount = Array.from(results.values()).filter((r) => !r.passed).length;
  const missingCount = CANONICAL_ORDER.filter((n) => !results.has(n)).length;
  if (failedCount > 0 || missingCount > 0) {
    console.error(
      `\n${failedCount} fail(s), ${missingCount} missing assertion(s) in Planner Compliance roll-up.`,
    );
    process.exit(1);
  }

  console.log("\nALL PLANNER COMPLIANCE TESTS PASSED \u2705");
  process.exit(0);
}

main().catch((err) => {
  console.error("Planner compliance roll-up crashed:", err);
  process.exit(1);
});
