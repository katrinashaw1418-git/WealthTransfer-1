import { createHmac } from "crypto";

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
