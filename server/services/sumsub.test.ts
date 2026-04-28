import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  buildExternalUserId,
  loadSumsubConfigFromEnv,
  mintSumsubAccessToken,
  parseExternalUserId,
  verifyWebhookSignature,
  mapSumsubReviewToKycStatus,
  SumsubApiError,
  type SumsubConfig,
} from "./sumsub";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildExternalUserId", () => {
  it("derives a deterministic id from the user id", () => {
    expect(buildExternalUserId(1)).toBe("amax-user-1");
    expect(buildExternalUserId(42)).toBe("amax-user-42");
    expect(buildExternalUserId(999_999)).toBe("amax-user-999999");
  });
});

describe("loadSumsubConfigFromEnv", () => {
  beforeEach(() => {
    delete process.env.SUMSUB_APP_TOKEN;
    delete process.env.SUMSUB_SECRET_KEY;
    delete process.env.SUMSUB_BASE_URL;
    delete process.env.SUMSUB_LEVEL_NAME;
    delete process.env.SUMSUB_TOKEN_TTL_SECS;
  });

  it("returns null when both credentials are missing", () => {
    expect(loadSumsubConfigFromEnv()).toBeNull();
  });

  it("returns null when only one credential is present", () => {
    process.env.SUMSUB_APP_TOKEN = "sbx:abc";
    expect(loadSumsubConfigFromEnv()).toBeNull();
    delete process.env.SUMSUB_APP_TOKEN;
    process.env.SUMSUB_SECRET_KEY = "secret";
    expect(loadSumsubConfigFromEnv()).toBeNull();
  });

  it("returns config with documented defaults when only credentials are set", () => {
    process.env.SUMSUB_APP_TOKEN = "sbx:abc";
    process.env.SUMSUB_SECRET_KEY = "secret";
    const cfg = loadSumsubConfigFromEnv();
    expect(cfg).toEqual({
      appToken: "sbx:abc",
      secretKey: "secret",
      baseUrl: "https://api.sumsub.com",
      levelName: "id-and-liveness",
      ttlSecs: 600,
    });
  });

  it("respects overrides and trims a trailing slash from the base url", () => {
    process.env.SUMSUB_APP_TOKEN = "sbx:abc";
    process.env.SUMSUB_SECRET_KEY = "secret";
    process.env.SUMSUB_BASE_URL = "https://test-api.sumsub.com/";
    process.env.SUMSUB_LEVEL_NAME = "basic-kyc-level";
    process.env.SUMSUB_TOKEN_TTL_SECS = "1200";
    const cfg = loadSumsubConfigFromEnv();
    expect(cfg).toEqual({
      appToken: "sbx:abc",
      secretKey: "secret",
      baseUrl: "https://test-api.sumsub.com",
      levelName: "basic-kyc-level",
      ttlSecs: 1200,
    });
  });

  it("falls back to the default TTL on a non-numeric override", () => {
    process.env.SUMSUB_APP_TOKEN = "sbx:abc";
    process.env.SUMSUB_SECRET_KEY = "secret";
    process.env.SUMSUB_TOKEN_TTL_SECS = "not-a-number";
    expect(loadSumsubConfigFromEnv()?.ttlSecs).toBe(600);
  });
});

describe("mintSumsubAccessToken", () => {
  const config: SumsubConfig = {
    appToken: "sbx:test-app-token",
    secretKey: "test-secret-key",
    baseUrl: "https://api.sumsub.com",
    levelName: "id-and-liveness",
    ttlSecs: 600,
  };

  it("calls the access-tokens endpoint with the level name + TTL and signs the request", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedMethod = "";

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ token: "_act-token-xyz", userId: "applicant-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await mintSumsubAccessToken("amax-user-7", config, fakeFetch);

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe(
      "https://api.sumsub.com/resources/accessTokens?userId=amax-user-7&levelName=id-and-liveness&ttlInSecs=600",
    );
    expect(capturedHeaders["X-App-Token"]).toBe("sbx:test-app-token");
    expect(capturedHeaders["X-App-Access-Sig"]).toBeTruthy();
    const ts = capturedHeaders["X-App-Access-Ts"];
    expect(ts).toMatch(/^\d+$/);

    const path =
      "/resources/accessTokens?userId=amax-user-7&levelName=id-and-liveness&ttlInSecs=600";
    const expectedSig = createHmac("sha256", "test-secret-key")
      .update(`${ts}POST${path}`)
      .digest("hex");
    expect(capturedHeaders["X-App-Access-Sig"]).toBe(expectedSig);

    expect(result).toEqual({
      token: "_act-token-xyz",
      userId: "applicant-1",
      levelName: "id-and-liveness",
    });
  });

  it("throws SumsubApiError on a non-2xx response and includes the upstream status", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ description: "bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    await expect(mintSumsubAccessToken("amax-user-7", config, fakeFetch)).rejects.toMatchObject({
      name: "SumsubApiError",
      upstreamStatus: 401,
    });
  });

  it("throws SumsubApiError when the response is missing required fields", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ token: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const err = await mintSumsubAccessToken("amax-user-7", config, fakeFetch).catch((e) => e);
    expect(err).toBeInstanceOf(SumsubApiError);
  });

  it("URL-encodes the externalUserId and level name", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ token: "t", userId: "u" }), { status: 200 });
    };
    await mintSumsubAccessToken("amax user/7", { ...config, levelName: "id & live" }, fakeFetch);
    expect(capturedUrl).toContain("userId=amax%20user%2F7");
    expect(capturedUrl).toContain("levelName=id%20%26%20live");
  });
});

// ---------------------------------------------------------------------------
// Task #403 — webhook helpers
// ---------------------------------------------------------------------------

describe("parseExternalUserId", () => {
  it("recovers the numeric id for ids minted by buildExternalUserId", () => {
    expect(parseExternalUserId("amax-user-1")).toBe(1);
    expect(parseExternalUserId("amax-user-42")).toBe(42);
    expect(parseExternalUserId(buildExternalUserId(987_654))).toBe(987_654);
  });

  it("returns null for malformed or non-positive ids", () => {
    expect(parseExternalUserId("amax-user-")).toBeNull();
    expect(parseExternalUserId("amax-user-0")).toBeNull();
    expect(parseExternalUserId("amax-user-abc")).toBeNull();
    expect(parseExternalUserId("not-our-prefix-7")).toBeNull();
    expect(parseExternalUserId("")).toBeNull();
    expect(parseExternalUserId("amax-user-7-extra")).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
  const sha256Hex = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid HMAC_SHA256_HEX digest (default algorithm)", () => {
    expect(verifyWebhookSignature(body, sha256Hex, secret)).toBe(true);
    expect(verifyWebhookSignature(body, sha256Hex.toUpperCase(), secret)).toBe(true);
  });

  it("accepts SHA1 and SHA512 when the matching algorithm is named", () => {
    const sha1 = createHmac("sha1", secret).update(body).digest("hex");
    const sha512 = createHmac("sha512", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, sha1, secret, "HMAC_SHA1_HEX")).toBe(true);
    expect(verifyWebhookSignature(body, sha512, secret, "HMAC_SHA512_HEX")).toBe(true);
  });

  it("rejects when the digest header is missing or empty", () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ hello: "evil" }), "utf8");
    expect(verifyWebhookSignature(tampered, sha256Hex, secret)).toBe(false);
  });

  it("rejects when the secret doesn't match", () => {
    expect(verifyWebhookSignature(body, sha256Hex, "wrong-secret")).toBe(false);
  });

  it("rejects unknown / unsupported algorithm names", () => {
    expect(verifyWebhookSignature(body, sha256Hex, secret, "HMAC_MD5_HEX")).toBe(false);
    expect(verifyWebhookSignature(body, sha256Hex, secret, "")).toBe(false);
  });

  it("rejects digests of the wrong length even before constant-time compare", () => {
    expect(verifyWebhookSignature(body, sha256Hex.slice(0, 10), secret)).toBe(false);
    expect(verifyWebhookSignature(body, sha256Hex + "00", secret)).toBe(false);
  });
});

describe("mapSumsubReviewToKycStatus", () => {
  it("maps GREEN -> verified", () => {
    expect(
      mapSumsubReviewToKycStatus({ reviewStatus: "completed", reviewAnswer: "GREEN" }),
    ).toBe("verified");
  });

  it("maps RED -> rejected", () => {
    expect(
      mapSumsubReviewToKycStatus({ reviewStatus: "completed", reviewAnswer: "RED" }),
    ).toBe("rejected");
  });

  it("maps intermediate states -> under_review", () => {
    for (const reviewStatus of ["init", "pending", "queued", "onHold", "prechecked"]) {
      expect(
        mapSumsubReviewToKycStatus({ reviewStatus, reviewAnswer: undefined }),
      ).toBe("under_review");
    }
    // `completed` without a verdict is still review-noise: treat as under_review
    // until the final reviewAnswer arrives.
    expect(
      mapSumsubReviewToKycStatus({ reviewStatus: "completed", reviewAnswer: undefined }),
    ).toBe("under_review");
  });

  it("returns null when no review fields are present (notification events)", () => {
    expect(mapSumsubReviewToKycStatus({})).toBeNull();
    expect(mapSumsubReviewToKycStatus({ reviewStatus: "", reviewAnswer: "" })).toBeNull();
  });

  it("is case-insensitive on reviewAnswer", () => {
    expect(
      mapSumsubReviewToKycStatus({ reviewStatus: "completed", reviewAnswer: "green" }),
    ).toBe("verified");
    expect(
      mapSumsubReviewToKycStatus({ reviewStatus: "completed", reviewAnswer: "Red" }),
    ).toBe("rejected");
  });
});
