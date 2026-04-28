import { QueryClient, QueryFunction } from "@tanstack/react-query";

const TOKEN_KEY = "amax_jwt";

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers = data
    ? authHeaders({ "Content-Type": "application/json" })
    : authHeaders();
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });
  await throwIfResNotOk(res);
  return res;
}

// Structured error thrown by `apiUpload` on non-OK responses. The shape is
// intentionally narrow (status + optional code + raw body) so callers can
// switch on `code` to render friendly toast titles for the well-known
// upload-rejection codes (UPLOAD_TOO_LARGE, UPLOAD_MIME_REJECTED, …)
// without resorting to string parsing.
export class ApiUploadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(
    message: string,
    init: { status: number; code?: string; body?: unknown },
  ) {
    super(message);
    this.name = "ApiUploadError";
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
  }
}

interface UploadErrorBody {
  error?: string;
  message?: string;
  code?: string;
}

function parseUploadErrorBody(raw: string): UploadErrorBody | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const out: UploadErrorBody = {};
      if (typeof obj.error === "string") out.error = obj.error;
      if (typeof obj.message === "string") out.message = obj.message;
      if (typeof obj.code === "string") out.code = obj.code;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// Progress payload pushed to `apiUpload`'s `onProgress` callback. `total`
// and `percent` fall back to 0 / null when the browser cannot report a
// content length (e.g. a streamed body), so callers can render an
// indeterminate state without crashing.
export interface ApiUploadProgress {
  loaded: number;
  total: number;
  percent: number | null;
}

export interface ApiUploadOptions {
  // Called repeatedly while the request body is being sent. Useful for
  // driving a per-byte progress bar in the UI.
  onProgress?: (progress: ApiUploadProgress) => void;
  // When the signal aborts, the in-flight XHR is cancelled and the
  // returned promise rejects with an Error whose `name === "AbortError"`.
  // Callers can branch on that name to skip the usual error toast.
  signal?: AbortSignal;
}

function makeAbortError(): Error {
  const err = new Error("Upload aborted");
  err.name = "AbortError";
  return err;
}

function buildResponseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  if (!rawHeaders) return headers;
  for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      headers.append(name, value);
    } catch {
      // Skip invalid header names (rare; not worth failing the upload).
    }
  }
  return headers;
}

// Multipart upload helper. Mirrors apiRequest's auth + 401 handling but
// deliberately omits the JSON Content-Type so the browser can set the
// multipart boundary itself. Internally uses XMLHttpRequest (instead of
// fetch) so we can wire `xhr.upload.onprogress` for byte-level progress
// reporting and `signal` for clean cancellation — neither is currently
// supported by fetch's request body in mainstream browsers. The returned
// `Response` is reconstructed from the XHR so callers can keep calling
// `.json()` / `.text()` exactly as they did with the fetch-based version.
//
// On non-OK responses it tries to parse the JSON body so the caller can
// read `code`/`error` fields straight off the thrown ApiUploadError and
// surface a friendly toast (e.g. UPLOAD_TOO_LARGE, UPLOAD_MIME_REJECTED).
// Falls back to the raw response text when the body is not JSON.
export function apiUpload(
  url: string,
  body: FormData,
  options: ApiUploadOptions = {},
): Promise<Response> {
  const { onProgress, signal } = options;

  if (signal?.aborted) {
    return Promise.reject(makeAbortError());
  }

  return new Promise<Response>((resolve, reject) => {
    const token = getToken();
    const xhr = new XMLHttpRequest();
    let aborted = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // ignore — we still want to settle the promise below
      }
      settle(() => reject(makeAbortError()));
    };
    if (signal) signal.addEventListener("abort", onAbort);

    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener("progress", (ev) => {
        const total = ev.lengthComputable ? ev.total : 0;
        const percent =
          ev.lengthComputable && ev.total > 0
            ? Math.min(100, Math.max(0, (ev.loaded / ev.total) * 100))
            : null;
        try {
          onProgress({ loaded: ev.loaded, total, percent });
        } catch {
          // Don't let a buggy callback tear down the upload.
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (aborted) return;
      const status = xhr.status;
      const raw = xhr.responseText ?? "";

      if (status === 401) {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          // ignore storage errors
        }
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
        settle(() => reject(new Error("401: token expired")));
        return;
      }

      if (status < 200 || status >= 300) {
        const parsed = parseUploadErrorBody(raw);
        const message =
          parsed?.error ||
          parsed?.message ||
          raw ||
          `${status}: upload failed`;
        settle(() =>
          reject(
            new ApiUploadError(message, {
              status,
              code: parsed?.code,
              body: parsed ?? raw,
            }),
          ),
        );
        return;
      }

      try {
        const response = new Response(raw, {
          status,
          statusText: xhr.statusText,
          headers: buildResponseHeaders(xhr.getAllResponseHeaders()),
        });
        settle(() => resolve(response));
      } catch (err) {
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      }
    });

    xhr.addEventListener("error", () => {
      if (aborted) return;
      settle(() => reject(new Error("Network error during upload")));
    });

    xhr.addEventListener("timeout", () => {
      if (aborted) return;
      settle(() => reject(new Error("Upload timed out")));
    });

    try {
      xhr.open("POST", url, true);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(body);
    } catch (err) {
      settle(() =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    }
  });
}

export async function apiFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: authHeaders() });
  // Mirror the default queryFn's 401 behavior so callers using apiFetch
  // (including hooks and explicit queryFn closures) get the same expired-
  // token UX as the default fetcher: clear the JWT and redirect to /login.
  if (res.status === 401) {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore storage errors
    }
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("401: token expired");
  }
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      headers: authHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    if (res.status === 401) {
      // Token expired — clear it so the user is redirected to login
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = "/login";
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
