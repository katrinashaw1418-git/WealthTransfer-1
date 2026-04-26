// =============================================================================
// IDEMPOTENCY HELPER — Track B (Session 7)
// =============================================================================
// Transaction-level idempotency for money-movement endpoints. The client (or
// webhook) supplies an `Idempotency-Key` header; if a transaction already
// exists with that key, the original transaction is returned unchanged and no
// new state is created.
//
// This is DISTINCT from the per-user/per-route idempotency in
// shared/schema.ts → idempotencyKeys (which dedupes route handlers including
// non-money endpoints). Track B's mechanism dedupes at the transaction level
// across any code path that touches transactions, even if the request hits
// a different route or comes from a webhook.
// =============================================================================

import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { transactions } from "@shared/schema";

/**
 * Extract and validate the Idempotency-Key header from an incoming request.
 * Throws if missing or obviously malformed — money endpoints MUST require it.
 */
export function getIdempotencyKey(req: Request): string {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;

  if (!key || typeof key !== "string") {
    throw new Error("Missing Idempotency-Key header");
  }

  // 12 chars is the minimum length that gives meaningful collision resistance
  // (UUIDv4, KSUID, ULID, snowflake — all > 12 chars). Reject anything shorter
  // so a careless caller can't pass "1" and accidentally collide with another
  // request from the same client.
  if (key.length < 12) {
    throw new Error("Invalid Idempotency-Key — must be at least 12 characters");
  }

  // Basic structural validation. We allow alphanumerics + a small set of
  // separators that all common UUID/KSUID encodings use.
  if (!/^[A-Za-z0-9_\-:.]+$/.test(key)) {
    throw new Error(
      "Invalid Idempotency-Key — only A-Z a-z 0-9 _ - : . are allowed"
    );
  }

  return key;
}

/**
 * Look up a transaction by its idempotency key. Returns null if no match.
 * Use this BEFORE creating any new transaction in a money endpoint so that
 * a retried request returns the original result instead of double-spending.
 */
export async function findTransactionByIdempotencyKey(key: string) {
  const [existing] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.idempotencyKey, key))
    .limit(1);

  return existing ?? null;
}
