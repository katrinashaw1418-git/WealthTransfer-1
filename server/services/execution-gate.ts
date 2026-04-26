// =============================================================================
// LIVE EXECUTION GATE — Phase 2.4 (Session 7)
// =============================================================================
// THIS IS THE AUTHORITATIVE EXECUTION CHECK. Every code path that triggers an
// actual trade, transfer, or money movement on behalf of advice MUST call
// canExecute(adviceRecordId) immediately before doing so.
//
// The `executionAuthorisations` table stores a SNAPSHOT of the gate at the
// moment the client clicked "I authorise execution". Those snapshot booleans
// are AUDIT EVIDENCE only. They prove the gate was satisfied at that moment.
// They DO NOT prove the gate is still satisfied right now.
//
// The classic failure mode this prevents (reviewer's flagged scenario):
//   1. Client signs execution authorisation at 10:00 — fee consent valid.
//   2. Fee consent expires at 12:00.
//   3. System tries to execute at 14:00 using the stale snapshot.
//   4. Trade goes through with no valid fee authority → compliance breach.
//
// To prevent this we recompute the gate from live state on every execution
// attempt: live advice flags + live fee-consent status + live expiry date.
// =============================================================================

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { adviceRecords, feeConsents } from "@shared/schema";

export type ExecutionGateFailureReason =
  | "advice_record_not_found"
  | "soa_not_issued"
  | "soa_not_viewed_or_downloaded"
  | "soa_view_predates_issuance"
  | "advice_not_accepted"
  | "fee_consent_missing"
  | "fee_consent_inactive"
  | "fee_consent_expired";

export type ExecutionGateResult =
  | {
      allowed: true;
      adviceRecordId: number;
      checkedAt: Date;
      // Live snapshot of the values used for this decision — useful when the
      // caller wants to write its own audit row (e.g. the next executionAuthorisation).
      gate: {
        soaIssued: true;
        soaViewedOrDownloaded: true;
        adviceAccepted: true;
        feeConsentActive: true;
        feeConsentExpiry: Date;
      };
    }
  | {
      allowed: false;
      adviceRecordId: number;
      checkedAt: Date;
      reason: ExecutionGateFailureReason;
      detail: string;
    };

/**
 * Re-evaluate the four compliance gates for the given advice record at this
 * exact moment. Returns a structured result so the caller can record WHY a
 * particular execution was blocked (essential for the regulator-facing audit
 * trail).
 *
 * NEVER trust stored gate-snapshot booleans on `executionAuthorisations` to
 * decide whether to execute. Always call this function.
 */
export async function canExecute(
  adviceRecordId: number
): Promise<ExecutionGateResult> {
  const checkedAt = new Date();

  const [advice] = await db
    .select()
    .from(adviceRecords)
    .where(eq(adviceRecords.id, adviceRecordId))
    .limit(1);

  if (!advice) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "advice_record_not_found",
      detail: `No advice record exists for id=${adviceRecordId}`,
    };
  }

  if (!advice.soaIssued) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "soa_not_issued",
      detail: "SOA has not been issued to the client.",
    };
  }

  if (!advice.soaViewed && !advice.soaDownloaded) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "soa_not_viewed_or_downloaded",
      detail:
        "Client must view or download the SOA before execution is permitted.",
    };
  }

  // Compliance hardening: the most recent view/download must come AFTER the
  // SOA was issued. Otherwise the client may have acknowledged a prior version
  // before the current SOA was issued (e.g. SOA was reissued after a material
  // change), which would invalidate the consent. We only enforce this when
  // both timestamps exist; older rows pre-dating timestamp capture are exempt.
  if (advice.soaIssuedAt) {
    const latestEvidence =
      advice.soaDownloaded && advice.soaDownloadedAt
        ? advice.soaDownloadedAt
        : advice.soaViewed && advice.soaViewedAt
          ? advice.soaViewedAt
          : null;
    if (latestEvidence && latestEvidence < advice.soaIssuedAt) {
      return {
        allowed: false,
        adviceRecordId,
        checkedAt,
        reason: "soa_view_predates_issuance",
        detail: `SOA view/download evidence (${latestEvidence.toISOString()}) is earlier than the current SOA issuance (${advice.soaIssuedAt.toISOString()}). The client may have acknowledged a prior version — re-acknowledgement required.`,
      };
    }
  }

  if (!advice.adviceAccepted) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "advice_not_accepted",
      detail: "Client has not formally accepted the advice.",
    };
  }

  // Most recent fee consent for this advice record.
  const [fc] = await db
    .select()
    .from(feeConsents)
    .where(eq(feeConsents.adviceRecordId, adviceRecordId))
    .orderBy(desc(feeConsents.consentedAt))
    .limit(1);

  if (!fc) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "fee_consent_missing",
      detail: "No fee consent has been recorded for this advice record.",
    };
  }

  if (fc.renewalStatus !== "active") {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "fee_consent_inactive",
      detail: `Fee consent is in renewalStatus="${fc.renewalStatus}" — must be "active".`,
    };
  }

  if (!fc.consentExpiryDate || fc.consentExpiryDate <= checkedAt) {
    return {
      allowed: false,
      adviceRecordId,
      checkedAt,
      reason: "fee_consent_expired",
      detail: `Fee consent expired at ${fc.consentExpiryDate?.toISOString() ?? "unknown"}.`,
    };
  }

  return {
    allowed: true,
    adviceRecordId,
    checkedAt,
    gate: {
      soaIssued: true,
      soaViewedOrDownloaded: true,
      adviceAccepted: true,
      feeConsentActive: true,
      feeConsentExpiry: fc.consentExpiryDate,
    },
  };
}

/**
 * Convenience throw-on-fail wrapper for code paths that just want to assert
 * the gate is open before proceeding. Throws an Error whose message names the
 * specific gate that failed.
 */
export async function assertCanExecute(adviceRecordId: number): Promise<void> {
  const result = await canExecute(adviceRecordId);
  if (!result.allowed) {
    throw new Error(
      `Execution blocked for advice ${adviceRecordId}: ${result.reason} — ${result.detail}`
    );
  }
}
