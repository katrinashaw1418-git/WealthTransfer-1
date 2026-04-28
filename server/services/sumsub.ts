import { createHmac, timingSafeEqual } from "crypto";

const DEFAULT_BASE_URL = "https://api.sumsub.com";
const DEFAULT_LEVEL_NAME = "id-and-liveness";
const DEFAULT_TTL_SECS = 600;

export interface SumsubConfig {
  appToken: string;
  secretKey: string;
  baseUrl: string;
  levelName: string;
  ttlSecs: number;
}

export interface SumsubAccessToken {
  token: string;
  userId: string;
  levelName: string;
}

export class SumsubNotConfiguredError extends Error {
  status = 503;
  constructor() {
    super("Identity verification is not configured on this server.");
    this.name = "SumsubNotConfiguredError";
  }
}

export class SumsubApiError extends Error {
  status = 502;
  upstreamStatus: number;
  upstreamBody: string;
  constructor(upstreamStatus: number, upstreamBody: string) {
    super(`Sumsub API error (${upstreamStatus})`);
    this.name = "SumsubApiError";
    this.upstreamStatus = upstreamStatus;
    this.upstreamBody = upstreamBody;
  }
}

export function loadSumsubConfigFromEnv(): SumsubConfig | null {
  const appToken = (process.env.SUMSUB_APP_TOKEN || "").trim();
  const secretKey = (process.env.SUMSUB_SECRET_KEY || "").trim();
  if (!appToken || !secretKey) return null;
  const baseUrl = (process.env.SUMSUB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const levelName = (process.env.SUMSUB_LEVEL_NAME || DEFAULT_LEVEL_NAME).trim();
  const ttlRaw = parseInt(process.env.SUMSUB_TOKEN_TTL_SECS || "", 10);
  const ttlSecs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_SECS;
  return { appToken, secretKey, baseUrl, levelName, ttlSecs };
}

export function buildExternalUserId(userId: number): string {
  return `amax-user-${userId}`;
}

// Inverse of `buildExternalUserId`. Returns the numeric user id when the
// `externalUserId` matches our `amax-user-<id>` shape and the suffix parses
// as a positive integer; otherwise `null`. The webhook handler uses this
// to look up the row that owns the Sumsub applicant.
export function parseExternalUserId(externalUserId: string): number | null {
  const match = /^amax-user-(\d+)$/.exec(externalUserId);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// Sumsub publishes the digest algorithm in the `x-payload-digest-alg`
// header. The shared secret is the same one used to sign access-token
// requests (`SUMSUB_SECRET_KEY`). We accept the three algorithms Sumsub
// documents; everything else is treated as unsupported and returns false
// so the route can answer 401.
const SUMSUB_DIGEST_ALGS: Record<string, string> = {
  HMAC_SHA1_HEX: "sha1",
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA512_HEX: "sha512",
};

export const DEFAULT_SUMSUB_DIGEST_ALG = "HMAC_SHA256_HEX";

export function verifyWebhookSignature(
  rawBody: Buffer,
  headerDigest: string | undefined | null,
  secretKey: string,
  algorithm: string = DEFAULT_SUMSUB_DIGEST_ALG,
): boolean {
  if (!headerDigest) return false;
  const algo = SUMSUB_DIGEST_ALGS[algorithm];
  if (!algo) return false;
  const expectedHex = createHmac(algo, secretKey).update(rawBody).digest("hex");
  // Normalise the inbound digest before constant-time compare. Sumsub sends
  // lowercase hex, but we accept either case and reject any non-hex input
  // by length-mismatching against the expected buffer.
  const provided = headerDigest.trim().toLowerCase();
  if (provided.length !== expectedHex.length) return false;
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// Mapping rule lifted from the task spec:
//   GREEN -> verified
//   RED   -> rejected
//   anything else (init, pending, queued, onHold, prechecked, completedSent,
//   completedSentRetry, awaitingUser, …) -> under_review
// We additionally return null when the payload doesn't look like a review
// event at all so the webhook handler can short-circuit without writing an
// audit row for noise (e.g. `applicantCreated` notifications).
export type SumsubKycStatus = "verified" | "rejected" | "under_review";

export function mapSumsubReviewToKycStatus(args: {
  reviewStatus?: string | null;
  reviewAnswer?: string | null;
}): SumsubKycStatus | null {
  const reviewStatus = (args.reviewStatus || "").trim();
  const reviewAnswer = (args.reviewAnswer || "").trim().toUpperCase();
  if (!reviewStatus && !reviewAnswer) return null;
  if (reviewAnswer === "GREEN") return "verified";
  if (reviewAnswer === "RED") return "rejected";
  return "under_review";
}

function signRequest(
  secretKey: string,
  ts: number,
  method: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secretKey)
    .update(`${ts}${method.toUpperCase()}${path}${body}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Task #404 — Per-step KYC state
// -----------------------------------------------------------------------------
// `mintSumsubAccessToken` only signs/POSTs the access-token endpoint, but
// reading the applicant + per-document status is the same kind of HMAC-signed
// GET. The `signedGet` helper centralises that so `getApplicantStatus` can
// hit two endpoints in parallel without repeating the timestamp/signature
// dance. Exported for tests; not used outside this module otherwise.
// ---------------------------------------------------------------------------
export async function signedGet<T>(
  config: SumsubConfig,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signRequest(config.secretKey, ts, "GET", path, "");
  const res = await fetchImpl(`${config.baseUrl}${path}`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-App-Token": config.appToken,
      "X-App-Access-Sig": sig,
      "X-App-Access-Ts": String(ts),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SumsubApiError(res.status, text.slice(0, 500));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SumsubApiError(res.status, `Invalid JSON: ${text.slice(0, 200)}`);
  }
}

// Per-step verdict — intentionally narrow so the route layer owns the mapping
// to the UI-facing `ComplianceStepStatus` shape.
export type SumsubStepVerdict =
  | "approved"      // GREEN
  | "rejected"      // RED + FINAL
  | "retry"         // RED + RETRY (user can re-submit)
  | "review"        // submitted, pending Sumsub review
  | "in_progress"   // images uploaded but no review result yet
  | "not_started";  // nothing uploaded yet for this step

export interface SumsubApplicantSnapshot {
  // The Sumsub applicantId — null when the applicant has not been created yet
  // (i.e. the user has never opened the WebSDK).
  applicantId: string | null;
  identity: SumsubStepVerdict;
  liveness: SumsubStepVerdict;
  amlPep: SumsubStepVerdict;
  // ISO timestamp of the last completed review, when known.
  reviewedAt: string | null;
}

// Shape extracted from Sumsub responses. Kept loose because Sumsub adds new
// optional fields over time and we only need a small subset.
interface SumsubReviewResult {
  reviewAnswer?: string;       // "GREEN" | "RED"
  reviewRejectType?: string;   // "FINAL" | "RETRY"
}

interface SumsubApplicantOne {
  id?: string;
  review?: {
    reviewStatus?: string; // init | pending | queued | completed | onHold | prechecked
    reviewResult?: SumsubReviewResult;
    reviewDate?: string;
  };
}

interface SumsubDocStatusEntry {
  imageIds?: number[] | string[];
  reviewResult?: SumsubReviewResult;
}
type SumsubRequiredIdDocsStatus = Record<string, SumsubDocStatusEntry>;

function verdictFromReviewResult(
  result: SumsubReviewResult | undefined | null,
): SumsubStepVerdict | null {
  if (!result) return null;
  if (result.reviewAnswer === "GREEN") return "approved";
  if (result.reviewAnswer === "RED") {
    return result.reviewRejectType === "FINAL" ? "rejected" : "retry";
  }
  return null;
}

function verdictFromDocEntry(
  entry: SumsubDocStatusEntry | undefined,
): SumsubStepVerdict {
  if (!entry) return "not_started";
  const fromResult = verdictFromReviewResult(entry.reviewResult);
  if (fromResult) return fromResult;
  // No verdict yet — uploaded but unreviewed counts as in_progress / review.
  if (Array.isArray(entry.imageIds) && entry.imageIds.length > 0) return "review";
  return "not_started";
}

// Sumsub uses different idDocSetType keys for the liveness step depending on
// the level configuration ("SELFIE" for selfie matching, "LIVENESS_3D" for
// the 3D liveness flow, plain "LIVENESS" for older flows). We pick the first
// one that is present so the helper works across configurations.
const LIVENESS_KEYS = ["SELFIE", "LIVENESS_3D", "LIVENESS"] as const;

function pickLivenessEntry(
  docs: SumsubRequiredIdDocsStatus,
): SumsubDocStatusEntry | undefined {
  for (const key of LIVENESS_KEYS) {
    if (docs[key]) return docs[key];
  }
  return undefined;
}

function applicantIsNotFound(err: unknown): boolean {
  if (!(err instanceof SumsubApiError)) return false;
  // Sumsub returns 404 when the externalUserId has never been used. That's a
  // legitimate "user has not started yet" signal, not an error.
  return err.upstreamStatus === 404;
}

export async function getApplicantStatus(
  externalUserId: string,
  config: SumsubConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SumsubApplicantSnapshot> {
  const encoded = encodeURIComponent(externalUserId);
  const onePath = `/resources/applicants/-;externalUserId=${encoded}/one`;
  const docsPath = `/resources/applicants/-;externalUserId=${encoded}/requiredIdDocsStatus`;

  const [oneSettled, docsSettled] = await Promise.allSettled([
    signedGet<SumsubApplicantOne>(config, onePath, fetchImpl),
    signedGet<SumsubRequiredIdDocsStatus>(config, docsPath, fetchImpl),
  ]);

  // A 404 from either endpoint means "no applicant yet" / "no docs yet" — a
  // legitimate not_started state. ANY other failure (5xx, network error,
  // bad JSON, …) means we cannot produce a trustworthy per-step verdict, so
  // we propagate the error and let the route fall back to the overall-status
  // mapping. Returning a partial snapshot here would silently mislabel
  // already-verified users as "Action required".
  if (oneSettled.status === "rejected" && !applicantIsNotFound(oneSettled.reason)) {
    throw oneSettled.reason;
  }
  if (docsSettled.status === "rejected" && !applicantIsNotFound(docsSettled.reason)) {
    throw docsSettled.reason;
  }

  const one = oneSettled.status === "fulfilled" ? oneSettled.value : null;
  const docs = docsSettled.status === "fulfilled" ? docsSettled.value : null;

  // Per-document verdicts when /requiredIdDocsStatus is available.
  const identity = docs
    ? verdictFromDocEntry(docs.IDENTITY)
    : "not_started";
  const liveness = docs
    ? verdictFromDocEntry(pickLivenessEntry(docs))
    : "not_started";

  // AML/PEP outcome lives at the applicant-level review (no per-doc entry).
  // Mirror the overall reviewResult when present; fall back to the review
  // status when the applicant exists but has not been reviewed yet.
  let amlPep: SumsubStepVerdict = "not_started";
  if (one?.review) {
    const fromResult = verdictFromReviewResult(one.review.reviewResult);
    if (fromResult) {
      amlPep = fromResult;
    } else if (one.review.reviewStatus === "completed") {
      // Completed without an explicit answer — treat as pending review so
      // the UI doesn't lie about an outcome we don't actually have.
      amlPep = "review";
    } else if (
      one.review.reviewStatus === "pending" ||
      one.review.reviewStatus === "queued" ||
      one.review.reviewStatus === "onHold"
    ) {
      amlPep = "review";
    } else if (one.review.reviewStatus === "prechecked") {
      amlPep = "in_progress";
    }
  }

  return {
    applicantId: one?.id ?? null,
    identity,
    liveness,
    amlPep,
    reviewedAt: one?.review?.reviewDate ?? null,
  };
}

export async function mintSumsubAccessToken(
  externalUserId: string,
  config: SumsubConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SumsubAccessToken> {
  const path = `/resources/accessTokens?userId=${encodeURIComponent(
    externalUserId,
  )}&levelName=${encodeURIComponent(config.levelName)}&ttlInSecs=${config.ttlSecs}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = signRequest(config.secretKey, ts, "POST", path, "");

  const res = await fetchImpl(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "X-App-Token": config.appToken,
      "X-App-Access-Sig": sig,
      "X-App-Access-Ts": String(ts),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new SumsubApiError(res.status, text.slice(0, 500));
  }

  let parsed: { token?: string; userId?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SumsubApiError(res.status, `Invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.token || !parsed.userId) {
    throw new SumsubApiError(res.status, `Missing token or userId in response: ${text.slice(0, 200)}`);
  }

  return {
    token: parsed.token,
    userId: parsed.userId,
    levelName: config.levelName,
  };
}
