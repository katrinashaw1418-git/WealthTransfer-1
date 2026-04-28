import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  buildExternalUserId,
  loadSumsubConfigFromEnv,
  mintSumsubAccessToken,
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
