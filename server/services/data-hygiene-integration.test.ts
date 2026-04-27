// =============================================================================
// Task #283 — data hygiene integration test (real DB)
// -----------------------------------------------------------------------------
// Verifies the actual cleanup behavior end-to-end against the dev DB:
//   - A user with the placeholder pair gets first/last cleared.
//   - A user whose name only partially matches (e.g. "Linked Bob") is
//     left untouched.
//   - The summary counters are accurate.
//   - The pass is idempotent — running it twice does NOT clear anything
//     on the second pass.
//
// The test inserts its own fixture rows with deliberately distinctive
// emails (`hygiene-test-...@example.invalid`) and removes them in
// afterAll, so it never leaves residue in the dev DB regardless of test
// outcome.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import { users } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { clearPlaceholderClientNames } from "./data-hygiene";

const PLACEHOLDER_EMAIL = "hygiene-test-placeholder@example.invalid";
const NEAR_MISS_EMAIL = "hygiene-test-nearmiss@example.invalid";

const INSERTED_EMAILS = [PLACEHOLDER_EMAIL, NEAR_MISS_EMAIL];

async function cleanupFixtures() {
  await db.delete(users).where(inArray(users.email, INSERTED_EMAILS));
}

describe("clearPlaceholderClientNames — integration against dev DB", () => {
  beforeAll(async () => {
    await cleanupFixtures(); // tolerate residue from a prior failed run
    await db.insert(users).values([
      {
        username: "hygiene-test-placeholder",
        email: PLACEHOLDER_EMAIL,
        password: "x", // not used; rows are wiped in afterAll
        firstName: "Linked",
        lastName: "Client",
        role: "client",
      },
      {
        username: "hygiene-test-nearmiss",
        email: NEAR_MISS_EMAIL,
        password: "x",
        firstName: "Linked", // first name matches but...
        lastName: "Bob", //   last name does not — must NOT be cleared.
        role: "client",
      },
    ]);
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it("clears the placeholder pair, leaves near-misses untouched, and is idempotent", async () => {
    // First pass: should clear exactly one row (the placeholder fixture
    // we just inserted). The summary may report a higher number if some
    // other dev-DB row also matches — we assert "at least 1" rather
    // than exactly 1 to keep the test stable across environments.
    const first = await clearPlaceholderClientNames();
    expect(first.placeholderNamesScanned).toBeGreaterThanOrEqual(1);
    expect(first.placeholderNamesCleared).toBeGreaterThanOrEqual(1);
    expect(first.errors).toBe(0);

    // Placeholder row: first/last must now be empty strings.
    const [placeholder] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.email, PLACEHOLDER_EMAIL));
    expect(placeholder).toBeDefined();
    expect(placeholder.firstName).toBe("");
    expect(placeholder.lastName).toBe("");

    // Near-miss row: must be UNCHANGED.
    const [nearMiss] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.email, NEAR_MISS_EMAIL));
    expect(nearMiss).toBeDefined();
    expect(nearMiss.firstName).toBe("Linked");
    expect(nearMiss.lastName).toBe("Bob");

    // Second pass: the placeholder row no longer matches the allowlist
    // (its first/last are now empty), so the scan must find 0 rows and
    // the cleared count must be 0. This confirms idempotency.
    const second = await clearPlaceholderClientNames();
    expect(second.placeholderNamesScanned).toBe(0);
    expect(second.placeholderNamesCleared).toBe(0);
    expect(second.errors).toBe(0);
  });
});
