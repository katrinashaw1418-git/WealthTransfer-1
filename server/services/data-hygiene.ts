// =============================================================================
// Task #283 — adviser data hygiene at boot
// -----------------------------------------------------------------------------
// One-shot, idempotent hygiene pass that runs once during server boot.
//
// CONTEXT
// -------
// During pre-launch testing of the adviser portal, dev DBs accumulated a
// handful of placeholder client rows (e.g. firstName="Linked", lastName=
// "Client") that were never tied to a real human and that leaked into
// adviser-facing surfaces (Top Portfolios, Linked Clients) as if they were
// real client names. The render-layer fallback chain
// `name -> email -> Client #<id>` already handles missing names correctly,
// so the right move is to NULL the placeholder identity at the data layer
// rather than special-case the literal string in every render call.
//
// HARD RULES
// ----------
//   - Operates ONLY on the `users` table, ONLY on first_name / last_name.
//     Email, password, kycStatus, role, and every other field are
//     untouched.
//   - The match is exact-string against a hardcoded allowlist of known
//     placeholder pairs. Any real user whose first/last name happens to
//     differ from the allowlist by even one character is invisible to
//     this module.
//   - Idempotent — re-running it on a clean DB is a no-op.
//   - first_name / last_name are NOT NULL in the schema, so the cleanup
//     writes empty strings (which the render fallback chain treats as
//     missing).
//   - Per-row failures are caught and surfaced in the summary; one bad
//     row never aborts the rest.
// =============================================================================

import { db } from "../db";
import { users } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";

export interface DataHygieneSummary {
  placeholderNamesScanned: number;
  placeholderNamesCleared: number;
  errors: number;
}

// Exact-match (firstName, lastName) pairs that we know are dev-fixture
// placeholders, never a real human's name. Keep this list short and
// auditable — every entry is a deliberate decision.
export const PLACEHOLDER_NAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Linked", "Client"],
];

export async function clearPlaceholderClientNames(): Promise<DataHygieneSummary> {
  const summary: DataHygieneSummary = {
    placeholderNamesScanned: 0,
    placeholderNamesCleared: 0,
    errors: 0,
  };

  for (const [firstName, lastName] of PLACEHOLDER_NAME_PAIRS) {
    try {
      const matches = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.firstName, firstName), eq(users.lastName, lastName)));

      summary.placeholderNamesScanned += matches.length;
      if (matches.length === 0) continue;

      const result = await db
        .update(users)
        .set({ firstName: "", lastName: "" })
        .where(and(eq(users.firstName, firstName), eq(users.lastName, lastName)))
        .returning({ id: users.id });

      summary.placeholderNamesCleared += result.length;
    } catch (err) {
      summary.errors += 1;
      // Swallow per-pair errors so a bad ALTER on one pair never blocks
      // the rest of boot. The error count is surfaced in the summary so
      // it's still observable from the boot log.
      console.error(
        `[data-hygiene] failed to clear placeholder name pair ${firstName} ${lastName}:`,
        err,
      );
    }
  }

  return summary;
}

// Convenience wrapper for the boot block — logs a single line so the
// hygiene pass is visible in startup logs without dumping a structured
// object.
export async function runStartupDataHygiene(): Promise<void> {
  try {
    const summary = await clearPlaceholderClientNames();
    if (
      summary.placeholderNamesCleared > 0 ||
      summary.errors > 0 ||
      summary.placeholderNamesScanned > 0
    ) {
      console.log(
        `[data-hygiene] placeholder names — scanned=${summary.placeholderNamesScanned} cleared=${summary.placeholderNamesCleared} errors=${summary.errors}`,
      );
    }
  } catch (err) {
    // Never block boot on a hygiene failure — log and continue.
    console.error("[data-hygiene] startup pass failed:", err);
  }
}

// Re-export `sql` so consumers don't need to import drizzle directly when
// composing custom hygiene passes in tests.
export { sql };
