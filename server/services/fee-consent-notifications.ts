// =============================================================================
// Task #301 — fee-consent request client notification helper
// =============================================================================
// Shared by:
//   - server/adviser-routes.ts  POST /api/adviser/fee-consent-requests
//   - server/admin-routes.ts    POST /api/admin/fee-consents/:id/supersede
//
// Why both go through one helper:
//   The two routes create the SAME shape of pending request row from the
//   client's perspective (a fresh `feeConsentRequests` insert that the
//   client must sign). If we duplicated the email + audit-log block in two
//   places they would inevitably drift — different audit action names, or
//   one route forgetting to record a "no email on file" failure. One
//   helper keeps the audit shape (action, entityType, entityId, before/
//   after, extra) identical regardless of which route triggered it, so the
//   admin "fee-consent activity" view doesn't have to special-case the
//   trigger source.
//
// What it does:
//   1. Looks up the client's email + first name and the adviser's display
//      name (best-effort — a missing user row OR a missing email is
//      recorded as a `_failed` audit row, never a thrown exception).
//   2. Calls sendFeeConsentRequestEmail. SMTP-not-configured returns
//      `{ sent: false, error: "SMTP not configured ..." }` so dev / preview
//      runs still produce an audit row proving "we tried".
//   3. Writes ONE audit_logs row keyed to the request id with action
//      `fee_consent_request.client_notified` (success) or
//      `fee_consent_request.client_notification_failed` (any failure mode
//      — missing email, lookup error, SMTP error). The row carries
//      `signLink`, `trigger`, `recipientEmail`, `feeType`, and on failure
//      the `error` string so an operator can chase the bounce without
//      tailing logs.
//
// What it deliberately does NOT do:
//   - Throw. The caller (the route) has already returned 2xx for the row
//     insert; bubbling a notification failure up would turn the row
//     creation into a 5xx and the caller would retry, double-creating
//     requests. Errors are caught, logged, and folded into the audit row.
//   - Block on SMTP retries. One attempt, one audit row. Resending is a
//     separate operator workflow (out of scope for #301).
// =============================================================================

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";
import { sendFeeConsentRequestEmail, type FeeConsentRequestEmailTrigger } from "../email";
import { writeAuditLog } from "./audit";

export interface NotifyClientOfFeeConsentRequestArgs {
  // The freshly inserted feeConsentRequests row. We need at least the
  // `id`, `clientUserId`, `adviserUserId`, and `feeType` fields so the
  // helper stays decoupled from the route-specific column projections.
  requestRow: {
    id: number;
    clientUserId: number;
    adviserUserId: number;
    feeType: string;
  };
  // The user that initiated the action (the adviser for /api/adviser/...,
  // the admin for /api/admin/.../supersede). Stamped on the audit row's
  // `userId` so the trigger source is unambiguous.
  adviserUserId: number;
  trigger: FeeConsentRequestEmailTrigger;
  ipAddress: string | null;
}

export interface NotifyClientOfFeeConsentRequestResult {
  sent: boolean;
  error?: string;
  signLink: string;
  recipientEmail: string | null;
}

export async function notifyClientOfFeeConsentRequest(
  args: NotifyClientOfFeeConsentRequestArgs,
): Promise<NotifyClientOfFeeConsentRequestResult> {
  const { requestRow, adviserUserId, trigger, ipAddress } = args;

  // Resolve client + adviser display info. Two separate selects (rather
  // than a join) so a failure on one lookup doesn't poison the other.
  let clientEmail: string | null = null;
  let clientFirstName: string | null = null;
  let adviserName: string | null = null;
  let lookupError: string | null = null;
  try {
    const [client] = await db
      .select({ email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, requestRow.clientUserId));
    clientEmail = client?.email ?? null;
    clientFirstName = client?.firstName ?? null;
  } catch (err: any) {
    lookupError = `client lookup failed: ${err?.message || String(err)}`;
  }
  try {
    const [adviser] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, requestRow.adviserUserId));
    if (adviser) {
      adviserName = `${adviser.firstName ?? ""} ${adviser.lastName ?? ""}`
        .trim() || null;
    }
  } catch {
    // Adviser display name is cosmetic — fall through with null.
  }

  let dispatch: { sent: boolean; error?: string; signLink: string };
  if (lookupError) {
    dispatch = {
      sent: false,
      error: lookupError,
      // Even on lookup failure we still know the request id, so we can
      // build the deep-link the email WOULD have carried. This means the
      // audit row is uniformly shaped regardless of failure mode.
      signLink: buildSignLink(requestRow.id),
    };
  } else if (!clientEmail) {
    dispatch = {
      sent: false,
      error: "client has no email address on file",
      signLink: buildSignLink(requestRow.id),
    };
  } else {
    try {
      dispatch = await sendFeeConsentRequestEmail({
        to: clientEmail,
        firstName: clientFirstName || "there",
        requestId: requestRow.id,
        feeType: requestRow.feeType,
        trigger,
        adviserName,
      });
    } catch (err: any) {
      // sendFeeConsentRequestEmail returns a structured result rather than
      // throwing on SMTP failure, but we still wrap to defend against an
      // unexpected throw inside the renderer (e.g. nodemailer init).
      dispatch = {
        sent: false,
        error: err?.message || String(err) || "send failed",
        signLink: buildSignLink(requestRow.id),
      };
    }
  }

  // Audit row — single source of truth for "did we try, did it land". The
  // emit itself is wrapped because writeAuditLog can throw on a DB outage,
  // and a failed audit row must NEVER bubble back into the route (which
  // has already 2xx'd the row creation).
  try {
    await writeAuditLog({
      userId: adviserUserId,
      action: dispatch.sent
        ? "fee_consent_request.client_notified"
        : "fee_consent_request.client_notification_failed",
      entityType: "fee_consent_request",
      entityId: String(requestRow.id),
      before: null,
      after: { notifiedAt: new Date().toISOString() },
      extra: {
        trigger,
        signLink: dispatch.signLink,
        recipientEmail: clientEmail,
        clientUserId: requestRow.clientUserId,
        adviserUserId: requestRow.adviserUserId,
        feeType: requestRow.feeType,
        ...(dispatch.error ? { error: dispatch.error } : {}),
      },
      ipAddress,
    });
  } catch (auditErr: any) {
    // Best-effort: writeAuditLog already raises an operator alert via
    // recordAuditWriteFailure / emitAuditWriteFailureAlert, so we just
    // log and swallow here so the route's 2xx isn't compromised.
    console.error(
      `[fee-consent-notifications] audit log FAILED for request #${requestRow.id}:`,
      auditErr?.message || auditErr,
    );
  }

  return {
    sent: dispatch.sent,
    error: dispatch.error,
    signLink: dispatch.signLink,
    recipientEmail: clientEmail,
  };
}

function buildSignLink(requestId: number): string {
  const path = `/client/fee-consents?request=${requestId}`;
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}
