// Integration test: run the hygiene pass against the real dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { clearPlaceholderClientNames } from "./data-hygiene";

const PLACEHOLDER_EMAIL = "hygiene-test-placeholder@example.invalid";
const NEAR_MISS_EMAIL = "hygiene-test-nearmiss@example.invalid";
const FIXTURE_EMAILS = [PLACEHOLDER_EMAIL, NEAR_MISS_EMAIL];

async function cleanup() {
  await db.delete(users).where(inArray(users.email, FIXTURE_EMAILS));
}

describe("clearPlaceholderClientNames — integration", () => {
  beforeAll(async () => {
    await cleanup();
    await db.insert(users).values([
      {
        username: "hygiene-test-placeholder",
        email: PLACEHOLDER_EMAIL,
        password: "x",
        firstName: "Linked",
        lastName: "Client",
        role: "client",
      },
      {
        username: "hygiene-test-nearmiss",
        email: NEAR_MISS_EMAIL,
        password: "x",
        firstName: "Linked",
        lastName: "Bob",
        role: "client",
      },
    ]);
  });

  afterAll(cleanup);

  it("clears the placeholder pair, leaves near-misses, and is idempotent", async () => {
    const first = await clearPlaceholderClientNames();
    expect(first.placeholderNamesCleared).toBeGreaterThanOrEqual(1);
    expect(first.errors).toBe(0);

    const [placeholder] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.email, PLACEHOLDER_EMAIL));
    expect(placeholder.firstName).toBe("");
    expect(placeholder.lastName).toBe("");

    const [nearMiss] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.email, NEAR_MISS_EMAIL));
    expect(nearMiss.firstName).toBe("Linked");
    expect(nearMiss.lastName).toBe("Bob");

    const second = await clearPlaceholderClientNames();
    expect(second.placeholderNamesScanned).toBe(0);
    expect(second.placeholderNamesCleared).toBe(0);
  });
});
