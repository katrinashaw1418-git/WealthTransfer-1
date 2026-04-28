// =============================================================================
// SoA target-allocation lookup (Task #405)
// -----------------------------------------------------------------------------
// Three platform surfaces — /api/portfolio/allocation, /api/portfolio/real-
// metrics, and /api/ai-recommendations/generate — all need to know whether
// the client has a live Statement-of-Advice target on file so they can
// resolve the same per-client benchmark via `resolvePerClientBenchmark`.
// Putting the lookup in one place means the three routes can never drift on
// which advice-record statuses count as "live", what JSONB shape to read,
// or how to break ties when a client has multiple issued/accepted records.
//
// Selection rules:
//   - Only advice records with a non-null `soaTargetAllocation` JSONB are
//     considered (a draft record with no target on it must NOT supersede a
//     prior issued one).
//   - Only records in a status the platform treats as live count: `issued`
//     and `accepted`. Drafts, review_pending, declined and superseded
//     records are explicitly skipped — a superseded record's target should
//     no longer drive the client's portfolio benchmark.
//   - When more than one row qualifies, the most recently set target wins
//     (`soaTargetSetAt DESC`). The `createdAt` column is the secondary tie-
//     breaker so older records that were re-targeted today still surface
//     ahead of legacy rows that have never had a target written.
// =============================================================================

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { db as defaultDb } from "../db";
import { adviceRecords } from "@shared/schema";
import type { SoaTargetAllocation } from "../config/rebalancing-benchmark";

// `LIVE_SOA_STATUSES` is exported so tests can pin which statuses qualify
// without re-hardcoding the literal set on the assertion side.
export const LIVE_SOA_STATUSES = ["issued", "accepted"] as const;

export type DbForSoaLookup = Pick<typeof defaultDb, "select">;

export async function loadLatestSoaTargetAllocation(
  db: DbForSoaLookup,
  clientUserId: number,
): Promise<SoaTargetAllocation | null> {
  const [row] = await db
    .select({ soaTargetAllocation: adviceRecords.soaTargetAllocation })
    .from(adviceRecords)
    .where(
      and(
        eq(adviceRecords.clientId, clientUserId),
        inArray(adviceRecords.status, LIVE_SOA_STATUSES as unknown as string[]),
        isNotNull(adviceRecords.soaTargetAllocation),
      ),
    )
    .orderBy(desc(adviceRecords.soaTargetSetAt), desc(adviceRecords.createdAt))
    .limit(1);

  return row?.soaTargetAllocation ?? null;
}
