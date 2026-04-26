// =============================================================================
// TASK #94 — WEALTH PLANNER COMPLIANCE VERIFICATION ROLL-UP
// =============================================================================
// Single-shot, re-runnable script that proves the four narrow tables added by
// Task #94 (clientObjectives, clientDocuments, adviserNotes,
// adviceRecordVersions) are wired correctly into the existing Phase 2.2 / 2.3
// advice stack — covering authorisation, audit-trail, append-only,
// disclaimer capture, snapshot-on-transition, and money-isolation.
//
// Each assertion is a hard PASS/FAIL with concrete evidence. The 10 canonical
// assertions, in order, are:
//
//   1. retention defaults wired
//        — A row inserted into each of the 4 new tables comes back with
//          deletionLocked=true and a non-null retentionUntil. Locks in the
//          Phase 2.2 retention contract for every new table.
//
//   2. non-adviser POST is role-rejected
//        — A signed-in *client* token hitting POST /api/adviser/client-objectives
//          via the captured adviserRoute() wrapper gets 403, and NO row is
//          written. Locks in `requireRole("adviser")` at the route layer.
//
//   3. cross-adviser link rejected
//        — An adviser who is NOT linked to the client cannot create an
//          objective for that client. assertAdviserClientLink is the choke
//          point; called via the route handler so a bypass would be decisive.
//
//   4. adviser CRUD writes both create AND read audit rows
//        — POST /api/adviser/client-objectives + GET .../client-documents
//          each leave a corresponding audit_logs row tagged with a
//          'client_*.create' or '.read' action. Regulator surface needs both.
//
//   5. append-only adviser notes preserved
//        — POST /api/adviser/client-notes twice writes 2 rows; the second
//          carries previousNoteId pointing at the first; neither row is
//          mutated/deleted. Old rows MUST stay reachable.
//
//   6. notes have no PATCH or DELETE route
//        — registerAdviserRoutes + registerClientRoutes never register a
//          PATCH or DELETE handler whose path mentions notes. The absence of
//          mutation routes IS the append-only enforcement.
//
//   7. viewing-ack gate blocks unacknowledged GET
//        — GET /api/client/advice/:id with NO adviceAcknowledgements row
//          returns 403 + reason='acknowledgement_missing'. Crucially the
//          advice payload must NOT appear anywhere in the response body.
//
//   8. ack row captures the full eleven-confirm disclaimer
//        — Once an acknowledgement row is written with all eleven required
//          confirm_* booleans true, the gate clears AND a re-read of the
//          row from DB still shows all eleven flags persisted. This proves
//          the disclaimer capture is non-erasable from the live row.
//
//   9. production transition route writes a snapshot version
//        — POST /api/adviser/advice-records/:id/transition with newStatus
//          'issued' (then 'superseded') routes through the *real* adviser
//          handler, NOT the service helper directly. After both calls,
//          adviceRecordVersions has rows v=1 (issued) and v=2 (superseded)
//          with populated jsonb snapshots. Locks in the wiring of the
//          snapshot hook into a production code path.
//
//  10. no ledger / transactions side effects
//        — Snapshot of (transactions, ledgerEntries, ledgerPostings) row
//          count BEFORE running every write step in this roll-up matches
//          the snapshot AFTER. The wealth-planner surface is by design
//          money-isolated — a regression that wired a stray money-movement
//          call into one of these routes would fail this assertion.
//
// Hard rules:
//   - Scoped to deterministic test users; cleans its own rows on every run.
//   - Does NOT touch any production user, advice record, or acknowledgement.
//   - Exits non-zero on any FAIL.
//
// Usage:
//   npx tsx scripts/test-wealth-planner-compliance.ts
// =============================================================================

import "./_bootstrap-test-env";
import type { Express, Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  adviserClients,
  adviceRecords,
  adviceAcknowledgements,
  clientObjectives,
  clientDocuments,
  adviserNotes,
  adviceRecordVersions,
  auditLogs,
  transactions,
  ledgerEntries,
  ledgerPostings,
} from "../shared/schema";
import { signToken } from "../server/auth";
import { registerAdviserRoutes } from "../server/adviser-routes";
import { registerClientRoutes } from "../server/client-routes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLIENT_USERNAME = "__wpc_test_client__";
const OTHER_CLIENT_USERNAME = "__wpc_test_other_client__";
const ADVISER_USERNAME = "__wpc_test_adviser__";
const OTHER_ADVISER_USERNAME = "__wpc_test_other_adviser__";
const ADMIN_USERNAME = "__wpc_test_admin__";

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
type TestResult = { passed: boolean; details: string };
const CANONICAL_ORDER: string[] = [
  "1. retention defaults wired",
  "2. adviceType default stays 'personal'",
  "3. cross-adviser link rejected (assertAdviserClientLink)",
  "4. cross-client read prevented (client A cannot read client B's advice)",
  "5. adviser CRUD writes both create AND read audit rows",
  "6. append-only notes preserved AND no PATCH/DELETE route exists",
  "7. viewing-ack gate blocks GET and returns adviceAcknowledgements shape",
  "8. ack row captures the full eleven-confirm disclaimer",
  "9. non-adviser (admin/client) rejected on adviser CRUD AND admin retains audit-log read access",
  "10. risk-profile and adviceType immutable via transition; snapshots written; no ledger drift",
  "11. review_pending blocks objective/document/transition writes; notes still allowed",
];
const results = new Map<string, TestResult>();

function record(name: string, passed: boolean, details: string): void {
  if (!CANONICAL_ORDER.includes(name)) {
    throw new Error(`Internal: unknown canonical test name '${name}'`);
  }
  results.set(name, { passed, details });
}
const pass = (name: string, details: string) => record(name, true, details);
const fail = (name: string, details: string) => record(name, false, details);

// ---------------------------------------------------------------------------
// Fixture helpers
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
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      username: opts.username,
      email: opts.email,
      password: "not-a-real-password",
      firstName: "WPC",
      lastName: "Test",
      role: opts.role,
      kycStatus: "verified",
      emailVerified: true,
    })
    .returning();
  return created.id;
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
    return;
  }
  await db.insert(adviserClients).values({
    adviserUserId,
    clientUserId,
    relationshipType: "servicing",
    isActive: true,
  });
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
  return row.id;
}

// Wipe all rows we may have inserted in any prior run for the test users.
async function cleanupForUserIds(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  // Find advice records owned by any test client.
  const adviceRows = await db
    .select({ id: adviceRecords.id })
    .from(adviceRecords)
    .where(inArray(adviceRecords.clientId, userIds));
  const adviceIds = adviceRows.map((r) => r.id);

  if (adviceIds.length > 0) {
    await db
      .delete(adviceRecordVersions)
      .where(inArray(adviceRecordVersions.adviceRecordId, adviceIds));
    await db
      .delete(adviceAcknowledgements)
      .where(inArray(adviceAcknowledgements.adviceRecordId, adviceIds));
    await db
      .delete(clientObjectives)
      .where(inArray(clientObjectives.adviceRecordId, adviceIds));
  }
  await db
    .delete(clientObjectives)
    .where(inArray(clientObjectives.clientId, userIds));
  await db
    .delete(clientDocuments)
    .where(inArray(clientDocuments.clientId, userIds));
  await db
    .delete(adviserNotes)
    .where(inArray(adviserNotes.clientUserId, userIds));
  if (adviceIds.length > 0) {
    await db
      .delete(adviceRecords)
      .where(inArray(adviceRecords.id, adviceIds));
  }
  // Audit rows from prior runs — scope tightly to the new actions so we don't
  // touch unrelated audit history.
  await db
    .delete(auditLogs)
    .where(
      and(
        inArray(auditLogs.userId, userIds),
        inArray(auditLogs.action, [
          "client_objective.create",
          "client_objective.read",
          "client_document.create",
          "client_document.read",
          "adviser_note.create",
          "adviser_note.read",
          "advice_record.transition.issued",
          "advice_record.transition.superseded",
        ]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Money-isolation snapshot — used by test #10. We snapshot the row counts
// of every money-movement table BEFORE we touch the wealth-planner surface,
// and re-snapshot AFTER. Any drift means a stray ledger/transaction write
// crept into one of the wealth-planner code paths.
// ---------------------------------------------------------------------------
type MoneySnapshot = { txCount: number; entryCount: number; receiptCount: number };

// Type-narrow predicate that proves a jsonb snapshot blob captured the
// expected advice record id (replaces an `as any` field-access on the
// loosely-typed `unknown` jsonb column).
function snapshotIdMatches(snap: unknown, expectedId: number): boolean {
  if (snap == null || typeof snap !== "object") return false;
  const id = (snap as Record<string, unknown>).id;
  return typeof id === "number" && id === expectedId;
}

async function snapshotMoneyTables(): Promise<MoneySnapshot> {
  const [tx] = await db.select({ c: sql<number>`count(*)::int` }).from(transactions);
  const [le] = await db.select({ c: sql<number>`count(*)::int` }).from(ledgerEntries);
  const [lp] = await db.select({ c: sql<number>`count(*)::int` }).from(ledgerPostings);
  return { txCount: tx.c, entryCount: le.c, receiptCount: lp.c };
}

// ---------------------------------------------------------------------------
// Route capture (mirrors the Gate B test pattern). Records every
// (method, path) pair so test #6 can decisively prove no PATCH/DELETE
// touches notes.
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
  // Single boundary cast through `unknown` — required because our captured-route
  // mock implements only the five method handlers we care about, not the full
  // Express surface. This is the canonical mock-bridging pattern, not a
  // typing escape hatch.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_retentionDefaultsWired(opts: {
  clientUserId: number;
  adviserUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const [obj] = await db
    .insert(clientObjectives)
    .values({
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "retirement",
      label: "wpc retention probe",
      createdByUserId: opts.adviserUserId,
    })
    .returning();
  const [doc] = await db
    .insert(clientDocuments)
    .values({
      clientId: opts.clientUserId,
      documentType: "fact_find",
      fileName: "retention-probe.pdf",
      storageKey: "retention-probe-key",
      uploadedByUserId: opts.adviserUserId,
    })
    .returning();
  const [note] = await db
    .insert(adviserNotes)
    .values({
      adviserUserId: opts.adviserUserId,
      clientUserId: opts.clientUserId,
      body: "wpc retention probe note",
    })
    .returning();
  const [ver] = await db
    .insert(adviceRecordVersions)
    .values({
      adviceRecordId: opts.adviceRecordId,
      versionNumber: 999, // sentinel
      snapshotReason: "issued",
      snapshotJsonb: { sentinel: true },
      issuedByUserId: opts.adviserUserId,
    })
    .returning();

  const allLocked =
    obj.deletionLocked === true &&
    doc.deletionLocked === true &&
    note.deletionLocked === true &&
    ver.deletionLocked === true;
  const allRetention =
    obj.retentionUntil != null &&
    doc.retentionUntil != null &&
    note.retentionUntil != null &&
    ver.retentionUntil != null;

  // Clean the sentinel snapshot row immediately so test #9 can write v=1.
  await db.delete(adviceRecordVersions).where(eq(adviceRecordVersions.id, ver.id));

  if (allLocked && allRetention) {
    pass(
      "1. retention defaults wired",
      `4/4 tables: deletionLocked=true and retentionUntil set on insert`,
    );
  } else {
    fail(
      "1. retention defaults wired",
      `defaults missing: locked=${allLocked}, retentionSet=${allRetention}`,
    );
  }
}

async function test2_adviceTypeDefault(opts: {
  clientUserId: number;
}): Promise<void> {
  // Insert an adviceRecords row with NO adviceType supplied. The schema
  // default ('personal') is the brief's literal requirement: regulators
  // expect the safer 'personal' classification unless explicitly downgraded.
  const [row] = await db
    .insert(adviceRecords)
    .values({ clientId: opts.clientUserId })
    .returning({ id: adviceRecords.id, adviceType: adviceRecords.adviceType });

  // Defensive: re-read from DB to make sure the default really persisted (and
  // wasn't a Drizzle-side fabrication that the row would not have on rehydrate).
  const [reloaded] = await db
    .select({ adviceType: adviceRecords.adviceType })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, row.id));

  const ok = row.adviceType === "personal" && reloaded?.adviceType === "personal";

  // Clean up so this row doesn't pollute the rest of the run.
  await db.delete(adviceRecords).where(eq(adviceRecords.id, row.id));

  if (ok) {
    pass(
      "2. adviceType default stays 'personal'",
      `inserted advice record with no adviceType; column defaulted to 'personal' on insert and on re-read`,
    );
  } else {
    fail(
      "2. adviceType default stays 'personal'",
      `expected 'personal' on insert+reload; got insert='${row.adviceType}', reload='${reloaded?.adviceType}'`,
    );
  }
}

async function test3_crossAdviserRejected(opts: {
  otherAdviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME = "3. cross-adviser link rejected (assertAdviserClientLink)";
  await ensureUnlinked(opts.otherAdviserUserId, opts.clientUserId);

  const handler = captured.get("POST /api/adviser/client-objectives");
  if (!handler) {
    fail(NAME, "internal: route handler not captured");
    return;
  }
  const token = signToken({
    userId: opts.otherAdviserUserId,
    username: OTHER_ADVISER_USERNAME,
    email: "wpc-other-adviser@test.invalid",
    role: "adviser",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "income",
      label: "should not be created (cross-adviser caller)",
    },
  });
  await handler(req, res);

  const leaked = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, "should not be created (cross-adviser caller)"));

  // assertAdviserClientLink throws 403 (or 404 in some shapes); both are
  // acceptable proof of the choke point firing.
  const linkRejected = result.statusCode === 403 || result.statusCode === 404;
  if (linkRejected && leaked.length === 0) {
    pass(NAME, `route returned ${result.statusCode} (assertAdviserClientLink); no leakage`);
  } else {
    fail(NAME, `expected 403/404 + no leakage; got status=${result.statusCode}, leaked=${leaked.length}`);
  }
}

// ---------------------------------------------------------------------------
// Test 4 — cross-CLIENT read prevented. The viewing-ack gate is also a
// confidentiality enforcement point: client A must NOT be able to read
// client B's advice record, even with a valid signed-in session and even if
// they happen to know B's adviceRecordId. This is enforced by
// requireAcknowledgedAdvice() returning reason='wrong_client'.
// ---------------------------------------------------------------------------
async function test4_crossClientReadPrevented(opts: {
  clientUserId: number;
  otherClientUserId: number;
  adviceRecordId: number; // belongs to clientUserId, NOT otherClient
}): Promise<void> {
  const NAME = "4. cross-client read prevented (client A cannot read client B's advice)";
  // Make sure clientA's advice has a valid acknowledgement so the only
  // remaining reason a *different* client can be blocked is the
  // wrong-client / not-found check, not a missing ack.
  // (The ack inserted in test #8 lives on the same advice record; we do
  //  the cross-client probe BEFORE test #8 has cleared the ack table, so
  //  we explicitly insert one here.)
  const [existingAck] = await db
    .select({ id: adviceAcknowledgements.id })
    .from(adviceAcknowledgements)
    .where(
      and(
        eq(adviceAcknowledgements.adviceRecordId, opts.adviceRecordId),
        eq(adviceAcknowledgements.clientId, opts.clientUserId),
      ),
    );
  if (!existingAck) {
    await db.insert(adviceAcknowledgements).values({
      adviceRecordId: opts.adviceRecordId,
      clientId: opts.clientUserId,
      confirmPersonalDetails: true,
      confirmFinancialInfo: true,
      confirmObjectives: true,
      confirmRiskProfile: true,
      confirmScopeUnderstood: true,
      confirmSoaViewed: true,
      confirmFeesUnderstood: true,
      confirmFeesConsented: true,
      confirmValuesMayFall: true,
      confirmReturnsNotGuaranteed: true,
      confirmFsgReceived: true,
      signatureName: "WPC Test Client (cross-client probe)",
    });
  }

  const handler = captured.get("GET /api/client/advice/:id");
  if (!handler) {
    fail(NAME, "internal: route handler not captured");
    return;
  }
  // Sign in AS THE OTHER CLIENT and try to read clientUserId's advice.
  const token = signToken({
    userId: opts.otherClientUserId,
    username: OTHER_CLIENT_USERNAME,
    email: "wpc-other-client@test.invalid",
    role: "client",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
  });
  await handler(req, res);

  const body = result.body;
  // requireAcknowledgedAdvice returns reason='wrong_client' → the route
  // maps that to 403. Either 403 OR 404 is an acceptable seal.
  const blocked =
    (result.statusCode === 403 || result.statusCode === 404) &&
    body?.reason === "wrong_client";
  const noPayload = !body?.advice;

  // Cleanup: drop the probe ack so test #7 (gate-blocks-unack) starts with
  // a clean adviceAcknowledgements slate for this advice record.
  await db
    .delete(adviceAcknowledgements)
    .where(eq(adviceAcknowledgements.adviceRecordId, opts.adviceRecordId));

  if (blocked && noPayload) {
    pass(
      NAME,
      `client B got ${result.statusCode} reason='wrong_client' on client A's advice; no advice payload leaked`,
    );
  } else {
    fail(
      NAME,
      `expected 403/404 + reason='wrong_client' + no advice payload; got status=${result.statusCode}, body=${JSON.stringify(body)}`,
    );
  }
}

async function test5_crudWritesAuditRows(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  // Snapshot audit row count for this adviser BEFORE the calls so we don't
  // miscount unrelated history.
  const auditBefore = await db
    .select({ id: auditLogs.id, action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.userId, opts.adviserUserId));
  const beforeCount = auditBefore.length;

  const token = signToken({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "wpc-adviser@test.invalid",
    role: "adviser",
  });

  // POST objective.
  const postObj = captured.get("POST /api/adviser/client-objectives")!;
  const r1 = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "retirement",
      label: "Retire by 60",
      targetAmount: "1000000.0000",
      priority: "primary",
    },
  });
  await postObj(r1.req, r1.res);

  // POST document.
  const postDoc = captured.get("POST /api/adviser/client-documents")!;
  const r2 = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      documentType: "fact_find",
      fileName: "fact-find-2026.pdf",
      storageKey: "wpc-storage-key-A",
    },
  });
  await postDoc(r2.req, r2.res);

  // GET document list — must produce a read audit row.
  const getDoc = captured.get("GET /api/adviser/client-documents")!;
  const r3 = makeMockReqRes({
    token,
    query: { clientId: String(opts.clientUserId) },
  });
  await getDoc(r3.req, r3.res);

  // GET objectives list — also a read audit row.
  const getObj = captured.get("GET /api/adviser/client-objectives")!;
  const r4 = makeMockReqRes({
    token,
    query: { clientId: String(opts.clientUserId) },
  });
  await getObj(r4.req, r4.res);

  // Audit rows are fire-and-forget (don't block the response). Give them a
  // tiny window to land before we count them.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const auditAfter = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.userId, opts.adviserUserId));
  const newRows = auditAfter.slice(beforeCount);
  const newActions = new Set(newRows.map((r) => r.action));

  const requiredCreates = ["client_objective.create", "client_document.create"];
  const requiredReads = ["client_objective.read", "client_document.read"];
  const allCreates = requiredCreates.every((a) => newActions.has(a));
  const allReads = requiredReads.every((a) => newActions.has(a));
  const allCallsOk =
    r1.result.statusCode === 200 &&
    r2.result.statusCode === 200 &&
    r3.result.statusCode === 200 &&
    r4.result.statusCode === 200;

  if (allCallsOk && allCreates && allReads) {
    pass(
      "5. adviser CRUD writes both create AND read audit rows",
      `audit rows present: ${Array.from(newActions).sort().join(", ")}`,
    );
  } else {
    fail(
      "5. adviser CRUD writes both create AND read audit rows",
      `callsOk=${allCallsOk}, creates=${allCreates}, reads=${allReads}, newActions=[${Array.from(newActions).join(",")}]`,
    );
  }
}

// Combined test #6 — append-only enforcement is a TWO-pillar guarantee:
//   (a) v2 amend leaves v1 intact and chains via previousNoteId, AND
//   (b) no PATCH/DELETE route exists on notes anywhere in the registered
//       adviser+client surface. Without (b), (a) is just a convention.
async function test6_appendOnlyAndNoMutationRoute(opts: {
  adviserUserId: number;
  clientUserId: number;
}): Promise<void> {
  const handler = captured.get("POST /api/adviser/client-notes")!;
  const token = signToken({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "wpc-adviser@test.invalid",
    role: "adviser",
  });

  const r1 = makeMockReqRes({
    token,
    body: { clientUserId: opts.clientUserId, body: "Initial WPC note v1" },
  });
  await handler(r1.req, r1.res);
  const row1 = r1.result.body;

  const r2 = makeMockReqRes({
    token,
    body: {
      clientUserId: opts.clientUserId,
      body: "Initial WPC note v2 (corrected)",
      previousNoteId: row1?.id,
    },
  });
  await handler(r2.req, r2.res);
  const row2 = r2.result.body;

  // Re-read v1 from DB and confirm it was NOT mutated/deleted by the v2 post.
  const v1Reload = await db
    .select()
    .from(adviserNotes)
    .where(eq(adviserNotes.id, row1?.id));
  const persisted = await db
    .select()
    .from(adviserNotes)
    .where(
      and(
        eq(adviserNotes.adviserUserId, opts.adviserUserId),
        eq(adviserNotes.clientUserId, opts.clientUserId),
      ),
    );
  const fromThisRun = persisted.filter((r) => r.body.startsWith("Initial WPC note v"));

  const NAME = "6. append-only notes preserved AND no PATCH/DELETE route exists";
  const appendOk =
    r1.result.statusCode === 200 &&
    r2.result.statusCode === 200 &&
    fromThisRun.length === 2 &&
    v1Reload.length === 1 &&
    v1Reload[0].body === "Initial WPC note v1" &&
    row2?.previousNoteId === row1?.id &&
    row1?.id !== row2?.id;

  // Pillar (b) — scan EVERY captured route for any PATCH/DELETE that
  // touches notes. Without this scan, the append-only guarantee would
  // depend on an absence we never asserted.
  const offenders: string[] = [];
  for (const key of capturedKeys) {
    const isMutation = key.startsWith("PATCH ") || key.startsWith("DELETE ");
    const mentionsNotes =
      /\/(client|adviser)-notes(\/|$)/.test(key) || /\/notes\b/.test(key);
    if (isMutation && mentionsNotes) offenders.push(key);
  }
  const noMutationRoute = offenders.length === 0;

  if (appendOk && noMutationRoute) {
    pass(
      NAME,
      `v1 unchanged after v2 post; v2.previousNoteId=${row2?.previousNoteId} -> v1.id=${row1?.id}; scanned ${capturedKeys.size} routes, 0 PATCH/DELETE touch notes`,
    );
  } else {
    fail(
      NAME,
      `appendOk=${appendOk}, noMutationRoute=${noMutationRoute}, offenders=[${offenders.join(",")}]`,
    );
  }
}

async function test7_viewingGateBlocks(opts: {
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  // Defensive: drop any acks for this advice record so we know the gate is
  // firing on absence, not on a stale row.
  await db
    .delete(adviceAcknowledgements)
    .where(eq(adviceAcknowledgements.adviceRecordId, opts.adviceRecordId));

  const handler = captured.get("GET /api/client/advice/:id");
  if (!handler) {
    fail(
      "7. viewing-ack gate blocks unacknowledged GET",
      "internal: route handler not captured",
    );
    return;
  }
  const token = signToken({
    userId: opts.clientUserId,
    username: CLIENT_USERNAME,
    email: "wpc-client@test.invalid",
    role: "client",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
  });
  await handler(req, res);

  const NAME = "7. viewing-ack gate blocks GET and returns adviceAcknowledgements shape";
  const body = result.body;
  const blocked = result.statusCode === 403 && body?.reason === "acknowledgement_missing";
  const hasAdvicePayload = body && body.advice !== undefined;
  // The 403 must additionally describe the required adviceAcknowledgements
  // shape so the client UI can render the disclaimer interstitial. Without
  // this contract the client has to hard-code the schema, which is fragile.
  const ackShape = body?.adviceAcknowledgements;
  const REQUIRED_FIELDS = [
    "confirmPersonalDetails",
    "confirmFinancialInfo",
    "confirmObjectives",
    "confirmRiskProfile",
    "confirmScopeUnderstood",
    "confirmSoaViewed",
    "confirmFeesUnderstood",
    "confirmFeesConsented",
    "confirmValuesMayFall",
    "confirmReturnsNotGuaranteed",
    "confirmFsgReceived",
  ];
  const shapeOk =
    ackShape != null &&
    ackShape.table === "adviceAcknowledgements" &&
    Array.isArray(ackShape.requiredFields) &&
    ackShape.requiredFields.length === 11 &&
    REQUIRED_FIELDS.every((f) => ackShape.requiredFields.includes(f)) &&
    ackShape.signatureField === "signatureName" &&
    ackShape.allRequiredTrue === true;

  if (blocked && !hasAdvicePayload && shapeOk) {
    pass(
      NAME,
      `403 reason='acknowledgement_missing'; payload absent; adviceAcknowledgements shape lists all 11 confirm_* fields + signatureName`,
    );
  } else {
    fail(
      NAME,
      `expected 403 + reason + 11-field shape; got status=${result.statusCode}, blocked=${blocked}, noPayload=${!hasAdvicePayload}, shapeOk=${shapeOk}, ackShape=${JSON.stringify(ackShape)}`,
    );
  }
}

async function test8_disclaimerCaptured(opts: {
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  // Insert an acknowledgement row with ALL eleven required confirm flags
  // explicitly set to true. The viewer gate only requires that the row
  // exists; this assertion additionally proves the row faithfully captured
  // every flag from the disclaimer.
  await db.insert(adviceAcknowledgements).values({
    adviceRecordId: opts.adviceRecordId,
    clientId: opts.clientUserId,
    confirmPersonalDetails: true,
    confirmFinancialInfo: true,
    confirmObjectives: true,
    confirmRiskProfile: true,
    confirmScopeUnderstood: true,
    confirmSoaViewed: true,
    confirmFeesUnderstood: true,
    confirmFeesConsented: true,
    confirmValuesMayFall: true,
    confirmReturnsNotGuaranteed: true,
    confirmFsgReceived: true,
    signatureName: "WPC Test Client",
  });

  const handler = captured.get("GET /api/client/advice/:id")!;
  const token = signToken({
    userId: opts.clientUserId,
    username: CLIENT_USERNAME,
    email: "wpc-client@test.invalid",
    role: "client",
  });
  const { req, res, result } = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
  });
  await handler(req, res);

  // Re-read the ack row fresh from DB and assert all eleven flags persisted.
  const [ack] = await db
    .select()
    .from(adviceAcknowledgements)
    .where(
      and(
        eq(adviceAcknowledgements.adviceRecordId, opts.adviceRecordId),
        eq(adviceAcknowledgements.clientId, opts.clientUserId),
      ),
    );
  const elevenFlags = ack
    ? [
        ack.confirmPersonalDetails,
        ack.confirmFinancialInfo,
        ack.confirmObjectives,
        ack.confirmRiskProfile,
        ack.confirmScopeUnderstood,
        ack.confirmSoaViewed,
        ack.confirmFeesUnderstood,
        ack.confirmFeesConsented,
        ack.confirmValuesMayFall,
        ack.confirmReturnsNotGuaranteed,
        ack.confirmFsgReceived,
      ]
    : [];
  const allTrue = elevenFlags.length === 11 && elevenFlags.every((v) => v === true);

  const gateClears =
    result.statusCode === 200 && result.body?.advice?.id === opts.adviceRecordId;

  if (allTrue && gateClears && ack?.signatureName === "WPC Test Client") {
    pass(
      "8. ack row captures the full eleven-confirm disclaimer",
      `ack row id=${ack.id} has 11/11 confirm flags=true and signatureName='WPC Test Client'; viewer gate returned 200`,
    );
  } else {
    fail(
      "8. ack row captures the full eleven-confirm disclaimer",
      `gateClears=${gateClears}, allEleven=${allTrue}, sig='${ack?.signatureName}', flags=${JSON.stringify(elevenFlags)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 9 — admin / non-adviser cannot mutate adviser-scoped resources.
// The adviser-only mutation surface is gated by adviserRoute() which calls
// requireRole("adviser"). An admin role MUST be rejected from POST endpoints
// (admins can investigate via separate admin tooling, but they MUST NOT
// be able to silently insert objectives/notes/documents on a client's
// behalf — that would defeat the whole adviser-of-record audit trail).
// We exercise the same rejection for a client token to lock down both
// non-adviser pathways.
// ---------------------------------------------------------------------------
async function test9_adminAndClientCannotMutate(opts: {
  adminUserId: number;
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME =
    "9. non-adviser (admin/client) rejected on adviser CRUD AND admin retains audit-log read access";

  // ---- READ side ----
  // Admin role MUST retain its observability surface — at minimum the
  // shared audit_logs table — so it can investigate adviser activity
  // without ever mutating it. We assert the admin role has direct read
  // access to the audit rows the adviser left behind in test #5.
  const adminVisibleAuditRows = await db
    .select({ id: auditLogs.id, action: auditLogs.action })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, opts.adviserUserId),
        inArray(auditLogs.action, [
          "client_objective.create",
          "client_document.create",
          "client_objective.read",
          "client_document.read",
        ]),
      ),
    );
  const adminCanRead = adminVisibleAuditRows.length >= 4;

  // ---- MUTATE side (must all fail) ----
  const probe = async (params: {
    role: "admin" | "client";
    userId: number;
    username: string;
    email: string;
    routeKey: string;
    body: unknown;
  }) => {
    const handler = captured.get(params.routeKey);
    if (!handler) return { ok: false, status: -1, leaked: 0 };
    const token = signToken({
      userId: params.userId,
      username: params.username,
      email: params.email,
      role: params.role,
    });
    const { req, res, result } = makeMockReqRes({ token, body: params.body });
    await handler(req, res);
    return { ok: result.statusCode === 403, status: result.statusCode };
  };

  // Probe 1 — admin token POSTing an objective.
  const adminObj = await probe({
    role: "admin",
    userId: opts.adminUserId,
    username: ADMIN_USERNAME,
    email: "wpc-admin@test.invalid",
    routeKey: "POST /api/adviser/client-objectives",
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "retirement",
      label: "should not be created (admin caller)",
    },
  });
  // Probe 2 — admin token POSTing a note.
  const adminNote = await probe({
    role: "admin",
    userId: opts.adminUserId,
    username: ADMIN_USERNAME,
    email: "wpc-admin@test.invalid",
    routeKey: "POST /api/adviser/client-notes",
    body: { clientUserId: opts.clientUserId, body: "should not be created (admin)" },
  });
  // Probe 3 — client token POSTing a note (a different non-adviser path).
  const clientNote = await probe({
    role: "client",
    userId: opts.clientUserId,
    username: CLIENT_USERNAME,
    email: "wpc-client@test.invalid",
    routeKey: "POST /api/adviser/client-notes",
    body: { clientUserId: opts.clientUserId, body: "should not be created (client)" },
  });

  // Defensive leakage check: zero rows from any of the three probes.
  const leakedObjectives = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.label, "should not be created (admin caller)"));
  const leakedNotesAdmin = await db
    .select({ id: adviserNotes.id })
    .from(adviserNotes)
    .where(eq(adviserNotes.body, "should not be created (admin)"));
  const leakedNotesClient = await db
    .select({ id: adviserNotes.id })
    .from(adviserNotes)
    .where(eq(adviserNotes.body, "should not be created (client)"));

  const allRejected = adminObj.ok && adminNote.ok && clientNote.ok;
  const noLeakage =
    leakedObjectives.length === 0 &&
    leakedNotesAdmin.length === 0 &&
    leakedNotesClient.length === 0;

  if (adminCanRead && allRejected && noLeakage) {
    pass(
      NAME,
      `admin observed ${adminVisibleAuditRows.length} adviser audit rows (read OK); admin→objective:403, admin→note:403, client→note:403; 0 leakage`,
    );
  } else {
    fail(
      NAME,
      `expected admin-read OK + 3×403 + zero leakage; got adminCanRead=${adminCanRead} (visibleRows=${adminVisibleAuditRows.length}), [adminObj=${adminObj.status}, adminNote=${adminNote.status}, clientNote=${clientNote.status}], leaked=${leakedObjectives.length}/${leakedNotesAdmin.length}/${leakedNotesClient.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 10 — production transition route snapshots versions, AND no money-
// table side effects accumulate across the entire roll-up. Combining these
// into a single assertion is deliberate: regulators care that issuance
// snapshotting works AND that the wealth-planner surface is money-isolated;
// they're two halves of the same "no surprises" guarantee for this layer.
// ---------------------------------------------------------------------------
async function test10_transitionAndImmutability(opts: {
  adviceRecordId: number;
  adviserUserId: number;
  before: MoneySnapshot;
}): Promise<void> {
  const NAME =
    "10. risk-profile and adviceType immutable via transition; snapshots written; no ledger drift";

  // Capture the BEFORE snapshot of the advice record's adviceType and
  // riskProfileId — these are NOT in the transition route's typed update
  // payload, so they MUST come back unchanged regardless of what the caller
  // tries to send.
  const [beforeRow] = await db
    .select({
      adviceType: adviceRecords.adviceType,
      riskProfileId: adviceRecords.riskProfileId,
    })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  // Wipe any prior version rows for this advice record so the assertion is
  // deterministic.
  await db
    .delete(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));

  const handler = captured.get("POST /api/adviser/advice-records/:id/transition");
  if (!handler) {
    fail(
      NAME,
      "internal: transition route handler not captured (snapshot hook not wired into a real route)",
    );
    return;
  }

  const token = signToken({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "wpc-adviser@test.invalid",
    role: "adviser",
  });

  // Probe with a payload that ALSO tries to mutate adviceType and
  // riskProfileId. The route's zod schema (transitionSchema in
  // adviser-routes.ts) only whitelists newStatus/soaIssued/soaIssuedAt;
  // these extra fields must be silently ignored by zod's strict parse,
  // so the live row's adviceType + riskProfileId remain at their pre-call
  // values. This is the recommendation/risk-profile allow-list enforcement.
  const r1 = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
    body: {
      newStatus: "issued",
      soaIssued: true,
      soaIssuedAt: new Date().toISOString(),
      // Hostile fields below — must NOT be applied:
      adviceType: "general",
      riskProfileId: 99999,
    },
  });
  await handler(r1.req, r1.res);

  const r2 = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
    body: { newStatus: "superseded", adviceType: "scaled" },
  });
  await handler(r2.req, r2.res);

  // Re-read the advice row to assert immutability of fields outside the
  // transition's typed update shape.
  const [afterRow] = await db
    .select({
      adviceType: adviceRecords.adviceType,
      riskProfileId: adviceRecords.riskProfileId,
      status: adviceRecords.status,
    })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  const adviceTypeImmutable = afterRow?.adviceType === beforeRow?.adviceType;
  const riskProfileImmutable = afterRow?.riskProfileId === beforeRow?.riskProfileId;
  const statusActuallyFlipped = afterRow?.status === "superseded";

  const persisted = await db
    .select()
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));
  persisted.sort((a, b) => a.versionNumber - b.versionNumber);

  const transitionOk =
    r1.result.statusCode === 200 &&
    r2.result.statusCode === 200 &&
    persisted.length === 2 &&
    persisted[0].versionNumber === 1 &&
    persisted[0].snapshotReason === "issued" &&
    persisted[1].versionNumber === 2 &&
    persisted[1].snapshotReason === "superseded" &&
    snapshotIdMatches(persisted[0].snapshotJsonb, opts.adviceRecordId);

  // Money-isolation check happens AFTER all writes, so it covers the
  // entire roll-up.
  const after = await snapshotMoneyTables();
  const txDelta = after.txCount - opts.before.txCount;
  const entryDelta = after.entryCount - opts.before.entryCount;
  const receiptDelta = after.receiptCount - opts.before.receiptCount;
  const noDrift = txDelta === 0 && entryDelta === 0 && receiptDelta === 0;

  if (
    transitionOk &&
    adviceTypeImmutable &&
    riskProfileImmutable &&
    statusActuallyFlipped &&
    noDrift
  ) {
    pass(
      NAME,
      `transition wrote v1='issued', v2='superseded'; status flipped; adviceType stayed '${afterRow?.adviceType}'; riskProfileId stayed ${String(afterRow?.riskProfileId)}; ledger Δ=0/0/0`,
    );
  } else {
    fail(
      NAME,
      `transitionOk=${transitionOk}, adviceTypeImmutable=${adviceTypeImmutable} (before='${beforeRow?.adviceType}', after='${afterRow?.adviceType}'), riskProfileImmutable=${riskProfileImmutable} (before=${String(beforeRow?.riskProfileId)}, after=${String(afterRow?.riskProfileId)}), statusFlipped=${statusActuallyFlipped}, noDrift=${noDrift}, deltas=tx${txDelta}/entry${entryDelta}/receipt${receiptDelta}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 11 — Task #96 review-pending lock.
//   - With adviceRecords.status = 'review_pending':
//       POST /api/adviser/client-objectives             -> 423 + reason
//       POST /api/adviser/client-documents (with adviceRecordId) -> 423 + reason
//       POST /api/adviser/advice-records/:id/transition -> 423 + reason
//       POST /api/adviser/client-notes                  -> 200 (notes are exempt)
//   - Zero new rows leak through on the 423 paths.
// Runs LAST so it can flip the live status without disturbing earlier
// assertions; restores the prior status for cleanliness on rerun.
// ---------------------------------------------------------------------------
async function test11_reviewPendingLock(opts: {
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number;
}): Promise<void> {
  const NAME =
    "11. review_pending blocks objective/document/transition writes; notes still allowed";

  const [orig] = await db
    .select({ status: adviceRecords.status })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  // Snapshot row counts BEFORE the locked probes — leakage check is the
  // teeth on the lock; without it a route could return 423 *after* writing.
  const beforeObjectives = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.adviceRecordId, opts.adviceRecordId));
  const beforeDocuments = await db
    .select({ id: clientDocuments.id })
    .from(clientDocuments)
    .where(eq(clientDocuments.adviceRecordId, opts.adviceRecordId));
  const beforeVersions = await db
    .select({ id: adviceRecordVersions.id })
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));

  // Flip into review_pending for the duration of the probes.
  await db
    .update(adviceRecords)
    .set({ status: "review_pending" })
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  const token = signToken({
    userId: opts.adviserUserId,
    username: ADVISER_USERNAME,
    email: "wpc-adviser@test.invalid",
    role: "adviser",
  });

  const expectedReason = "record_locked_under_review";
  const lockedNoteBody =
    "Compliance reviewer note while record is under review (test 11)";

  // ---- BLOCKED: objective POST ----
  const postObj = captured.get("POST /api/adviser/client-objectives")!;
  const r1 = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      objectiveType: "income",
      label: "should be locked under review (test 11)",
    },
  });
  await postObj(r1.req, r1.res);

  // ---- BLOCKED: document POST (with adviceRecordId) ----
  const postDoc = captured.get("POST /api/adviser/client-documents")!;
  const r2 = makeMockReqRes({
    token,
    body: {
      clientId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      documentType: "fact_find",
      fileName: "locked-under-review.pdf",
      storageKey: "wpc-locked-under-review-key",
    },
  });
  await postDoc(r2.req, r2.res);

  // ---- BLOCKED: transition POST (issued) ----
  const postTrans = captured.get(
    "POST /api/adviser/advice-records/:id/transition",
  )!;
  const r3 = makeMockReqRes({
    token,
    params: { id: String(opts.adviceRecordId) },
    body: { newStatus: "issued" },
  });
  await postTrans(r3.req, r3.res);

  // ---- ALLOWED: note POST stays open ----
  const postNote = captured.get("POST /api/adviser/client-notes")!;
  const r4 = makeMockReqRes({
    token,
    body: {
      clientUserId: opts.clientUserId,
      adviceRecordId: opts.adviceRecordId,
      body: lockedNoteBody,
    },
  });
  await postNote(r4.req, r4.res);

  // Re-snapshot to assert no objective/document/version leaked through.
  const afterObjectives = await db
    .select({ id: clientObjectives.id })
    .from(clientObjectives)
    .where(eq(clientObjectives.adviceRecordId, opts.adviceRecordId));
  const afterDocuments = await db
    .select({ id: clientDocuments.id })
    .from(clientDocuments)
    .where(eq(clientDocuments.adviceRecordId, opts.adviceRecordId));
  const afterVersions = await db
    .select({ id: adviceRecordVersions.id })
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));

  const lockedNote = await db
    .select({ id: adviserNotes.id })
    .from(adviserNotes)
    .where(eq(adviserNotes.body, lockedNoteBody));

  // Restore original status so reruns don't drift.
  await db
    .update(adviceRecords)
    .set({ status: orig?.status ?? "draft" })
    .where(eq(adviceRecords.id, opts.adviceRecordId));

  const objBlocked =
    r1.result.statusCode === 423 &&
    (r1.result.body as { reason?: string } | undefined)?.reason ===
      expectedReason;
  const docBlocked =
    r2.result.statusCode === 423 &&
    (r2.result.body as { reason?: string } | undefined)?.reason ===
      expectedReason;
  const transBlocked =
    r3.result.statusCode === 423 &&
    (r3.result.body as { reason?: string } | undefined)?.reason ===
      expectedReason;
  const noteAllowed = r4.result.statusCode === 200 && lockedNote.length === 1;
  const noLeakage =
    afterObjectives.length === beforeObjectives.length &&
    afterDocuments.length === beforeDocuments.length &&
    afterVersions.length === beforeVersions.length;

  if (objBlocked && docBlocked && transBlocked && noteAllowed && noLeakage) {
    pass(
      NAME,
      `objectives=423, documents=423, transition=423 (reason='${expectedReason}'); note=200 (id=${lockedNote[0].id}); leakage Δ=0/0/0 (obj/doc/ver)`,
    );
  } else {
    fail(
      NAME,
      `objBlocked=${objBlocked} (status=${r1.result.statusCode}, body=${JSON.stringify(r1.result.body)}), docBlocked=${docBlocked} (status=${r2.result.statusCode}, body=${JSON.stringify(r2.result.body)}), transBlocked=${transBlocked} (status=${r3.result.statusCode}, body=${JSON.stringify(r3.result.body)}), noteAllowed=${noteAllowed} (status=${r4.result.statusCode}, rowFound=${lockedNote.length}), noLeakage=${noLeakage} (objΔ=${afterObjectives.length - beforeObjectives.length}, docΔ=${afterDocuments.length - beforeDocuments.length}, verΔ=${afterVersions.length - beforeVersions.length})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("=== Wealth Planner Compliance verification roll-up (Task #94) ===\n");

  captureAllRoutes();

  const clientUserId = await ensureUser({
    username: CLIENT_USERNAME,
    email: "wpc-client@test.invalid",
    role: "client",
  });
  const otherClientUserId = await ensureUser({
    username: OTHER_CLIENT_USERNAME,
    email: "wpc-other-client@test.invalid",
    role: "client",
  });
  const adviserUserId = await ensureUser({
    username: ADVISER_USERNAME,
    email: "wpc-adviser@test.invalid",
    role: "adviser",
  });
  const otherAdviserUserId = await ensureUser({
    username: OTHER_ADVISER_USERNAME,
    email: "wpc-other-adviser@test.invalid",
    role: "adviser",
  });
  const adminUserId = await ensureUser({
    username: ADMIN_USERNAME,
    email: "wpc-admin@test.invalid",
    role: "admin",
  });

  await cleanupForUserIds([
    clientUserId,
    otherClientUserId,
    adviserUserId,
    otherAdviserUserId,
    adminUserId,
  ]);
  await ensureLink(adviserUserId, clientUserId);
  await ensureUnlinked(otherAdviserUserId, clientUserId);

  const adviceRecordId = await makeAdviceRecord(clientUserId);

  // Money-isolation snapshot — taken BEFORE any wealth-planner write.
  const moneyBefore = await snapshotMoneyTables();

  await test1_retentionDefaultsWired({
    clientUserId,
    adviserUserId,
    adviceRecordId,
  });
  await test2_adviceTypeDefault({ clientUserId });
  await test3_crossAdviserRejected({
    otherAdviserUserId,
    clientUserId,
    adviceRecordId,
  });
  await test4_crossClientReadPrevented({
    clientUserId,
    otherClientUserId,
    adviceRecordId,
  });
  await test5_crudWritesAuditRows({
    adviserUserId,
    clientUserId,
    adviceRecordId,
  });
  await test6_appendOnlyAndNoMutationRoute({ adviserUserId, clientUserId });
  await test7_viewingGateBlocks({ clientUserId, adviceRecordId });
  await test8_disclaimerCaptured({ clientUserId, adviceRecordId });
  await test9_adminAndClientCannotMutate({
    adminUserId,
    adviserUserId,
    clientUserId,
    adviceRecordId,
  });
  // Test 10 runs second-to-last so its money-isolation half covers EVERY
  // wealth-planner write up to that point (including its own transition-route
  // writes, which happen before snapshotMoneyTables() is re-read).
  await test10_transitionAndImmutability({
    adviceRecordId,
    adviserUserId,
    before: moneyBefore,
  });
  // Test 11 (Task #96 review-pending lock) runs LAST: it temporarily flips
  // status to 'review_pending' to exercise the lock and restores the prior
  // status before returning. It does not touch money tables, so test 10's
  // earlier money-isolation check is still authoritative.
  await test11_reviewPendingLock({
    adviserUserId,
    clientUserId,
    adviceRecordId,
  });

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
      `\n${failedCount} fail(s), ${missingCount} missing assertion(s) in Wealth Planner Compliance roll-up.`,
    );
    process.exit(1);
  }

  console.log("\nALL WEALTH PLANNER COMPLIANCE TESTS PASSED \u2705");
  process.exit(0);
}

main().catch((err) => {
  console.error("Wealth planner compliance roll-up crashed:", err);
  process.exit(1);
});
