// Boot-time data hygiene: clear known dev-fixture placeholder names on
// `users` so adviser surfaces never render them as real names. Idempotent.

import { db } from "../db";
import { users } from "@shared/schema";
import { and, eq } from "drizzle-orm";

export interface DataHygieneSummary {
  placeholderNamesScanned: number;
  placeholderNamesCleared: number;
  errors: number;
}

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
      // Scope: only client-role rows, to avoid any chance of clobbering
      // a real adviser/admin whose name happens to match a placeholder pair.
      const where = and(
        eq(users.firstName, firstName),
        eq(users.lastName, lastName),
        eq(users.role, "client"),
      );

      const matches = await db.select({ id: users.id }).from(users).where(where);
      summary.placeholderNamesScanned += matches.length;
      if (matches.length === 0) continue;

      // first_name / last_name are NOT NULL, so write empty strings.
      // The render fallback chain treats those as missing.
      const result = await db
        .update(users)
        .set({ firstName: "", lastName: "" })
        .where(where)
        .returning({ id: users.id });
      summary.placeholderNamesCleared += result.length;
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[data-hygiene] failed to clear placeholder name pair ${firstName} ${lastName}:`,
        err,
      );
    }
  }

  return summary;
}

export async function runStartupDataHygiene(): Promise<void> {
  try {
    const s = await clearPlaceholderClientNames();
    if (s.placeholderNamesCleared > 0 || s.errors > 0) {
      console.log(
        `[data-hygiene] placeholder names — scanned=${s.placeholderNamesScanned} cleared=${s.placeholderNamesCleared} errors=${s.errors}`,
      );
    }
  } catch (err) {
    console.error("[data-hygiene] startup pass failed:", err);
  }
}
