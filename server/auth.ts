import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// isLocalDev: true only when both NODE_ENV=development AND an explicit
// APP_ENV=local or ALLOW_LOCAL_DEV_AUTH=true signal is present.
// This prevents dev shortcuts from silently activating in shared staging
// environments that happen to have NODE_ENV=development.
export const isLocalDev =
  process.env.NODE_ENV === "development" &&
  (process.env.APP_ENV === "local" || process.env.ALLOW_LOCAL_DEV_AUTH === "true");

// JWT_SECRET must be set explicitly in any environment that is not isolated
// local development.
if (!process.env.JWT_SECRET && !isLocalDev) {
  throw new Error("FATAL: JWT_SECRET environment variable must be set outside local development.");
}
const JWT_SECRET = process.env.JWT_SECRET || "amax-local-dev-only-secret";
const JWT_EXPIRY = "24h";

export interface AuthPayload {
  userId: number;
  username: string;
  email: string;
  // Session 3 — Phase 1: role propagation for B2B adviser overlay.
  // "client" (default for legacy tokens) | "adviser". Other values reserved.
  role: string;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Partial<AuthPayload> & { userId: number; username: string; email: string };
    // Backward-compatible default: tokens issued before Session 3 (no role claim)
    // are treated as "client". This avoids forcing a global re-login on rollout.
    return {
      userId: decoded.userId,
      username: decoded.username,
      email: decoded.email,
      role: decoded.role ?? "client",
    };
  } catch {
    return null;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  if (hashed.startsWith("$2")) {
    return bcrypt.compare(plain, hashed);
  }
  // Plaintext fallback: allowed ONLY in isolated local development.
  // In shared staging or production, if the stored value is not a bcrypt hash,
  // we refuse the comparison rather than silently accepting it.
  if (isLocalDev) {
    return plain === hashed;
  }
  return false;
}

export function requireAuth(req: Request): AuthPayload {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error("Unauthorized — no token provided");
    (err as any).status = 401;
    throw err;
  }
  const payload = verifyToken(token);
  if (!payload) {
    const err = new Error("Unauthorized — invalid or expired token");
    (err as any).status = 401;
    throw err;
  }
  return payload;
}

export function optionalAuth(req: Request): AuthPayload | null {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    const payload = requireAuth(req);
    (req as any).user = payload;
    next();
  } catch (err: any) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Role enforcement — throws 403 if the caller's role is not in `allowed`.
// Use with: const auth = requireAuth(req); requireRole(auth, "adviser");
//
// Why a list rather than a single role: future routes may want
// `requireRole(auth, "adviser", "compliance")` without two layers of guards.
//
// Why explicit (not "default-deny client"): the existing client-facing routes
// outnumber adviser routes 50:1, and quietly demoting them to a stricter
// default would break every existing endpoint. Explicit guards are louder
// in code review.
// ---------------------------------------------------------------------------
export function requireRole(auth: AuthPayload, ...allowed: string[]): void {
  if (!allowed.includes(auth.role)) {
    throw Object.assign(
      new Error(`Forbidden — this endpoint requires role: ${allowed.join(" or ")}`),
      { status: 403 }
    );
  }
}

// ---------------------------------------------------------------------------
// KYC enforcement — throws 403 if the user's KYC is not "verified".
// Call after requireAuth on all money-movement routes.
// Intentionally async so it reads the current DB state on every call.
// ---------------------------------------------------------------------------
export async function requireKyc(userId: number, storageInstance: { getUser: (id: number) => Promise<any> }): Promise<void> {
  const user = await storageInstance.getUser(userId);
  if (!user) {
    throw Object.assign(new Error("User not found"), { status: 401 });
  }
  if (user.kycStatus !== "verified") {
    throw Object.assign(
      new Error("KYC verification required. Please complete identity verification to perform transactions."),
      { status: 403 }
    );
  }
}
