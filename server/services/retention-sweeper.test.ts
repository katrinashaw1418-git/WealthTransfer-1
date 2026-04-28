// =============================================================================
// Task #330 — Tests for the daily 7-year retention sweeper
// =============================================================================
// Locks down the contract that the cron uses to flip `deletion_locked` from
// true→false on regulatory rows whose 7-year retention window has elapsed:
//
//   1. Past retention + locked → flag flipped, audit row written.
//   2. Future retention + locked → untouched, no audit row.
//   3. Past retention + already unlocked → untouched (idempotent).
//   4. Re-running the sweep with no fresh expirations is a no-op.
//
// Plus a smoke check that the summary string formatter only mentions tables
// that actually did work (no 12-line "x=0" daily dashboard noise).
//
// We exercise the contract against `client_documents` because it has the
// fewest required columns and no FK fan-out, but the sweeper itself iterates
// the same RETENTION_TABLES catalogue at runtime — so a bug in the loop
// would still be caught.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  clientDocuments,
  users,
} from "@shared/schema";
import {
  RETENTION_EXPIRED_AUDIT_ACTION,
  RETENTION_TABLES,
  formatRetentionSweeperSummary,
  runRetentionSweeper,
} from "./retention-sweeper";

const CLIENT_USERNAME_PREFIX = "__retention_sweeper_test__";

describe("runRetentionSweeper (Task #330)", () => {
  let clientId: number;
  let adviserId: number;
  // Track every doc we create so afterAll can clean up reliably without
  // colliding with other test suites that touch client_documents.
  const createdDocIds: number[] = [];

  beforeAll(async () => {
    // Deterministic suffix so concurrent CI runs cannot collide on the
    // unique username/email indexes.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [client] = await db
      .insert(users)
      .values({
        username: `${CLIENT_USERNAME_PREFIX}cli-${stamp}`,
        email: `${CLIENT_USERNAME_PREFIX}cli-${stamp}@example.test`,
        password: "x",
        firstName: "Retention",
        lastName: "Client",
      })
      .returning();
    const [adviser] = await db
      .insert(users)
      .values({
        username: `${CLIENT_USERNAME_PREFIX}adv-${stamp}`,
        email: `${CLIENT_USERNAME_PREFIX}adv-${stamp}@example.test`,
        password: "x",
        firstName: "Retention",
        lastName: "Adviser",
        role: "adviser",
      })
      .returning();
    clientId = client.id;
    adviserId = adviser.id;
  });

  afterAll(async () => {
    // We deliberately do NOT clean up the audit_logs rows the sweeper
    // emitted: that table is install-time immutable (Task #142) and
    // attempting a DELETE throws. The leftover rows reference test
    // entities scoped by the unique fixture username prefix, so they
    // can't be confused with real production audit history.
    if (createdDocIds.length > 0) {
      await db
        .delete(clientDocuments)
        .where(inArray(clientDocuments.id, createdDocIds));
    }
    if (clientId) await db.delete(users).where(eq(users.id, clientId));
    if (adviserId) await db.delete(users).where(eq(users.id, adviserId));
  });

  async function insertDoc(
    label: string,
    retentionUntil: Date,
    deletionLocked: boolean,
  ): Promise<number> {
    const [row] = await db
      .insert(clientDocuments)
      .values({
        clientId,
        documentType: "fact_find",
        fileName: `${label}.pdf`,
        storageKey: `client-documents/${clientId}/${label}.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
        uploadedByUserId: adviserId,
        retentionUntil,
        deletionLocked,
      })
      .returning({ id: clientDocuments.id });
    createdDocIds.push(row.id);
    return row.id;
  }

  it("flips deletion_locked and writes an audit row for past + locked rows", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const id = await insertDoc("expired-and-locked", past, true);

    const summary = await runRetentionSweeper();

    // The sweeper iterates every retention table; only assert against the
    // entry we know had a candidate so unrelated tables (which may or may
    // not have stale rows from earlier suites) cannot make this test
    // flake.
    const docsTable = summary.perTable.find(
      (p) => p.entityType === "client_document",
    );
    expect(docsTable).toBeDefined();
    expect(docsTable!.cleared).toBeGreaterThanOrEqual(1);
    expect(docsTable!.errors).toBe(0);
    expect(summary.totalCleared).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select({
        deletionLocked: clientDocuments.deletionLocked,
      })
      .from(clientDocuments)
      .where(eq(clientDocuments.id, id));
    expect(after.deletionLocked).toBe(false);

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, RETENTION_EXPIRED_AUDIT_ACTION),
          eq(auditLogs.entityType, "client_document"),
          eq(auditLogs.entityId, String(id)),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(auditRows.length).toBe(1);
    const meta = auditRows[0].metadata as Record<string, unknown>;
    expect(meta.before).toEqual({ deletionLocked: true });
    expect(meta.after).toEqual({ deletionLocked: false });
    expect(typeof meta.retentionUntil).toBe("string");
    expect(meta.policy).toMatch(/Corporations Act s912G/);
    // System action — no human actor.
    expect(auditRows[0].userId).toBeNull();
  });

  it("leaves rows whose retention is in the future untouched", async () => {
    const future = new Date(Date.now() + 365 * 86_400_000);
    const id = await insertDoc("future-retention", future, true);

    await runRetentionSweeper();

    const [after] = await db
      .select({ deletionLocked: clientDocuments.deletionLocked })
      .from(clientDocuments)
      .where(eq(clientDocuments.id, id));
    expect(after.deletionLocked).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, RETENTION_EXPIRED_AUDIT_ACTION),
          eq(auditLogs.entityType, "client_document"),
          eq(auditLogs.entityId, String(id)),
        ),
      );
    expect(auditRows.length).toBe(0);
  });

  it("is idempotent: a second run on the same row writes no new audit row", async () => {
    // Insert a row that has already been cleared (deletion_locked=false)
    // with a past retention. The sweeper should leave it alone — neither
    // an UPDATE nor an audit row.
    const past = new Date(Date.now() - 86_400_000);
    const id = await insertDoc("already-unlocked", past, false);

    const before = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, RETENTION_EXPIRED_AUDIT_ACTION),
          eq(auditLogs.entityType, "client_document"),
          eq(auditLogs.entityId, String(id)),
        ),
      );

    await runRetentionSweeper();

    const after = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, RETENTION_EXPIRED_AUDIT_ACTION),
          eq(auditLogs.entityType, "client_document"),
          eq(auditLogs.entityId, String(id)),
        ),
      );
    expect(after.length).toBe(before.length);
  });

  it("respects an injected `now` so tests can drive the boundary deterministically", async () => {
    // Future retention, but we feed the sweeper a "now" that is past it.
    // The sweeper should treat it as expired and clear the lock.
    const retention = new Date(Date.now() + 60_000);
    const futureNow = new Date(retention.getTime() + 60_000);
    const id = await insertDoc("clock-skewed", retention, true);

    await runRetentionSweeper({ now: futureNow });

    const [after] = await db
      .select({ deletionLocked: clientDocuments.deletionLocked })
      .from(clientDocuments)
      .where(eq(clientDocuments.id, id));
    expect(after.deletionLocked).toBe(false);
  });
});

describe("RETENTION_TABLES catalogue", () => {
  it("covers the six tables explicitly named in the task spec", () => {
    // A regression guard: if a refactor accidentally drops one of the
    // tables Done-looks-like names, the sweep silently leaves those rows
    // locked forever. This list is the contractual minimum.
    const required = [
      "client_document",
      "adviser_note",
      "advice_record",
      "soa_document",
      "roa_document",
      "fee_consent",
    ];
    const present = new Set(RETENTION_TABLES.map((t) => t.entityType));
    for (const name of required) {
      expect(present.has(name)).toBe(true);
    }
  });
});

describe("formatRetentionSweeperSummary", () => {
  it("hides per-table entries that did nothing", () => {
    const line = formatRetentionSweeperSummary({
      ranAt: new Date(),
      totalCleared: 0,
      totalErrors: 0,
      perTable: [
        { entityType: "client_document", cleared: 0, errors: 0 },
        { entityType: "fee_consent", cleared: 0, errors: 0 },
      ],
    });
    expect(line).toBe("cleared=0, errors=0");
  });

  it("includes only the tables that cleared rows or errored", () => {
    const line = formatRetentionSweeperSummary({
      ranAt: new Date(),
      totalCleared: 3,
      totalErrors: 1,
      perTable: [
        { entityType: "client_document", cleared: 2, errors: 0 },
        { entityType: "fee_consent", cleared: 1, errors: 1 },
        { entityType: "adviser_note", cleared: 0, errors: 0 },
      ],
    });
    expect(line).toContain("cleared=3, errors=1");
    expect(line).toContain("client_document=2");
    expect(line).toContain("fee_consent=1(1 err)");
    expect(line).not.toContain("adviser_note");
  });
});
