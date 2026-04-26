// Small helper to fetch a {[userId]: {id, firstName, lastName, email}} map
// for a set of user IDs in a single query. Used by the fee engine list
// endpoints so the frontend can render human names instead of raw IDs.

import { inArray, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/schema";

export interface UserNameRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

export type UserNameMap = Record<number, UserNameRef>;

export async function getUserNameMap(
  userIds: Array<number | null | undefined>,
): Promise<UserNameMap> {
  const ids = Array.from(
    new Set(
      userIds.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
      ),
    ),
  );
  if (ids.length === 0) return {};
  const rows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const map: UserNameMap = {};
  for (const r of rows) {
    map[r.id] = r;
  }
  return map;
}

// Find user IDs whose first name, last name, full name or email match the
// given search string (case-insensitive substring). Used by admin list
// endpoints so the frontend can drive a single search box that filters by
// either client or adviser identity, server-side.
export async function findUserIdsByQuery(q: string): Promise<number[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const pattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
        ilike(users.email, pattern),
        ilike(
          sql`coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')`,
          pattern,
        ),
      ),
    );
  return rows.map((r) => r.id);
}
