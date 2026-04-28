// =============================================================================
// Task #471 — Canonical six-term consent status vocabulary
// -----------------------------------------------------------------------------
// Adviser-facing surfaces (Dashboard, Fee consents, Fee rules, Client detail)
// must render every consent status pill and filter option using exactly one of
// these six display labels. Backend column values do NOT change — this file is
// a pure display-layer mapping so a future audit can confirm by ripgrepping
// the surface files for these strings (and finding no others).
//
//   Active           — signed and currently in force
//   Sent             — request emailed, not yet acted on by the client
//   Pending signature — request awaiting the client's signature
//   Superseded       — replaced by a fresher request or executed consent
//   Expired          — past its consent_expiry_date
//   Revoked          — declined by client OR withdrawn by adviser
//
// Two source-of-truth lifecycles feed into the display layer:
//
//   `fee_consent_requests.status` (pre-signature lifecycle):
//       pending | consented | declined | withdrawn_by_adviser | superseded
//
//   `fee_consents.renewal_status` (signed-consent lifecycle):
//       active | renewal_due | expired | withdrawn | renewed | superseded
//
// The two helpers below normalise each lifecycle into the canonical set. A
// single Badge variant chooser keeps colour signalling consistent across
// every page that imports this module.
// =============================================================================

export type ConsentDisplayStatus =
  | "active"
  | "sent"
  | "pending_signature"
  | "superseded"
  | "expired"
  | "revoked";

export const CONSENT_DISPLAY_STATUSES: readonly ConsentDisplayStatus[] = [
  "active",
  "sent",
  "pending_signature",
  "superseded",
  "expired",
  "revoked",
] as const;

export const CONSENT_STATUS_LABELS: Record<ConsentDisplayStatus, string> = {
  active: "Active",
  sent: "Sent",
  pending_signature: "Pending signature",
  superseded: "Superseded",
  expired: "Expired",
  revoked: "Revoked",
};

export function consentStatusLabel(status: ConsentDisplayStatus): string {
  return CONSENT_STATUS_LABELS[status];
}

// shadcn Badge variant for each canonical status. Active is the only "good"
// state (default = brand colour); pre-signature states are neutral; terminal
// negative states (expired, revoked) are destructive so they can't be missed.
export type ConsentBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "destructive";

export function consentStatusBadgeVariant(
  status: ConsentDisplayStatus,
): ConsentBadgeVariant {
  switch (status) {
    case "active":
      return "default";
    case "sent":
      return "secondary";
    case "pending_signature":
      return "secondary";
    case "superseded":
      return "outline";
    case "expired":
      return "destructive";
    case "revoked":
      return "destructive";
  }
}

// fee_consent_requests.status -> display status.
// `pending` collapses to "Pending signature" — there is currently no separate
// "viewed but not signed" sub-state in the schema, so every pre-signature
// request renders the same way. The "Sent" label is reserved for a future
// delivery sub-state (kept in the canonical vocabulary so surfaces don't have
// to grow when that lands).
export function consentRequestDisplayStatus(
  status: string,
): ConsentDisplayStatus {
  switch (status) {
    case "pending":
      return "pending_signature";
    case "consented":
      return "active";
    case "declined":
    case "withdrawn_by_adviser":
      return "revoked";
    case "superseded":
      return "superseded";
    default:
      // Defensive — unknown values surface as "Pending signature" rather than
      // leaking a raw enum string. The brief forbids any string outside the
      // six canonical terms appearing in adviser pills.
      return "pending_signature";
  }
}

// fee_consents.renewal_status -> display status. Computed expiry beats the
// stored renewalStatus when the expiry date has already passed (matches the
// behaviour the adviser expects on a stale row that hasn't been swept yet).
export function consentRenewalDisplayStatus(
  renewalStatus: string,
  expiryDate?: Date | string | null,
  now: Date = new Date(),
): ConsentDisplayStatus {
  const s = (renewalStatus ?? "").toLowerCase();
  if (s === "withdrawn") return "revoked";
  if (s === "expired") return "expired";
  if (s === "renewed" || s === "superseded") return "superseded";
  // active | renewal_due — defer to computed expiry first.
  if (expiryDate) {
    const exp =
      expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
    if (Number.isFinite(exp.getTime()) && exp.getTime() < now.getTime()) {
      return "expired";
    }
  }
  return "active";
}

// Convenience for joined `consent_*` columns surfaced on the Fee rules page.
// The adviser sees withdrawn → "Revoked", expired → "Expired", otherwise
// "Active" (Signed) — the same ladder as `consentRenewalDisplayStatus` but
// expressed against the joined columns the rules query exposes.
export function consentContextDisplayStatus(input: {
  renewalStatus: string | null;
  expiryDate: string | null;
  withdrawnAt: string | null;
}): ConsentDisplayStatus | null {
  if (!input.renewalStatus && !input.expiryDate && !input.withdrawnAt) {
    return null;
  }
  if (input.withdrawnAt) return "revoked";
  return consentRenewalDisplayStatus(
    input.renewalStatus ?? "",
    input.expiryDate,
  );
}
