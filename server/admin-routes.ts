// =============================================================================
// SESSION 13 — ADMIN ROUTES (mounted at /api/admin/*)
// -----------------------------------------------------------------------------
// All endpoints in this file:
//   1. require a valid JWT (requireAuth)
//   2. require role === 'admin' (requireRole)
//   3. write an audit_logs entry on every state change
//
// Admins manage:
//   - applications (approve/reject)
//   - adviser users (create + read)
//   - adviser_clients links (assign + activate/deactivate)
//   - audit log (read with filters)
//
// What admins do NOT do here:
//   - move money / execute trades / touch the gated 10C fee engine
//   - bypass KYC (KYC remains the user's responsibility on signup; admin only
//     approves the *application* — i.e. permission to register an account)
//   - alter feeConsents / adviceRecords / instructions (those belong to the
//     adviser layer with full traceability)
// =============================================================================

import type { Express, Request } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "./db";
import {
  auditLogs,
  applications,
  users,
  adviserClients,
  registrationTokens,
} from "@shared/schema";
import { requireAuth, requireRole, hashPassword } from "./auth";

// ---------------------------------------------------------------------------
// Registration-token helpers (Session 14)
// Token security model:
//   - 32 random bytes hex (256-bit entropy)
//   - SHA-256(token) is what we store in the DB; raw token returned ONCE on creation
//   - 48h default expiry, single-use (usedAt enforced)
//   - Email + role are FROZEN at issue time and cannot be overridden by registration form
// ---------------------------------------------------------------------------
const TOKEN_DEFAULT_EXPIRY_HOURS = 48;

function mintRegistrationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function buildRegistrationUrl(req: Request, rawToken: string): string {
  // Best-effort: assemble a relative path; the client can prepend its own origin
  // when sharing externally. This avoids hard-coding a hostname.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "";
  return host ? `${proto}://${host}/register/invite?token=${rawToken}` : `/register/invite?token=${rawToken}`;
}

// ---------------------------------------------------------------------------
// Audit + error helpers
//
// Hard rule: every admin state change must produce an audit_logs row. We
// therefore (a) accept a transaction handle so the audit insert lives in the
// same transaction as the underlying write, and (b) DO NOT swallow errors —
// if the audit insert fails, the surrounding transaction rolls back and the
// caller gets a 500. Fail-closed is the only correct behaviour for an
// AFSL-grade audit trail.
// ---------------------------------------------------------------------------
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function auditTx(
  handle: DbHandle,
  userId: number,
  action: string,
  entityType: string | null,
  entityId: string | null,
  metadata: unknown,
  ipAddress: string | null,
): Promise<void> {
  await (handle as any).insert(auditLogs).values({
    userId,
    action,
    entityType,
    entityId,
    metadata: metadata as any,
    ipAddress,
  });
}

function handleError(res: any, error: any, fallbackMessage: string) {
  if (error?.status) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(`[admin-routes] ${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const applicationStatusValues = [
  "email_unverified",
  "submitted",
  "under_review",
  "approved",
  "rejected",
] as const;

const approveApplicationSchema = z.object({
  reviewNote: z.string().max(2000).optional().nullable(),
});

const rejectApplicationSchema = z.object({
  reviewNote: z.string().min(1, "A reason is required for rejection").max(2000),
});

const inviteUserSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["client", "adviser"]),
  // Optional adviser to auto-link this client to on registration. Server validates
  // that the id refers to a real adviser, and that role === 'client'.
  adviserUserId: z.number().int().positive().optional(),
  // Defaults to 48h on the server. Capped between 1 and 168 (1 week).
  expiryHours: z.number().int().min(1).max(168).optional(),
});

const createAdviserSchema = z.object({
  username: z
    .string()
    .min(3, "username must be at least 3 chars")
    .max(50)
    .regex(/^[a-zA-Z0-9_.-]+$/, "username may only contain letters, numbers, _, ., -"),
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8, "password must be at least 8 chars").max(128),
});

const RELATIONSHIP_TYPES = ["servicing", "introducing", "review_only"] as const;

const createLinkSchema = z.object({
  adviserUserId: z.number().int().positive(),
  clientUserId: z.number().int().positive(),
  relationshipType: z.enum(RELATIONSHIP_TYPES).optional(),
});

const updateLinkSchema = z.object({
  isActive: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerAdminRoutes(app: Express): void {
  // Convenience wrapper: auth + role + try/catch envelope.
  function adminRoute(
    handler: (req: Request, auth: { userId: number; username: string; email: string; role: string }) => Promise<unknown>,
  ) {
    return async (req: Request, res: any) => {
      try {
        const auth = requireAuth(req);
        requireRole(auth, "admin");
        const result = await handler(req, auth);
        res.json(result);
      } catch (error: any) {
        handleError(res, error, "Admin request failed");
      }
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/dashboard — single call for the landing page
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/dashboard",
    adminRoute(async () => {
      const [appsByStatus, advisersCount, clientsCount, linksCount, recentAudit] =
        await Promise.all([
          db
            .select({ status: applications.status, count: sql<number>`count(*)::int` })
            .from(applications)
            .groupBy(applications.status),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.role, "adviser")),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.role, "client")),
          db
            .select({
              total: sql<number>`count(*)::int`,
              active: sql<number>`count(*) filter (where ${adviserClients.isActive} = true)::int`,
            })
            .from(adviserClients),
          db
            .select({
              id: auditLogs.id,
              userId: auditLogs.userId,
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .orderBy(desc(auditLogs.createdAt))
            .limit(15),
        ]);

      const appCounts: Record<string, number> = {
        email_unverified: 0,
        submitted: 0,
        under_review: 0,
        approved: 0,
        rejected: 0,
      };
      for (const row of appsByStatus) {
        appCounts[row.status] = Number(row.count);
      }

      return {
        applications: {
          ...appCounts,
          pending: (appCounts.submitted ?? 0) + (appCounts.under_review ?? 0),
          total: Object.values(appCounts).reduce((a, b) => a + b, 0),
        },
        advisers: { total: Number(advisersCount[0]?.count ?? 0) },
        clients: { total: Number(clientsCount[0]?.count ?? 0) },
        adviserClients: {
          total: Number(linksCount[0]?.total ?? 0),
          active: Number(linksCount[0]?.active ?? 0),
        },
        recentAudit,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/applications",
    adminRoute(async (req) => {
      const status = typeof req.query.status === "string" ? req.query.status : null;
      const validStatus =
        status && (applicationStatusValues as readonly string[]).includes(status)
          ? status
          : null;

      const rows = await db
        .select()
        .from(applications)
        .where(validStatus ? eq(applications.status, validStatus) : sql`true`)
        .orderBy(desc(applications.createdAt))
        .limit(200);

      return rows;
    }),
  );

  app.post(
    "/api/admin/applications/:id/approve",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid application id"), { status: 400 });
      }
      const parsed = approveApplicationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid payload"), { status: 400 });
      }

      const [existing] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Application not found"), { status: 404 });
      }
      if (existing.status === "approved") {
        throw Object.assign(new Error("Application is already approved"), { status: 409 });
      }
      if (existing.status === "rejected") {
        throw Object.assign(new Error("Cannot approve a rejected application"), { status: 409 });
      }
      if (!existing.emailVerified) {
        throw Object.assign(
          new Error("Cannot approve: applicant has not verified their email"),
          { status: 409 },
        );
      }

      // Mint registration token in the same tx as the approval + audit. This
      // closes the loop from "approved application" → "user can actually sign up"
      // (Session 14). Without a token, an approved applicant has no path forward.
      const { raw: rawToken, hash: tokenHash } = mintRegistrationToken();
      const expiresAt = new Date(Date.now() + TOKEN_DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);

      let result;
      try {
        result = await db.transaction(async (tx) => {
        // Atomic status gate: only flip to 'approved' if the row is still in a
        // pre-decision state. If two operators race, the loser sees [] back and
        // we throw 409 — preventing duplicate approve+token-mint pairs.
        const [row] = await (tx as any)
          .update(applications)
          .set({
            status: "approved",
            reviewNote: parsed.data.reviewNote ?? existing.reviewNote ?? null,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(applications.id, id),
              sql`${applications.status} NOT IN ('approved', 'rejected')`,
            ),
          )
          .returning();
        if (!row) {
          throw Object.assign(
            new Error("Application status changed concurrently — please refresh and try again."),
            { status: 409 },
          );
        }
        await auditTx(
          tx,
          auth.userId,
          "admin_application_approved",
          "application",
          String(id),
          {
            email: existing.email,
            previousStatus: existing.status,
            reviewNote: parsed.data.reviewNote ?? null,
          },
          req.ip || null,
        );

        // Revoke any prior unused tokens for this email so only the freshest is live.
        await (tx as any)
          .update(registrationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(registrationTokens.email, existing.email),
              isNull(registrationTokens.usedAt),
            ),
          );

        await (tx as any).insert(registrationTokens).values({
          email: existing.email,
          role: "client",
          relatedEntityType: "application",
          relatedEntityId: id,
          adviserUserId: null,
          tokenHash,
          expiresAt,
          createdBy: auth.userId,
        });

        await auditTx(
          tx,
          auth.userId,
          "invite_created",
          "registration_token",
          existing.email,
          {
            role: "client",
            source: "application_approved",
            applicationId: id,
            expiresAt: expiresAt.toISOString(),
          },
          req.ip || null,
        );
        return row;
        });
      } catch (err: any) {
        // Partial unique index `registration_tokens_email_active_unique` enforces
        // "at most one live token per email". A concurrent issuer racing us hits
        // 23505; translate to a deterministic 409 instead of a 500.
        if (err?.code === "23505" && String(err?.constraint || "").includes("registration_tokens_email_active")) {
          throw Object.assign(
            new Error("Another invitation is already in flight for this email — please refresh and retry."),
            { status: 409 },
          );
        }
        throw err;
      }

      return {
        application: result,
        registrationToken: rawToken,
        registrationUrl: buildRegistrationUrl(req, rawToken),
        expiresAt: expiresAt.toISOString(),
      };
    }),
  );

  app.post(
    "/api/admin/applications/:id/reject",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid application id"), { status: 400 });
      }
      const parsed = rejectApplicationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }

      const [existing] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Application not found"), { status: 404 });
      }
      if (existing.status === "rejected") {
        throw Object.assign(new Error("Application is already rejected"), { status: 409 });
      }
      if (existing.status === "approved") {
        throw Object.assign(new Error("Cannot reject an approved application"), { status: 409 });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(applications)
          .set({
            status: "rejected",
            reviewNote: parsed.data.reviewNote,
            reviewedAt: new Date(),
          })
          .where(eq(applications.id, id))
          .returning();
        await auditTx(
          tx,
          auth.userId,
          "admin_application_rejected",
          "application",
          String(id),
          {
            email: existing.email,
            previousStatus: existing.status,
            reviewNote: parsed.data.reviewNote,
          },
          req.ip || null,
        );
        return row;
      });

      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // Direct invites (Session 14) — admin issues a registration token without
  // going through the full /apply flow. Used to onboard advisers, or to
  // pre-link a client to a specific adviser at issue time.
  //
  // Security:
  //   - Admin-only (requireRole enforced by adminRoute wrapper).
  //   - Email is frozen on the token; registration form cannot override it.
  //   - Role is frozen on the token; cannot self-promote to adviser.
  //   - If role=client + adviserUserId set, the new client is auto-linked to that
  //     adviser via adviser_clients on registration (in the same registration tx).
  //   - Existing live tokens for the same email are revoked (only newest is valid).
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/invite",
    adminRoute(async (req, auth) => {
      const parsed = inviteUserSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const { email, role, adviserUserId, expiryHours } = parsed.data;
      const normalisedEmail = email.toLowerCase();

      // Reject if a real account already exists.
      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalisedEmail))
        .limit(1);
      if (existingUser) {
        throw Object.assign(
          new Error("A user with this email already exists"),
          { status: 409 },
        );
      }

      // If linking to an adviser, the adviser must exist + be role=adviser.
      if (adviserUserId !== undefined) {
        if (role !== "client") {
          throw Object.assign(
            new Error("adviserUserId can only be set when role is 'client'"),
            { status: 400 },
          );
        }
        const [adv] = await db
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.id, adviserUserId))
          .limit(1);
        if (!adv || adv.role !== "adviser") {
          throw Object.assign(
            new Error("adviserUserId does not refer to an adviser"),
            { status: 400 },
          );
        }
      }

      const { raw: rawToken, hash: tokenHash } = mintRegistrationToken();
      const hours = expiryHours ?? TOKEN_DEFAULT_EXPIRY_HOURS;
      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

      try {
        await db.transaction(async (tx) => {
          // Revoke any prior live tokens for this email so only the freshest is valid.
          await (tx as any)
            .update(registrationTokens)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(registrationTokens.email, normalisedEmail),
                isNull(registrationTokens.usedAt),
              ),
            );

          await (tx as any).insert(registrationTokens).values({
            email: normalisedEmail,
            role,
            relatedEntityType: "invite",
            relatedEntityId: null,
            adviserUserId: adviserUserId ?? null,
            tokenHash,
            expiresAt,
            createdBy: auth.userId,
          });

          await auditTx(
            tx,
            auth.userId,
            "invite_created",
            "registration_token",
            normalisedEmail,
            {
              role,
              source: "direct_invite",
              adviserUserId: adviserUserId ?? null,
              expiresAt: expiresAt.toISOString(),
            },
            req.ip || null,
          );
        });
      } catch (err: any) {
        // Partial unique index ensures only one live token per email; concurrent
        // issuers race here. Translate the unique-violation to a clean 409.
        if (err?.code === "23505" && String(err?.constraint || "").includes("registration_tokens_email_active")) {
          throw Object.assign(
            new Error("Another invitation is already in flight for this email — please refresh and retry."),
            { status: 409 },
          );
        }
        throw err;
      }

      return {
        email: normalisedEmail,
        role,
        registrationToken: rawToken,
        registrationUrl: buildRegistrationUrl(req, rawToken),
        expiresAt: expiresAt.toISOString(),
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Advisers
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/advisers",
    adminRoute(async () => {
      // Count active client links per adviser in a single round trip.
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          createdAt: users.createdAt,
          activeClients: sql<number>`(
            SELECT COUNT(*)::int FROM ${adviserClients}
            WHERE ${adviserClients.adviserUserId} = ${users.id}
              AND ${adviserClients.isActive} = true
          )`,
        })
        .from(users)
        .where(eq(users.role, "adviser"))
        .orderBy(asc(users.username));

      return rows;
    }),
  );

  app.post(
    "/api/admin/advisers",
    adminRoute(async (req, auth) => {
      const parsed = createAdviserSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const data = parsed.data;

      // Uniqueness checks (race-tolerated by the unique indexes too)
      const [byName] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, data.username))
        .limit(1);
      if (byName) {
        throw Object.assign(new Error("Username is already taken"), { status: 409 });
      }
      const [byEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);
      if (byEmail) {
        throw Object.assign(new Error("Email is already in use"), { status: 409 });
      }

      const hashed = await hashPassword(data.password);
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            username: data.username,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            password: hashed,
            role: "adviser",
            // KYC is for retail clients; adviser staff don't go through the
            // same onboarding path. Mark verified so the new adviser can sign in.
            kycStatus: "verified",
            emailVerified: true,
          })
          .returning({
            id: users.id,
            username: users.username,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            createdAt: users.createdAt,
          });
        await auditTx(
          tx,
          auth.userId,
          "admin_adviser_created",
          "user",
          String(row.id),
          { username: row.username, email: row.email },
          req.ip || null,
        );
        return row;
      });

      return { ...created, activeClients: 0 };
    }),
  );

  // -------------------------------------------------------------------------
  // Clients (read-only — used by the "assign client" picker)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/clients",
    adminRoute(async (req) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const where = q
        ? sql`${users.role} = 'client' AND (
            ${users.username} ILIKE ${"%" + q + "%"} OR
            ${users.email} ILIKE ${"%" + q + "%"} OR
            ${users.firstName} ILIKE ${"%" + q + "%"} OR
            ${users.lastName} ILIKE ${"%" + q + "%"}
          )`
        : eq(users.role, "client");

      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          kycStatus: users.kycStatus,
        })
        .from(users)
        .where(where)
        .orderBy(asc(users.username))
        .limit(100);

      return rows;
    }),
  );

  // -------------------------------------------------------------------------
  // Adviser-client links
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/adviser-clients",
    adminRoute(async () => {
      // We join twice on `users` (once for adviser, once for client) by aliasing
      // on the SQL side. Drizzle's typed select handles this cleanly with sql<T>.
      const rows = await db
        .select({
          id: adviserClients.id,
          adviserUserId: adviserClients.adviserUserId,
          clientUserId: adviserClients.clientUserId,
          relationshipType: adviserClients.relationshipType,
          isActive: adviserClients.isActive,
          linkedAt: adviserClients.linkedAt,
          unlinkedAt: adviserClients.unlinkedAt,
          adviserUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${adviserClients.adviserUserId})`,
          adviserEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${adviserClients.adviserUserId})`,
          clientUsername: sql<string>`(SELECT username FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientEmail: sql<string>`(SELECT email FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientFirstName: sql<string>`(SELECT first_name FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
          clientLastName: sql<string>`(SELECT last_name FROM ${users} u WHERE u.id = ${adviserClients.clientUserId})`,
        })
        .from(adviserClients)
        .orderBy(desc(adviserClients.linkedAt))
        .limit(500);

      return rows;
    }),
  );

  app.post(
    "/api/admin/adviser-clients",
    adminRoute(async (req, auth) => {
      const parsed = createLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(
          new Error("Invalid payload: " + parsed.error.issues.map((i) => i.message).join("; ")),
          { status: 400 },
        );
      }
      const data = parsed.data;

      // Validate both ends actually exist with the right roles.
      const [adviser] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, data.adviserUserId))
        .limit(1);
      if (!adviser) {
        throw Object.assign(new Error("Adviser not found"), { status: 404 });
      }
      if (adviser.role !== "adviser") {
        throw Object.assign(new Error("Target user is not an adviser"), { status: 400 });
      }
      const [client] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, data.clientUserId))
        .limit(1);
      if (!client) {
        throw Object.assign(new Error("Client not found"), { status: 404 });
      }
      if (client.role !== "client") {
        throw Object.assign(new Error("Target user is not a client"), { status: 400 });
      }

      // If a link already exists for this pair, don't create a duplicate —
      // re-activate the existing row instead. The unique index would block
      // double-inserts anyway, but this gives a friendly response.
      const [existing] = await db
        .select()
        .from(adviserClients)
        .where(
          and(
            eq(adviserClients.adviserUserId, data.adviserUserId),
            eq(adviserClients.clientUserId, data.clientUserId),
          ),
        )
        .limit(1);

      const result = await db.transaction(async (tx) => {
        let row;
        let action: string;
        if (existing) {
          const [updated] = await tx
            .update(adviserClients)
            .set({
              isActive: true,
              unlinkedAt: null,
              relationshipType: data.relationshipType ?? existing.relationshipType,
            })
            .where(eq(adviserClients.id, existing.id))
            .returning();
          row = updated;
          action = "admin_adviser_client_reactivated";
        } else {
          const [inserted] = await tx
            .insert(adviserClients)
            .values({
              adviserUserId: data.adviserUserId,
              clientUserId: data.clientUserId,
              relationshipType: data.relationshipType ?? "servicing",
              isActive: true,
            })
            .returning();
          row = inserted;
          action = "admin_adviser_client_linked";
        }
        await auditTx(
          tx,
          auth.userId,
          action,
          "adviser_client",
          String(row.id),
          {
            adviserUserId: data.adviserUserId,
            clientUserId: data.clientUserId,
            relationshipType: row.relationshipType,
          },
          req.ip || null,
        );
        return row;
      });

      return result;
    }),
  );

  app.patch(
    "/api/admin/adviser-clients/:id",
    adminRoute(async (req, auth) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("Invalid link id"), { status: 400 });
      }
      const parsed = updateLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid payload"), { status: 400 });
      }

      const [existing] = await db
        .select()
        .from(adviserClients)
        .where(eq(adviserClients.id, id))
        .limit(1);
      if (!existing) {
        throw Object.assign(new Error("Link not found"), { status: 404 });
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(adviserClients)
          .set({
            isActive: parsed.data.isActive,
            unlinkedAt: parsed.data.isActive ? null : new Date(),
          })
          .where(eq(adviserClients.id, id))
          .returning();
        await auditTx(
          tx,
          auth.userId,
          parsed.data.isActive ? "admin_adviser_client_reactivated" : "admin_adviser_client_deactivated",
          "adviser_client",
          String(id),
          {
            adviserUserId: existing.adviserUserId,
            clientUserId: existing.clientUserId,
            previousIsActive: existing.isActive,
          },
          req.ip || null,
        );
        return row;
      });

      return updated;
    }),
  );

  // -------------------------------------------------------------------------
  // Audit log viewer (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/audit-logs",
    adminRoute(async (req) => {
      const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
      const entityType = typeof req.query.entityType === "string" ? req.query.entityType.trim() : "";
      const userIdRaw = typeof req.query.userId === "string" ? Number(req.query.userId) : null;
      const userId = userIdRaw && Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : null;

      const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        200,
      );
      const page = Math.max(Number(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;

      const conditions = [] as any[];
      if (action) conditions.push(ilike(auditLogs.action, `%${action}%`));
      if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
      if (userId) conditions.push(eq(auditLogs.userId, userId));
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totalRow] = await Promise.all([
        db
          .select({
            id: auditLogs.id,
            userId: auditLogs.userId,
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            metadata: auditLogs.metadata,
            ipAddress: auditLogs.ipAddress,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(where as any)
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(where as any),
      ]);

      return {
        items: rows,
        page,
        limit,
        total: Number(totalRow[0]?.count ?? 0),
      };
    }),
  );
}
