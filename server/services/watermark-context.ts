// =============================================================================
// Task #318 — Watermark name resolution
// =============================================================================
// Every PDF download surface needs the same display strings for the watermark
// footer: "<client name>" and "<adviser name>". Hand-rolling that lookup at
// each call site invites drift (one route uses email-as-fallback, another
// uses "Unknown"). This helper centralises the rule so every footer reads
// the same way:
//
//   - "<First> <Last>" if both fields are present
//   - email if either name is missing
//   - "User #<id>" if email is also absent (deactivated row)
//
// The adviser branch additionally accepts a null/undefined id (e.g. an
// admin-initiated download where there's no per-client adviser link) and
// returns "AMAX Wealth (Compliance)" — the regulator-facing label for an
// unattributed download.
// =============================================================================

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";

function formatPersonName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} | null, id: number, role: "client" | "adviser"): string {
  if (!row) return role === "client" ? `Client #${id}` : `Adviser #${id}`;
  const full = `${row.firstName ?? ""} ${row.lastName ?? ""}`.replace(/\s+/g, " ").trim();
  if (full.length > 0) return full;
  if (row.email && row.email.length > 0) return row.email;
  return role === "client" ? `Client #${id}` : `Adviser #${id}`;
}

export interface ResolvedWatermarkNames {
  clientName: string;
  adviserName: string;
}

// Look up the display names for a (clientUserId, adviserUserId) pair. Either
// argument may be null:
//   - clientUserId null  → clientName falls back to "(unknown client)"
//     (the watermark utility will further sanitise empty strings)
//   - adviserUserId null → adviserName falls back to
//     "AMAX Wealth (Compliance)", reflecting an admin/compliance-initiated
//     download with no per-client adviser attribution.
//
// We do a single SELECT per id so this stays cheap on the hot download path.
export async function resolveWatermarkNames(
  clientUserId: number | null,
  adviserUserId: number | null,
): Promise<ResolvedWatermarkNames> {
  const [clientRow, adviserRow] = await Promise.all([
    clientUserId === null
      ? Promise.resolve(null)
      : db
          .select({
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, clientUserId))
          .limit(1)
          .then((r) => r[0] ?? null),
    adviserUserId === null
      ? Promise.resolve(null)
      : db
          .select({
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, adviserUserId))
          .limit(1)
          .then((r) => r[0] ?? null),
  ]);

  return {
    clientName:
      clientUserId === null
        ? "(unknown client)"
        : formatPersonName(clientRow, clientUserId, "client"),
    adviserName:
      adviserUserId === null
        ? "AMAX Wealth (Compliance)"
        : formatPersonName(adviserRow, adviserUserId, "adviser"),
  };
}
