// =============================================================================
// TASK #307 — Adviser-route audit helper (fail-closed, request-aware)
// =============================================================================
// The legacy local `audit()` helper inside server/adviser-routes.ts wrote
// directly into auditLogs and swallowed every error. That made it possible
// for a mutation to succeed while its audit row silently dropped — a fatal
// gap for AFSL-grade compliance because a regulator following the
// reconciliation trail would see the state change without the actor row
// that explains it.
//
// recordAdviserAudit() is the single replacement entry-point. It:
//   1. Delegates to writeAuditLog() so every metadata jsonb has the same
//      { before, after, ...extra } shape as the rest of the platform's
//      audit surface (adviser actions show up next to admin actions in
//      the same query).
//   2. Pulls the caller's IP address straight from the Express req so
//      every adviser-route audit row is geo-traceable without each
//      caller having to remember to pass it.
//   3. Is fail-closed at the source — writeAuditLog already pages an
//      operator and re-throws on insert failure. Each route wraps the
//      helper in try/catch so the route can decide whether to roll back
//      its own write (uncommon — most adviser writes are individual
//      single-row updates that have already happened by the time we
//      audit) or 500 the response. In all cases the failure is observed
//      (no swallowing).
// =============================================================================

import type { Request } from "express";
import { writeAuditLog, type WriteAuditLogOpts, type AuditRow } from "./audit";

export interface RecordAdviserAuditOpts
  extends Omit<WriteAuditLogOpts, "ipAddress"> {
  // The Express request — used to capture the caller IP. Pass `null` for
  // background paths (none today, but keeps the helper symmetrical with
  // writeAuditLog).
  req: Request | null;
}

export function getRequestIp(req: Request | null | undefined): string | null {
  if (!req) return null;
  // Express populates req.ip from the socket / X-Forwarded-For chain when
  // app.set('trust proxy', …) is configured. Fall back to socket.remoteAddress
  // so we still capture something on routes that bypass the parser.
  const ip =
    (typeof req.ip === "string" && req.ip) ||
    (req.socket && (req.socket as any).remoteAddress) ||
    null;
  return ip ?? null;
}

export async function recordAdviserAudit(
  opts: RecordAdviserAuditOpts,
): Promise<AuditRow> {
  const { req, ...rest } = opts;
  return writeAuditLog({
    ...rest,
    ipAddress: getRequestIp(req),
  });
}
