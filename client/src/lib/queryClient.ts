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

// Multipart upload helper. Mirrors apiRequest's auth + 401 handling but
// deliberately omits the JSON Content-Type so the browser can set the
// multipart boundary itself. On non-OK responses it tries to parse the
// JSON body so the caller can read `code`/`error` fields straight off the
// thrown ApiUploadError and surface a friendly toast (e.g. UPLOAD_TOO_LARGE,
// UPLOAD_MIME_REJECTED). Falls back to the raw response text when the body
// is not JSON.
export async function apiUpload(
  url: string,
  body: FormData,
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body,
  });
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
  if (!res.ok) {
    const raw = await res.text();
    const parsed = parseUploadErrorBody(raw);
    const message =
      parsed?.error ||
      parsed?.message ||
      raw ||
      `${res.status}: upload failed`;
    throw new ApiUploadError(message, {
      status: res.status,
      code: parsed?.code,
      body: parsed ?? raw,
    });
  }
  return res;
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
