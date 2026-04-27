// =============================================================================
// TASK #95 — Standardised audit-log writer for advice + money writes
// =============================================================================
// Background:
//   `auditLogs.metadata` is a free-form jsonb<Record<string, any>>. Different
//   writers historically captured different shapes — some richly logged the
//   full settle context; others recorded only `action + entityId`. A regulator
//   reviewing a complaint about a recommendation or fee change needs to see
//   exactly WHAT changed, not just THAT something changed.
//
// What this helper guarantees:
//   - Every metadata jsonb written via writeAuditLog() has a stable shape:
//        { before: <object|null>, after: <object|null>, ...extra }
//     Even when a caller has no meaningful "before" (e.g. a brand-new fee
//     consent request), `before` is explicitly recorded as `null` so a
//     downstream auditor can rely on the keys always being present.
//   - The helper is fail-closed: it does NOT swallow DB errors. Audit
//     failures must surface so the surrounding write either rolls back
//     (when `executor` is a tx handle) or the caller decides how to react.
//     This matches the AFSL-grade "every state change must produce an
//     audit row" rule already enforced in admin-routes.ts/auditTx.
//   - Accepts either the top-level db handle or a tx handle so callers can
//     keep the audit insert in the same transaction as the underlying
//     state change.
//
// Scope (per task #95):
//   This is the ONLY permitted path to insert into `auditLogs` from the
//   advice + fee-engine code paths (insufficient-funds-sweep, fee-engine
//   settle/reverse routes, advice-record status flips, fee-consent
//   request/sign/decline/withdraw). Direct `db.insert(auditLogs)` calls
//   in those surfaces have been removed.
//
//   Out of scope: admin user CRUD, KYC, registration invites, etc. Those
//   surfaces still use their local audit helpers — a separate sweep will
//   migrate them.
// =============================================================================

import { db } from "../db";
import { auditLogs } from "../../shared/schema";
import { recordAuditWriteFailure } from "./error-log";
import { notifyOperatorWithSuppression } from "./operator-alerts";

// Inferred from the insert().returning() shape so the return type stays in
// lock-step with the table definition without a hand-maintained alias.
export type AuditRow = typeof auditLogs.$inferSelect;

// A drizzle-style executor — either the top-level db handle or a tx handle
// inside `db.transaction(async (tx) => …)`. Mirrors the convention used in
// other services (ledger, fee-engine) so callers can pass `tx` to keep the
// audit row in the same DB transaction as the state change it describes.
//
// Implementation note: a naive `typeof db | Parameters<Parameters<typeof
// db.transaction>[0]>[0]` union loses callability of `.insert(...)` because
// TS narrows the return type to `never`. Picking the single method we need
// gives both handles a structurally-shared, fully-typed insert chain — no
// `any` casts at the call site below.
type DbHandle = Pick<typeof db, "insert">;

export interface WriteAuditLogOpts {
  // Optional executor. Defaults to the top-level `db`. When the caller is
  // already inside a `db.transaction(async (tx) => …)`, pass `tx` so the
  // audit insert lives in the same atomic unit as the underlying write —
  // an audit failure then rolls the whole thing back (fail-closed).
  executor?: DbHandle;

  // The actor performing the action. Use the platform/system user id for
  // automated paths (cron sweeps, etc.). Nullable to mirror the column.
  userId: number | null;

  // Stable verb identifying the change, e.g. "fee_deduction_settled",
  // "advice_record.transition.issued". Existing action strings are
  // preserved verbatim so historical filters/queries keep working.
  action: string;

  // Entity tag pair — e.g. ("adviser_fee_deduction", "42"). Both nullable
  // to mirror the column schema.
  entityType: string | null;
  entityId: string | null;

  // Snapshot of the row BEFORE the change. Pass `null` (or omit) when the
  // change is a fresh insert and there is no prior state. Pass a small,
  // hand-picked subset of fields — NOT the entire row — so the audit row
  // stays small and the diff is obvious to an auditor.
  before?: Record<string, unknown> | null;

  // Snapshot of the row AFTER the change. Pass `null` (or omit) ONLY when
  // the change truly produced no DB mutation — e.g. a reverseSettledDeduction
  // failure that throws before any UPDATE runs. WARNING: some failure paths
  // still mutate the underlying row (e.g. settleApprovedDeduction's outer
  // catch persists `failureReason` and `status='insufficient_funds'` even
  // after the ledger-posting tx rolls back). In those cases the caller MUST
  // re-read the row after the failure and pass the post-failure state here,
  // otherwise the audit row will misrepresent the actual DB state to a
  // regulator. When in doubt, re-read and pass a real snapshot.
  after?: Record<string, unknown> | null;

  // Free-form extra context that doesn't belong in either snapshot —
  // e.g. trigger source, error message on a failure, related ids. Merged
  // into the metadata object alongside `before`/`after`.
  extra?: Record<string, unknown>;

  // The originating IP address, if any. Pass `null` for cron / sweep
  // paths that have no HTTP request. Mirrors the column schema.
  ipAddress?: string | null;
}

export async function writeAuditLog(
  opts: WriteAuditLogOpts,
): Promise<AuditRow> {
  const handle: DbHandle = opts.executor ?? db;

  const metadata: Record<string, unknown> = {
    before: opts.before ?? null,
    after: opts.after ?? null,
    ...(opts.extra ?? {}),
  };

  try {
    const [row] = await handle
      .insert(auditLogs)
      .values({
        userId: opts.userId,
        action: opts.action,
        entityType: opts.entityType,
        entityId: opts.entityId,
        metadata,
        ipAddress: opts.ipAddress ?? null,
      })
      .returning();

    return row;
  } catch (err) {
    // Task #144 — tally the failure into the persistent error log + the
    // in-process metrics counter so the admin "audit-log write failures
    // in last 24h" tile stays accurate without scraping log files.
    recordAuditWriteFailure(err, {
      userId: opts.userId,
      action: opts.action,
    });
    // Task #145 — also page an operator. The two paths are complementary:
    // the metrics counter is the "how often is this happening" view, and
    // the operator alert is the "wake someone up RIGHT NOW" view, with a
    // suppression key that collapses repeats of the same failing row to
    // one ack-able signature so a flapping FK doesn't carpet-bomb the
    // inbox. Dispatch BEFORE re-throwing so a downstream catch that
    // decides to swallow can't suppress the page.
    await emitAuditWriteFailureAlert(opts, err);
    throw err;
  }
}

// Exported so the legacy local writeAuditLog in server/routes.ts can fire
// the same operator alert with the same suppression-key shape, keeping the
// admin UI's "audit-log-write-failure" stream consistent regardless of which
// code path attempted the insert.
export async function emitAuditWriteFailureAlert(
  opts: Pick<
    WriteAuditLogOpts,
    "userId" | "action" | "entityType" | "entityId" | "before" | "after"
  >,
  err: unknown,
): Promise<void> {
  const errorMessage =
    err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;

  // Sanitised payload: NEVER include the free-form before/after blobs (they
  // may carry PII or large jsonb that bloats the alert). hasBefore/hasAfter
  // is enough for the operator to know whether a real diff was being audited.
  const details = {
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    userId: opts.userId,
    hasBefore: opts.before != null,
    hasAfter: opts.after != null,
    errorMessage,
    errorClass,
  };

  // (action|entityType|entityId) — same row failing repeatedly collapses to a
  // single ack-able signature. A null entityId still gets a stable key.
  const suppressionKey = `${opts.action}|${opts.entityType ?? "null"}|${opts.entityId ?? "null"}`;

  try {
    await notifyOperatorWithSuppression(
      {
        source: "audit-log-write-failure",
        severity: "critical",
        title: `Audit log write failed for action=${opts.action}`,
        details: {
          ...details,
          message:
            `An attempt to write an audit_logs row failed (${errorClass}: ${errorMessage}). ` +
            `The surrounding write may or may not have rolled back depending on whether ` +
            `the caller passed a tx handle. Investigate immediately — every state change ` +
            `must produce an audit row.`,
        },
      },
      suppressionKey,
    );
  } catch (alertErr) {
    // Alerting must never mask the original audit error. Log loudly and let
    // the original throw propagate from the caller.
    console.error(
      "[audit] failed to dispatch audit-log-write-failure operator alert",
      alertErr,
    );
  }
}
