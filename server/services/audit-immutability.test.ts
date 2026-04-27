// =============================================================================
// Task #149 — DB-level immutability of audit_logs
// =============================================================================
// Locks in the contract that the `audit_logs` table is truly append-only at
// the database layer:
//   - INSERT continues to work
//   - UPDATE on any existing row is rejected with a clear error
//   - DELETE on any existing row is rejected with a clear error
//   - TRUNCATE on the table is rejected with a clear error
//
// Until Task #149 the protection was logical only (no application code path
// mutated the table), but a buggy migration or a future ORM call could have
// silently broken that. The startup migration in `server/routes.ts` installs
// BEFORE UPDATE / BEFORE DELETE / BEFORE TRUNCATE triggers that raise an
// exception. This test exercises all three paths against the same dev DB the
// rest of the project uses.
//
// Notes on cleanup:
//   The whole point of this test is that we CANNOT delete rows from
//   `audit_logs`. The successful INSERT we use as the probe will therefore
//   remain in the table forever. We tag it with a clearly-identifiable
//   action and a per-run timestamp so the rows are recognisable as test
//   probes by any operator browsing the audit log later. The probe rows are
//   harmless: they are well-formed audit_logs entries with metadata
//   `{ task: 149, kind: "immutability_probe" }` and no userId.
//
//   We deliberately do NOT disable the trigger to clean up — doing so would
//   defeat the purpose of the test. If a future maintainer wants the test
//   to leave no trace, they would have to run the override procedure
//   documented in server/routes.ts, which is itself a privileged DBA step.
// =============================================================================

import "../../scripts/_bootstrap-test-env";
import { describe, expect, it, beforeAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db } from "../db";
import { auditLogs } from "@shared/schema";
import { installAuditLogsImmutabilityTriggers } from "./audit-immutability-migration";

// The startup migrations in `server/routes.ts` install the immutability
// triggers, but vitest does not boot the HTTP server. We invoke the SAME
// installer module here so the test is self-contained and does not rely
// on a previous `npm run dev` having been executed against this database.
// Sharing the installer (rather than copy-pasting the SQL) is what
// guarantees production and test cannot drift apart.

describe("audit_logs is immutable at the DB level (Task #149)", () => {
  beforeAll(async () => {
    await installAuditLogsImmutabilityTriggers(db);
  });

  it("allows INSERT, then rejects UPDATE, DELETE and TRUNCATE on the same row", async () => {
    // ---- INSERT continues to work normally --------------------------------
    const stamp = `task-149-immutability-probe-${Date.now()}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    const [row] = await db
      .insert(auditLogs)
      .values({
        userId: null,
        action: stamp,
        entityType: "test",
        entityId: stamp,
        metadata: { task: 149, kind: "immutability_probe" },
        ipAddress: null,
      })
      .returning();

    expect(row).toBeDefined();
    expect(row.id).toBeGreaterThan(0);
    expect(row.action).toBe(stamp);

    // ---- UPDATE must be rejected with a clear error -----------------------
    let updateError: unknown = undefined;
    try {
      await db
        .update(auditLogs)
        .set({ action: "tampered" })
        .where(eq(auditLogs.id, row.id));
    } catch (err) {
      updateError = err;
    }
    expect(updateError).toBeDefined();
    expect(String((updateError as Error).message)).toMatch(/audit_logs is immutable/i);

    // The original row must still be intact and unchanged.
    const afterUpdate = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, row.id));
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0].action).toBe(stamp);

    // ---- DELETE must be rejected with a clear error -----------------------
    let deleteError: unknown = undefined;
    try {
      await db.delete(auditLogs).where(eq(auditLogs.id, row.id));
    } catch (err) {
      deleteError = err;
    }
    expect(deleteError).toBeDefined();
    expect(String((deleteError as Error).message)).toMatch(/audit_logs is immutable/i);

    // The row must still exist after the failed DELETE.
    const afterDelete = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, row.id));
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].action).toBe(stamp);
  });

  it("rejects TRUNCATE on the audit_logs table", async () => {
    let truncateError: unknown = undefined;
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE audit_logs`));
    } catch (err) {
      truncateError = err;
    }
    expect(truncateError).toBeDefined();
    expect(String((truncateError as Error).message)).toMatch(/audit_logs is immutable/i);
  });

  it("still allows further INSERTs after a rejected mutation", async () => {
    // Sanity: after the trigger has fired and rolled back a statement,
    // subsequent INSERTs in fresh statements continue to work. This guards
    // against a future change accidentally widening the trigger's scope or
    // marking the table read-only entirely.
    const stamp = `task-149-immutability-probe-followup-${Date.now()}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    const [row] = await db
      .insert(auditLogs)
      .values({
        userId: null,
        action: stamp,
        entityType: "test",
        entityId: stamp,
        metadata: { task: 149, kind: "immutability_probe", phase: "followup" },
        ipAddress: null,
      })
      .returning();

    expect(row).toBeDefined();
    expect(row.action).toBe(stamp);
  });
});
