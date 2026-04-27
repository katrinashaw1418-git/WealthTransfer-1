// =============================================================================
// TASK #148 — UPLOAD SIZE + MIME ENFORCEMENT (security hardening for go-live)
// -----------------------------------------------------------------------------
// Centralised middleware factory that wraps multer with:
//   1. A maximum file size (configurable; default 25 MiB).
//   2. A strict mime-type allow-list (configurable; sensible defaults for the
//      kinds of artefacts our advisers actually attach — PDFs, common images,
//      common office documents, plain text / CSV).
//   3. Clear, structured 400 responses on rejection (size or disallowed mime),
//      so the upload is refused BEFORE any bytes are handed off to object
//      storage.
//
// Why a shared helper rather than configuring multer inline at each route?
//   * `client-documents/upload` is the only file-upload route today, but the
//     audit checklist that produced this task explicitly asks for "all
//     file-upload routes" to be covered. Having one factory means any new
//     upload route gets the same guarantees by default — there is no quiet
//     gap to drift into.
//   * Tests can lock in the rejection behaviour against the same factory the
//     real route uses (see upload-security.test.ts), which prevents the
//     routes-only "I added a fileFilter, I'm fine" mistake.
//
// Configuration:
//   * MAX_UPLOAD_BYTES (env, optional)            — integer bytes; default
//                                                   25 MiB. Invalid values
//                                                   fall back to the default.
//   * UPLOAD_ALLOWED_MIME_TYPES (env, optional)   — comma-separated list;
//                                                   replaces the defaults
//                                                   entirely when set.
//
// Notes on the rejection contract:
//   * multer's `limits.fileSize` truncates the stream when the limit is
//     hit and surfaces a `LIMIT_FILE_SIZE` MulterError to the next callback;
//     the truncated bytes are NEVER forwarded to the storage engine.
//   * multer's `fileFilter` is called BEFORE any bytes are written to the
//     storage engine (memoryStorage in our case), so a disallowed mime type
//     is rejected before the file ever exists in memory.
//   * We deliberately respond with 400 (not 413) on size: the task spec says
//     "returns a 400 and nothing is written to object storage". 413 would be
//     more semantically pure but the spec contract wins.
// =============================================================================

import multer from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB

// Conservative allow-list aimed at advice / KYC / correspondence artefacts.
// Anything outside this list (e.g. executables, scripts, archives, video) is
// rejected with a 400 — pen-test surface stays small. Operators can extend
// via UPLOAD_ALLOWED_MIME_TYPES if a specific business case appears.
export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

export function resolveMaxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.floor(n);
}

export function resolveAllowedMimeTypes(): string[] {
  const raw = process.env.UPLOAD_ALLOWED_MIME_TYPES;
  if (!raw) return [...DEFAULT_ALLOWED_MIME_TYPES];
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [...DEFAULT_ALLOWED_MIME_TYPES];
}

class DisallowedMimeTypeError extends Error {
  readonly status = 400;
  readonly code = "UPLOAD_MIME_REJECTED";
  constructor(public readonly mimeType: string) {
    super(`File type "${mimeType || "(unknown)"}" is not allowed`);
  }
}

export interface UploadMiddlewareOptions {
  // Form-data field name. Defaults to "file" — matches the existing
  // adviser document upload contract.
  fieldName?: string;
  // Override the default 25 MiB cap. Pass when a route legitimately needs a
  // smaller cap (e.g. an avatar route capped at 1 MiB) — never pass a larger
  // value without explicit security review.
  maxBytes?: number;
  // Override the default mime allow-list. Pass a route-specific list (e.g.
  // ["image/jpeg", "image/png"] for an avatar route) when relevant.
  allowedMimeTypes?: readonly string[];
}

export interface BuiltUploadMiddleware {
  // The configured limits — exposed so the route can include them in its
  // audit-log entry / 400 payload. Read-only by intent.
  readonly maxBytes: number;
  readonly allowedMimeTypes: readonly string[];
  // The Express middleware to register before the route handler. Handles
  // rejection itself (responds with 400) — does NOT delegate to the global
  // error handler so the route handler is never invoked on a rejected upload.
  readonly handler: RequestHandler;
}

export function buildUploadMiddleware(
  opts: UploadMiddlewareOptions = {},
): BuiltUploadMiddleware {
  const fieldName = opts.fieldName ?? "file";
  const maxBytes = opts.maxBytes ?? resolveMaxUploadBytes();
  const allowed = (opts.allowedMimeTypes ?? resolveAllowedMimeTypes()).map((s) =>
    s.toLowerCase(),
  );
  const allowedSet = new Set(allowed);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      // One file per request; multipart fields are still allowed alongside.
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const mt = (file.mimetype ?? "").toLowerCase();
      if (!allowedSet.has(mt)) {
        // Rejecting via cb(err) ensures multer never writes bytes to the
        // storage engine for this file — the rejection happens before the
        // body stream is consumed.
        cb(new DisallowedMimeTypeError(mt));
        return;
      }
      cb(null, true);
    },
  });

  const parser = upload.single(fieldName);

  const handler: RequestHandler = (req, res, next) => {
    parser(req, res, (err: unknown) => {
      if (err) {
        respondWithUploadRejection(err, res, maxBytes, allowed);
        return;
      }
      // Defence-in-depth: a unit test (or a future caller) may bypass multer
      // and inject `req.file` directly. Re-check the parsed mime so the
      // contract holds for those callers too.
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (file && file.mimetype) {
        const mt = String(file.mimetype).toLowerCase();
        if (!allowedSet.has(mt)) {
          respondWithUploadRejection(
            new DisallowedMimeTypeError(mt),
            res,
            maxBytes,
            allowed,
          );
          return;
        }
      }
      next();
    });
  };

  return { maxBytes, allowedMimeTypes: allowed, handler };
}

function respondWithUploadRejection(
  err: unknown,
  res: Response,
  maxBytes: number,
  allowed: readonly string[],
): void {
  if (err instanceof DisallowedMimeTypeError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      mimeType: err.mimeType || null,
      allowedMimeTypes: allowed,
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: `File exceeds maximum upload size of ${maxBytes} bytes`,
        code: "UPLOAD_TOO_LARGE",
        maxBytes,
      });
      return;
    }
    if (
      err.code === "LIMIT_FILE_COUNT" ||
      err.code === "LIMIT_UNEXPECTED_FILE"
    ) {
      res.status(400).json({
        error: "Only a single file upload is allowed",
        code: err.code,
      });
      return;
    }
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  // Fallback: unknown error from multer or the file filter — return 400 so
  // the client sees a deterministic rejection, but log so an operator can
  // notice if multer ever surfaces a new error shape we didn't anticipate.
  console.error("[upload-security] unexpected upload error", err);
  res.status(400).json({
    error: "Upload rejected",
    code: "UPLOAD_REJECTED",
  });
}
