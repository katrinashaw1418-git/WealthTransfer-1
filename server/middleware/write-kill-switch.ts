// =============================================================================
// TASK #155 — Express middleware: enforce the write kill switch on the wire
// =============================================================================
// Mounted globally on /api/* AFTER the body parser and rate limit, BEFORE
// the route registrations. For every request that mutates state (POST,
// PATCH, PUT, DELETE) it checks the kill-switch state and either:
//
//   * lets the request through (switch OFF, OR caller is an authenticated
//     admin), OR
//   * responds 503 with the stable JSON shape returned by
//     `WriteKillSwitchError.toJSON()`.
//
// Method bypass:
//   GET, HEAD, and OPTIONS are always allowed — by design. A regulator
//   pulling read-only audit reports must not be blocked by a pause that
//   exists to stop money movement.
//
// Admin bypass:
//   We read the JWT from the Authorization header via `optionalAuth`. If
//   the role is "admin", the request is allowed through. This is the same
//   evaluation `requireRole(auth, "admin")` performs, so the bypass cannot
//   be wider than what admin endpoints already allow. Note that we do NOT
//   attach `req.user` here — admin routes call `requireAuth` themselves
//   so they can keep their own error-handling envelope.
//
// Why JSON, not text:
//   Both the SPA and the SDK consumers parse the response body as JSON;
//   responding with a stable `{ error, code, reason }` object lets them
//   surface the reason without string-matching against the human message.
// =============================================================================

import type { Request, Response, NextFunction } from "express";
import { optionalAuth } from "../auth";
import {
  isWriteBlocked,
  getWriteKillSwitchState,
  WriteKillSwitchError,
  type WriteKillSwitchErrorBody,
} from "../services/write-kill-switch";

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export async function writeKillSwitchMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // GET / HEAD / OPTIONS are always allowed.
  if (!WRITE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Admin bypass — decode the JWT and let role==='admin' through. Any
  // exception here (malformed header, etc.) is treated as "not admin"
  // and falls through to the kill-switch check.
  let isAdmin = false;
  try {
    const auth = optionalAuth(req);
    if (auth && auth.role === "admin") isAdmin = true;
  } catch {
    isAdmin = false;
  }
  if (isAdmin) {
    next();
    return;
  }

  // Cheap cached read — see write-kill-switch.ts cache TTL.
  let blocked = false;
  let reason: string | null = null;
  try {
    blocked = await isWriteBlocked();
    if (blocked) {
      // One extra read to surface the human-readable reason. The state
      // call hits the same cache so this does not double the DB load.
      const state = await getWriteKillSwitchState();
      reason = state.reason;
    }
  } catch (e) {
    // Fail-open on a read error: writes resume. We log loudly so a
    // broken settings table is not silently bypassing the kill switch
    // forever — operators can spot it in the log stream and intervene.
    console.error("[write-kill-switch] failed to read state — failing open", e);
    next();
    return;
  }

  if (!blocked) {
    next();
    return;
  }

  const body: WriteKillSwitchErrorBody = new WriteKillSwitchError(reason).toJSON();
  res.status(503).json(body);
}
