// =============================================================================
// Task #149 — Shared installer for the audit_logs immutability triggers.
// =============================================================================
// Single source of truth for the DDL that makes `audit_logs` truly append-only
// at the database level. Both the production startup migration in
// `server/routes.ts` AND the automated test in
// `server/services/audit-immutability.test.ts` call this installer so the two
// can never drift out of sync.
//
// Behaviour:
//   - Idempotent: CREATE OR REPLACE on the function, DROP IF EXISTS + CREATE
//     on the triggers. Safe to run on every boot and from inside tests.
//   - Installs three BEFORE triggers on `audit_logs`:
//       audit_logs_block_update    (BEFORE UPDATE FOR EACH ROW)
//       audit_logs_block_delete    (BEFORE DELETE FOR EACH ROW)
//       audit_logs_block_truncate  (BEFORE TRUNCATE FOR EACH STATEMENT)
//     All three call a shared plpgsql function `audit_logs_block_mutation()`
//     that RAISEs an exception with SQLSTATE `restrict_violation` and a
//     human-readable message containing the literal string
//     "audit_logs is immutable" — both the message text and the SQLSTATE
//     are public contract relied on by tests and operator runbooks.
//
// EMERGENCY OVERRIDE PROCEDURE (DBA-only — itself an audited operational step):
//   1. Connect to the DB as a superuser (NOT the application role).
//   2. ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_block_update;
//      ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_block_delete;
//      ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_block_truncate;
//   3. Perform the corrective change inside an explicit transaction and
//      record what was changed and why in the operator runbook.
//   4. Re-enable all three triggers before COMMIT and before releasing
//      the connection.
// The next app boot re-runs this installer, which re-asserts the trigger
// definitions — so even if a DBA forgets to re-enable, the next deploy
// restores immutability automatically.
// =============================================================================

import { sql } from "drizzle-orm";
import type { db as Db } from "../db";

// Pick the single method we use, mirroring the pattern in
// server/services/audit.ts so callers can pass either the top-level `db`
// handle or a tx handle without TypeScript losing the chain types.
type DbHandle = Pick<typeof Db, "execute">;

export async function installAuditLogsImmutabilityTriggers(
  handle: DbHandle,
): Promise<void> {
  await handle.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is immutable: % is not permitted on this table', TG_OP
        USING ERRCODE = 'restrict_violation',
              HINT = 'audit_logs is append-only; see emergency-override procedure in server/services/audit-immutability-migration.ts';
    END;
    $$ LANGUAGE plpgsql;
  `));
  await handle.execute(sql.raw(`DROP TRIGGER IF EXISTS audit_logs_block_update ON audit_logs;`));
  await handle.execute(sql.raw(`
    CREATE TRIGGER audit_logs_block_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
  `));
  await handle.execute(sql.raw(`DROP TRIGGER IF EXISTS audit_logs_block_delete ON audit_logs;`));
  await handle.execute(sql.raw(`
    CREATE TRIGGER audit_logs_block_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
  `));
  await handle.execute(sql.raw(`DROP TRIGGER IF EXISTS audit_logs_block_truncate ON audit_logs;`));
  await handle.execute(sql.raw(`
    CREATE TRIGGER audit_logs_block_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();
  `));
}
