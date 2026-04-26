// =============================================================================
// TASK #94 — WEALTH PLANNER COMPLIANCE SERVICE
// -----------------------------------------------------------------------------
// Hosts the four narrow additions on top of the existing advice stack:
//   - Structured client objectives CRUD (no free-text aggregation gap)
//   - Generic client document store CRUD (fact-finds, ID copies, etc.)
//   - Append-only adviser notes (the table allows new rows; mutation routes
//     are deliberately absent — see server/adviser-routes.ts)
//   - Per-version immutable snapshot of an advice record on issue / supersede
//   - The viewing-ack gate that blocks GET responses for an advice payload
//     until the client has signed at least one adviceAcknowledgement row
//
// All cross-user reads/writes route through assertAdviserClientLink first so
// an adviser can never reach into another adviser's client. The snapshot and
// the viewing gate are pure DB operations and are safe to call from inside
// an outer transaction (they accept an optional executor).
// =============================================================================

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  adviceRecords,
  adviceAcknowledgements,
  adviceRecordVersions,
  clientObjectives,
  clientDocuments,
  adviserNotes,
  type AdviceRecord,
  type ClientObjective,
  type ClientDocument,
  type AdviserNote,
  type AdviceRecordVersion,
} from "@shared/schema";
import { assertAdviserClientLink } from "./adviser-access";
import { requireAdviceRecordWritable } from "./advice-write-gate";

// Drizzle's `db` and the tx handle returned by `db.transaction(async tx =>)`
// share the same query surface; we type the executor loosely to accept either.
type Executor = typeof db;

// ---------------------------------------------------------------------------
// Viewing-ack gate
// ---------------------------------------------------------------------------
// Wraps the existing executionGate philosophy ("re-evaluate live state, never
// trust a cached boolean"). Returns a structured result so the route layer
// can both render a 403 with a useful body AND tell the client UI exactly
// which acknowledgement screen to show.
// ---------------------------------------------------------------------------

export type ViewingGateResult =
  | {
      allowed: true;
      adviceRecordId: number;
      clientId: number;
      acknowledgementId: number;
      acknowledgedAt: Date | null;
    }
  | {
      allowed: false;
      adviceRecordId: number;
      clientId: number;
      reason: "advice_record_not_found" | "wrong_client" | "acknowledgement_missing";
      detail: string;
    };

/**
 * Re-evaluate the viewing gate for the given advice record from live state.
 *
 * Returns allowed=true ONLY when:
 *   - the advice record exists, AND
 *   - it belongs to the supplied clientId, AND
 *   - at least one row exists in adviceAcknowledgements for the
 *     (clientId, adviceRecordId) pair.
 *
 * The eleven specific confirm_* booleans on adviceAcknowledgements are the
 * source of truth for "what did the client tick" — this gate only requires
 * that the row exists, because the client cannot sign the row without ticking
 * every required box (the route that creates it enforces the eleven checks).
 */
export async function requireAcknowledgedAdvice(
  adviceRecordId: number,
  clientId: number,
  executor: Executor = db,
): Promise<ViewingGateResult> {
  const [advice] = await executor
    .select({ id: adviceRecords.id, clientId: adviceRecords.clientId })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, adviceRecordId))
    .limit(1);

  if (!advice) {
    return {
      allowed: false,
      adviceRecordId,
      clientId,
      reason: "advice_record_not_found",
      detail: `No advice record exists for id=${adviceRecordId}`,
    };
  }

  if (advice.clientId !== clientId) {
    return {
      allowed: false,
      adviceRecordId,
      clientId,
      reason: "wrong_client",
      detail: "This advice record does not belong to the requesting client.",
    };
  }

  const [ack] = await executor
    .select({
      id: adviceAcknowledgements.id,
      acceptedAt: adviceAcknowledgements.acceptedAt,
    })
    .from(adviceAcknowledgements)
    .where(
      and(
        eq(adviceAcknowledgements.adviceRecordId, adviceRecordId),
        eq(adviceAcknowledgements.clientId, clientId),
      ),
    )
    .orderBy(desc(adviceAcknowledgements.acceptedAt))
    .limit(1);

  if (!ack) {
    return {
      allowed: false,
      adviceRecordId,
      clientId,
      reason: "acknowledgement_missing",
      detail:
        "Client has not signed an advice acknowledgement for this record. The viewer must show the disclaimer interstitial.",
    };
  }

  return {
    allowed: true,
    adviceRecordId,
    clientId,
    acknowledgementId: ack.id,
    acknowledgedAt: ack.acceptedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Compliance review lock
// ---------------------------------------------------------------------------
// Task #96 — when an advice record is in status 'review_pending' the adviser
// cannot keep mutating the record's structured surface (objectives,
// documents tied to the record, the SOA/status transition itself).
// Notes are deliberately exempt: compliance reviewers need to add notes on
// a record while it is under review, and notes are append-only by design
// (no PATCH/DELETE), so they cannot rewrite the artefact under review.
//
// Throws a 423 Locked with a structured `reason='record_locked_under_review'`
// so the client UI can render an explicit lock banner instead of a generic
// error. The route layer's handleError surfaces both the status and the
// reason verbatim.
// ---------------------------------------------------------------------------
export const REVIEW_LOCK_REASON = "record_locked_under_review";

export async function assertAdviceRecordNotUnderReview(
  adviceRecordId: number,
  executor: Executor = db,
): Promise<void> {
  const [advice] = await executor
    .select({ id: adviceRecords.id, status: adviceRecords.status })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, adviceRecordId))
    .limit(1);
  if (!advice) {
    // Surface as 404 — distinct from the lock so callers don't conflate
    // "missing record" with "record locked under review".
    throw Object.assign(new Error("Advice record not found"), { status: 404 });
  }
  if (advice.status === "review_pending") {
    throw Object.assign(
      new Error("Advice record is locked while under compliance review"),
      { status: 423, reason: REVIEW_LOCK_REASON },
    );
  }
}

// ---------------------------------------------------------------------------
// Advice-record version snapshot hook
// ---------------------------------------------------------------------------
// Called from inside the same DB transaction that flips
// adviceRecords.status to "issued" or "superseded". Computes the next
// versionNumber under that transaction so a race cannot write two rows at
// the same number (UNIQUE INDEX on (adviceRecordId, versionNumber) is the
// belt-and-braces backstop).
// ---------------------------------------------------------------------------

export type SnapshotReason = "issued" | "superseded";

export async function snapshotAdviceRecordVersion(opts: {
  adviceRecordId: number;
  reason: SnapshotReason;
  issuedByUserId: number | null;
  executor?: Executor;
}): Promise<AdviceRecordVersion> {
  const exec = opts.executor ?? db;

  // Pull the FULL advice-record row so the snapshot is self-contained.
  const [advice] = await exec
    .select()
    .from(adviceRecords)
    .where(eq(adviceRecords.id, opts.adviceRecordId))
    .limit(1);
  if (!advice) {
    throw Object.assign(
      new Error(`Cannot snapshot — advice record ${opts.adviceRecordId} not found`),
      { status: 404 },
    );
  }

  // Compute next version number under the executor's lock window. The unique
  // index (adviceRecordId, versionNumber) is the safety net under contention.
  const [maxRow] = await exec
    .select({
      max: sql<number | null>`max(${adviceRecordVersions.versionNumber})`,
    })
    .from(adviceRecordVersions)
    .where(eq(adviceRecordVersions.adviceRecordId, opts.adviceRecordId));
  const nextVersion = (maxRow?.max ?? 0) + 1;

  const [row] = await exec
    .insert(adviceRecordVersions)
    .values({
      adviceRecordId: opts.adviceRecordId,
      versionNumber: nextVersion,
      snapshotReason: opts.reason,
      snapshotJsonb: advice as unknown as Record<string, unknown>,
      issuedByUserId: opts.issuedByUserId,
    })
    .returning();
  return row;
}

/**
 * Convenience helper for the SOA-issuance route (and equivalents):
 *   1. Update the advice-record status (and optional timestamps) on the
 *      passed-in executor.
 *   2. Snapshot the post-update row into adviceRecordVersions.
 *
 * The caller MUST pass a tx handle so both operations succeed-or-fail
 * together. Returns the new version row for audit logging at the route layer.
 *
 * The update payload is built from the typed `TransitionUpdate` shape so we
 * never need an `as any` escape hatch — Drizzle's column inference for
 * `.set()` then validates the field names at compile time.
 */
type TransitionUpdate = {
  status: "issued" | "superseded";
  updatedAt: Date;
  soaIssued?: boolean;
  soaIssuedAt?: Date | null;
};

export async function transitionAdviceStatus(opts: {
  adviceRecordId: number;
  newStatus: "issued" | "superseded";
  issuedByUserId: number;
  executor: Executor;
  extraSets?: Partial<Pick<AdviceRecord, "soaIssued" | "soaIssuedAt">>;
}): Promise<{ advice: AdviceRecord; version: AdviceRecordVersion }> {
  const update: TransitionUpdate = {
    status: opts.newStatus,
    updatedAt: new Date(),
  };
  if (opts.extraSets?.soaIssued !== undefined) {
    update.soaIssued = opts.extraSets.soaIssued;
  }
  if (opts.extraSets?.soaIssuedAt !== undefined) {
    update.soaIssuedAt = opts.extraSets.soaIssuedAt;
  }

  const [advice] = await opts.executor
    .update(adviceRecords)
    .set(update)
    .where(eq(adviceRecords.id, opts.adviceRecordId))
    .returning();
  if (!advice) {
    throw Object.assign(
      new Error(`Advice record ${opts.adviceRecordId} not found`),
      { status: 404 },
    );
  }

  const version = await snapshotAdviceRecordVersion({
    adviceRecordId: opts.adviceRecordId,
    reason: opts.newStatus,
    issuedByUserId: opts.issuedByUserId,
    executor: opts.executor,
  });
  return { advice, version };
}

// ---------------------------------------------------------------------------
// Client objectives CRUD (adviser write, client read)
// ---------------------------------------------------------------------------

export const OBJECTIVE_TYPES = [
  "retirement",
  "education",
  "property",
  "estate",
  "income",
  "other",
] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

export const OBJECTIVE_PRIORITIES = ["primary", "secondary"] as const;
export type ObjectivePriority = (typeof OBJECTIVE_PRIORITIES)[number];

export interface CreateClientObjectiveInput {
  clientId: number;
  adviceRecordId: number;
  objectiveType: ObjectiveType;
  label: string;
  targetAmount?: string | null;
  targetCurrency?: string;
  targetDate?: Date | null;
  priority?: ObjectivePriority;
  notes?: string | null;
}

export async function createClientObjective(
  adviserUserId: number,
  input: CreateClientObjectiveInput,
): Promise<ClientObjective> {
  await assertAdviserClientLink(adviserUserId, input.clientId);

  // The advice record must belong to the same client — defence in depth so an
  // adviser can never tag an objective onto another client's advice record.
  const [advice] = await db
    .select({ id: adviceRecords.id, clientId: adviceRecords.clientId })
    .from(adviceRecords)
    .where(eq(adviceRecords.id, input.adviceRecordId))
    .limit(1);
  if (!advice || advice.clientId !== input.clientId) {
    throw Object.assign(new Error("Advice record not valid for this client"), {
      status: 400,
    });
  }

  // Task #96 — block child writes while a compliance review is in progress.
  // Objectives are an advice-record child by design (the FK is NOT NULL on
  // clientObjectives.adviceRecordId), so the guard always fires here.
  await requireAdviceRecordWritable(input.adviceRecordId);

  const [row] = await db
    .insert(clientObjectives)
    .values({
      clientId: input.clientId,
      adviceRecordId: input.adviceRecordId,
      objectiveType: input.objectiveType,
      label: input.label,
      targetAmount: input.targetAmount ?? null,
      targetCurrency: input.targetCurrency ?? "AUD",
      targetDate: input.targetDate ?? null,
      priority: input.priority ?? "primary",
      notes: input.notes ?? null,
      createdByUserId: adviserUserId,
    })
    .returning();
  return row;
}

export async function listClientObjectivesForAdviser(
  adviserUserId: number,
  clientId: number,
): Promise<ClientObjective[]> {
  await assertAdviserClientLink(adviserUserId, clientId);
  return db
    .select()
    .from(clientObjectives)
    .where(eq(clientObjectives.clientId, clientId))
    .orderBy(desc(clientObjectives.createdAt));
}

export async function listClientObjectivesForClient(
  clientUserId: number,
): Promise<ClientObjective[]> {
  return db
    .select()
    .from(clientObjectives)
    .where(eq(clientObjectives.clientId, clientUserId))
    .orderBy(desc(clientObjectives.createdAt));
}

// ---------------------------------------------------------------------------
// Client documents CRUD (adviser upload, client read)
// ---------------------------------------------------------------------------

export const CLIENT_DOCUMENT_TYPES = [
  "fact_find",
  "risk_questionnaire",
  "id_proof",
  "correspondence",
  "statement",
  "other",
] as const;
export type ClientDocumentType = (typeof CLIENT_DOCUMENT_TYPES)[number];

export interface CreateClientDocumentInput {
  clientId: number;
  adviceRecordId?: number | null;
  documentType: ClientDocumentType;
  fileName: string;
  storageKey: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  description?: string | null;
}

export async function createClientDocument(
  adviserUserId: number,
  input: CreateClientDocumentInput,
): Promise<ClientDocument> {
  await assertAdviserClientLink(adviserUserId, input.clientId);

  if (input.adviceRecordId != null) {
    const [advice] = await db
      .select({ id: adviceRecords.id, clientId: adviceRecords.clientId })
      .from(adviceRecords)
      .where(eq(adviceRecords.id, input.adviceRecordId))
      .limit(1);
    if (!advice || advice.clientId !== input.clientId) {
      throw Object.assign(new Error("Advice record not valid for this client"), {
        status: 400,
      });
    }
    // Task #96 — when a document is being attached to a specific advice
    // record (e.g. a fact-find or risk questionnaire that supports a plan
    // currently under review), respect the same write lock as objectives.
    // Documents uploaded WITHOUT an adviceRecordId are general client
    // documents and are not gated.
    await requireAdviceRecordWritable(input.adviceRecordId);
  }

  const [row] = await db
    .insert(clientDocuments)
    .values({
      clientId: input.clientId,
      adviceRecordId: input.adviceRecordId ?? null,
      documentType: input.documentType,
      fileName: input.fileName,
      storageKey: input.storageKey,
      mimeType: input.mimeType ?? null,
      fileSizeBytes: input.fileSizeBytes ?? null,
      description: input.description ?? null,
      uploadedByUserId: adviserUserId,
    })
    .returning();
  return row;
}

export async function listClientDocumentsForAdviser(
  adviserUserId: number,
  clientId: number,
): Promise<ClientDocument[]> {
  await assertAdviserClientLink(adviserUserId, clientId);
  return db
    .select()
    .from(clientDocuments)
    .where(eq(clientDocuments.clientId, clientId))
    .orderBy(desc(clientDocuments.uploadedAt));
}

export async function listClientDocumentsForClient(
  clientUserId: number,
): Promise<ClientDocument[]> {
  return db
    .select()
    .from(clientDocuments)
    .where(eq(clientDocuments.clientId, clientUserId))
    .orderBy(desc(clientDocuments.uploadedAt));
}

// ---------------------------------------------------------------------------
// Adviser notes — APPEND-ONLY at the route layer.
// ---------------------------------------------------------------------------
// The "no PATCH / no DELETE" promise is enforced by the absence of those
// routes in server/adviser-routes.ts. Editing a note is a brand-new row whose
// previousNoteId points at the row being replaced. The chain stays
// reconstructable because we never null out the prior row.
// ---------------------------------------------------------------------------

export interface CreateAdviserNoteInput {
  clientUserId: number;
  body: string;
  adviceRecordId?: number | null;
  previousNoteId?: number | null;
}

export async function createAdviserNote(
  adviserUserId: number,
  input: CreateAdviserNoteInput,
): Promise<AdviserNote> {
  // Task #96 — adviser_notes are EXPLICITLY EXEMPT from the
  // requireAdviceRecordWritable() lock. The compliance reviewer needs to be
  // able to leave notes on a record while it is in status='review_pending',
  // and the adviser needs to be able to respond. Do NOT add the guard here.
  await assertAdviserClientLink(adviserUserId, input.clientUserId);

  // If this is an "edit" of an existing note, the previous note must belong
  // to the same (adviser, client) pair. Without this check an adviser could
  // chain a new note onto another adviser's note and pollute the audit trail.
  if (input.previousNoteId != null) {
    const [prev] = await db
      .select({
        id: adviserNotes.id,
        adviserUserId: adviserNotes.adviserUserId,
        clientUserId: adviserNotes.clientUserId,
      })
      .from(adviserNotes)
      .where(eq(adviserNotes.id, input.previousNoteId))
      .limit(1);
    if (
      !prev ||
      prev.adviserUserId !== adviserUserId ||
      prev.clientUserId !== input.clientUserId
    ) {
      throw Object.assign(
        new Error("previousNoteId is not a note you can amend for this client"),
        { status: 400 },
      );
    }
  }

  if (input.adviceRecordId != null) {
    const [advice] = await db
      .select({ id: adviceRecords.id, clientId: adviceRecords.clientId })
      .from(adviceRecords)
      .where(eq(adviceRecords.id, input.adviceRecordId))
      .limit(1);
    if (!advice || advice.clientId !== input.clientUserId) {
      throw Object.assign(new Error("Advice record not valid for this client"), {
        status: 400,
      });
    }
  }

  const [row] = await db
    .insert(adviserNotes)
    .values({
      adviserUserId,
      clientUserId: input.clientUserId,
      adviceRecordId: input.adviceRecordId ?? null,
      previousNoteId: input.previousNoteId ?? null,
      body: input.body,
    })
    .returning();
  return row;
}

export async function listAdviserNotes(
  adviserUserId: number,
  clientUserId: number,
): Promise<AdviserNote[]> {
  await assertAdviserClientLink(adviserUserId, clientUserId);
  return db
    .select()
    .from(adviserNotes)
    .where(
      and(
        eq(adviserNotes.adviserUserId, adviserUserId),
        eq(adviserNotes.clientUserId, clientUserId),
      ),
    )
    .orderBy(asc(adviserNotes.createdAt));
}
