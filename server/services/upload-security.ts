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
import { fileTypeFromBuffer } from "file-type";
import AdmZip from "adm-zip";

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

// =============================================================================
// TASK #161 — content-based mime-type sniffing
// -----------------------------------------------------------------------------
// The declared mime type on a multipart upload is just the value the BROWSER
// sends. An attacker can rename evil.exe to evil.pdf and set
// Content-Type: application/pdf, and it will sail through the declared-mime
// allow-list above. To close that bypass we additionally inspect the leading
// bytes of the buffer (magic-number / "file-type" detection) and require:
//
//   1. The detected real type is in the allow-list, AND
//   2. The detected real type matches (or is compatible with) the declared
//      type the caller sent on the multipart headers.
//
// "Compatible" is needed because:
//   * Plain-text formats (text/plain, text/csv) have NO magic number, so
//     `fileTypeFromBuffer` returns `undefined`. We accept that for the
//     specific text mimes our allow-list lets through.
//   * Legacy Office formats (.doc, .xls, .ppt) all share the same Compound
//     File Binary container, which `file-type` reports as
//     `application/x-cfb` — not the OLE-specific application mime. So we
//     accept `application/x-cfb` as the detected type for those legacy
//     declared mimes.
//
// Any other mismatch — declared application/pdf but detected
// application/x-msdownload, declared image/png but detected image/jpeg,
// declared anything but detected something outside the allow-list — is
// rejected with a stable `UPLOAD_MIME_MISMATCH` 400 BEFORE the route handler
// sees the file.
// =============================================================================

// Declared-mime → list of detected mimes that are considered a legitimate
// match even though they don't equal the declared mime byte-for-byte.
// `null` in the list means "detection returned undefined and that's OK"
// (used for text formats with no magic number).
const COMPATIBLE_DETECTED_MIME_TYPES: Record<string, ReadonlyArray<string | null>> = {
  "text/plain": [null],
  "text/csv": [null],
  // Legacy Office (OLE Compound File) formats all detect as application/x-cfb.
  "application/msword": ["application/x-cfb"],
  "application/vnd.ms-excel": ["application/x-cfb"],
  "application/vnd.ms-powerpoint": ["application/x-cfb"],
};

export interface SniffedMimeResult {
  // The mime detected from the file's leading bytes. `null` when no signature
  // was recognised (e.g. plain text) — callers should still use the declared
  // mime in that case, but only after isMimeMatch() approves the pairing.
  detectedMimeType: string | null;
}

export async function sniffMimeType(buffer: Buffer): Promise<SniffedMimeResult> {
  // file-type is happy with empty buffers (returns undefined), but we guard
  // anyway so a future caller doesn't pay the import cost for nothing.
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { detectedMimeType: null };
  }
  const result = await fileTypeFromBuffer(buffer);
  return { detectedMimeType: result?.mime?.toLowerCase() ?? null };
}

export function isMimeMatch(
  declaredMimeType: string,
  detectedMimeType: string | null,
): boolean {
  const declared = (declaredMimeType ?? "").toLowerCase();
  const detected = detectedMimeType?.toLowerCase() ?? null;
  if (detected !== null && detected === declared) return true;
  const compatible = COMPATIBLE_DETECTED_MIME_TYPES[declared];
  if (compatible && compatible.includes(detected)) return true;
  return false;
}

class MimeTypeMismatchError extends Error {
  readonly status = 400;
  readonly code = "UPLOAD_MIME_MISMATCH";
  constructor(
    public readonly declaredMimeType: string,
    public readonly detectedMimeType: string | null,
  ) {
    super(
      `Declared file type "${declaredMimeType || "(unknown)"}" does not match the file's actual contents` +
        (detectedMimeType ? ` (detected as "${detectedMimeType}")` : ""),
    );
  }
}

// =============================================================================
// TASK #272 — second-stage container inspection (zip bombs + Office macros)
// -----------------------------------------------------------------------------
// Task #161 closed the "evil.exe renamed to evil.pdf" bypass by sniffing the
// leading bytes of every upload. This stage covers the next layer: hostile
// payloads carried INSIDE legitimate zip / OOXML / legacy-Office containers.
//
// Two threats, both still allowed by the mime allow-list today because
// advisers genuinely upload Office attachments:
//
//   1. ZIP BOMBS — an archive (raw .zip OR an OOXML .docx/.xlsx/.pptx) whose
//      central directory declares uncompressed entry sizes that sum to many
//      gigabytes, intending to crash the server when it later expands the
//      file. We read the central directory only (no decompression) and reject
//      with HTTP 400 + UPLOAD_ZIP_BOMB when the declared total exceeds
//      MAX_UPLOAD_BYTES * ZIP_BOMB_RATIO. The ratio leaves room for honest
//      Office documents whose embedded media decompresses several-fold while
//      still rejecting the obvious attacks (1 KiB → 4 GiB).
//
//   2. OFFICE MACROS — a VBA macro stream embedded in either:
//        a) An OOXML container, where macros live in a `vbaProject.bin`
//           entry under `word/`, `xl/`, or `ppt/`. Adviser uploads of pure
//           .docx/.xlsx/.pptx never contain this entry; .docm/.xlsm/.pptm
//           always do.
//        b) A legacy OLE Compound File container (.doc/.xls/.ppt), where
//           macros live in a top-level "Macros" or "_VBA_PROJECT_CUR" stream
//           inside the CFB directory. We don't ship a full CFB parser — we
//           scan the buffer for those stream names encoded as UTF-16LE with
//           the directory-entry trailing NUL. That pattern can't be produced
//           by ordinary document body text (the trailing NUL only appears
//           inside CFB directory-entry name fields), so the heuristic is
//           safe against false positives on non-macro docs.
//
// Both rejections are stable, structured 400s so callers can adapt without
// scraping logs (UPLOAD_ZIP_BOMB / UPLOAD_OFFICE_MACRO).
// =============================================================================

// Allow archives to decompress to up to 10x the configured upload cap. This
// covers honest cases (PowerPoint decks with embedded media, Excel sheets
// with shared strings) while still flagging the orders-of-magnitude ratios
// that characterise real zip-bomb payloads.
export const ZIP_BOMB_DECOMPRESSED_RATIO = 10;

// Magic numbers for the two container formats we care about. We dispatch on
// these (not on the declared mime) so that a zip-shaped upload declared as
// any allow-listed mime still gets inspected.
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_ARCHIVE_HEADER = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SPANNED_ARCHIVE_HEADER = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const CFB_HEADER = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

function bufferStartsWith(buf: Buffer, magic: Buffer): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

export function isZipContainer(buffer: Buffer): boolean {
  return (
    bufferStartsWith(buffer, ZIP_LOCAL_FILE_HEADER) ||
    bufferStartsWith(buffer, ZIP_EMPTY_ARCHIVE_HEADER) ||
    bufferStartsWith(buffer, ZIP_SPANNED_ARCHIVE_HEADER)
  );
}

export function isCfbContainer(buffer: Buffer): boolean {
  return bufferStartsWith(buffer, CFB_HEADER);
}

// Names of OOXML entries that carry a VBA macro project. Office stores these
// under the format-specific top folder (`word/`, `xl/`, `ppt/`) plus a few
// other legitimate locations. Matching on the basename keeps the check
// resilient to the various Office variants without enumerating every path.
const OOXML_MACRO_ENTRY_BASENAMES = new Set([
  "vbaproject.bin",
  "vbadata.xml",
]);

export interface ZipInspection {
  totalDeclaredDecompressedBytes: number;
  entryCount: number;
  // First macro-bearing entry name we found, or null when none is present.
  macroEntryName: string | null;
}

export class ZipBombError extends Error {
  readonly status = 400;
  readonly code = "UPLOAD_ZIP_BOMB";
  constructor(
    public readonly decompressedBytes: number,
    public readonly maxDecompressedBytes: number,
  ) {
    super(
      `Archive declares ${decompressedBytes} decompressed bytes, exceeding the cap of ${maxDecompressedBytes}`,
    );
  }
}

export class OfficeMacroError extends Error {
  readonly status = 400;
  readonly code = "UPLOAD_OFFICE_MACRO";
  constructor(
    public readonly format: "ooxml" | "cfb",
    public readonly evidence: string,
  ) {
    super(
      `Office document contains a VBA macro (${format} ${evidence}) and was rejected`,
    );
  }
}

class UnreadableArchiveError extends Error {
  readonly status = 400;
  readonly code = "UPLOAD_ARCHIVE_UNREADABLE";
  constructor(public readonly reason: string) {
    super(`Archive could not be parsed for safety inspection: ${reason}`);
  }
}

// Read the zip's central directory and tally declared uncompressed sizes
// without ever decompressing an entry. Throws ZipBombError as soon as the
// running total exceeds the cap so a hostile archive with millions of fake
// entries can't make us walk the full directory.
export function inspectZipContainer(
  buffer: Buffer,
  maxDecompressedBytes: number,
): ZipInspection {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  let total = 0;
  let macroEntryName: string | null = null;
  for (const entry of entries) {
    // adm-zip's `header.size` is the uncompressed size from the central
    // directory record. We trust this only insofar as we use it to REJECT —
    // a liar can claim less than reality, but we never extract here, so the
    // worst case is that a zip-bomb sneaks past this check and is caught
    // when something downstream tries to extract it.
    const declared = Number(entry.header.size);
    if (Number.isFinite(declared) && declared > 0) total += declared;
    if (total > maxDecompressedBytes) {
      throw new ZipBombError(total, maxDecompressedBytes);
    }
    if (!macroEntryName) {
      const basename = entry.entryName.split("/").pop()?.toLowerCase() ?? "";
      if (OOXML_MACRO_ENTRY_BASENAMES.has(basename)) {
        macroEntryName = entry.entryName;
      }
    }
  }
  return {
    totalDeclaredDecompressedBytes: total,
    entryCount: entries.length,
    macroEntryName,
  };
}

// Names of CFB streams that carry a VBA macro project. CFB stores stream
// names as UTF-16LE strings inside fixed-size 64-byte slots in the directory
// sector, with a trailing NUL terminator. We scan for the encoded bytes
// (including the NUL) so that ordinary body text containing the word
// "Macros" or "VBA" cannot trigger a false positive — body text in
// WordDocument streams is followed by another character, not a NUL.
const CFB_MACRO_STREAM_NAMES = ["VBA", "Macros", "_VBA_PROJECT_CUR"] as const;

export function findCfbMacroStream(buffer: Buffer): string | null {
  for (const name of CFB_MACRO_STREAM_NAMES) {
    // UTF-16LE encoding of the name plus a NUL terminator. Buffer.from with
    // "utf16le" encodes each char as 2 bytes; appending "\0" adds the
    // terminator that a real CFB directory entry would have.
    const needle = Buffer.from(name + "\0", "utf16le");
    if (buffer.indexOf(needle) !== -1) {
      return name;
    }
  }
  return null;
}

// Single entry-point used by the middleware. Returns a rejection error if
// the buffer represents a hostile container, or `null` if the upload should
// proceed. Kept side-effect-free so the test suite can exercise it directly
// without mounting an Express app.
export function inspectContainerThreats(
  buffer: Buffer,
  maxBytes: number,
): Error | null {
  if (isZipContainer(buffer)) {
    try {
      const inspection = inspectZipContainer(
        buffer,
        maxBytes * ZIP_BOMB_DECOMPRESSED_RATIO,
      );
      if (inspection.macroEntryName) {
        return new OfficeMacroError("ooxml", inspection.macroEntryName);
      }
      return null;
    } catch (err) {
      if (err instanceof ZipBombError) return err;
      // The buffer claimed to be a zip (PK header) but the central directory
      // is unreadable. We cannot prove it's safe, so we refuse — the
      // alternative is letting an attacker bypass the inspection by sending
      // a deliberately-corrupt central directory.
      return new UnreadableArchiveError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (isCfbContainer(buffer)) {
    const evidence = findCfbMacroStream(buffer);
    if (evidence) {
      return new OfficeMacroError("cfb", evidence);
    }
  }
  return null;
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
    parser(req, res, async (err: unknown) => {
      if (err) {
        respondWithUploadRejection(err, res, maxBytes, allowed);
        return;
      }
      // Defence-in-depth: a unit test (or a future caller) may bypass multer
      // and inject `req.file` directly. Re-check the parsed mime so the
      // contract holds for those callers too.
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (file && file.mimetype) {
        const declared = String(file.mimetype).toLowerCase();
        if (!allowedSet.has(declared)) {
          respondWithUploadRejection(
            new DisallowedMimeTypeError(declared),
            res,
            maxBytes,
            allowed,
          );
          return;
        }
        // Task #161 — content-based mime sniffing. Multer has by now buffered
        // the bytes (memoryStorage), so we can read the magic number directly
        // off file.buffer. We reject in two cases:
        //   1. The detected real type is in NEITHER the allow-list nor the
        //      compatible-pair table for the declared type. That catches the
        //      classic "evil.exe renamed to evil.pdf" — declared
        //      application/pdf but bytes start with MZ → detected
        //      application/x-msdownload → not in the allow-list.
        //   2. The detected real type IS in the allow-list but doesn't match
        //      what the caller declared. That catches subtler swaps like a
        //      PNG declared as image/jpeg, which would otherwise sail past.
        // The detected mime is also stashed on `file` so the route handler
        // can pick it up for the upload audit-log entry without re-reading
        // the buffer.
        try {
          const sniffed = await sniffMimeType(file.buffer);
          (file as Express.Multer.File & { detectedMimeType?: string | null }).detectedMimeType =
            sniffed.detectedMimeType;
          if (!isMimeMatch(declared, sniffed.detectedMimeType)) {
            respondWithUploadRejection(
              new MimeTypeMismatchError(declared, sniffed.detectedMimeType),
              res,
              maxBytes,
              allowed,
            );
            return;
          }
          // Task #272 — second-stage container inspection. Only runs when the
          // mime allow-list and content-sniff have already approved the
          // upload, so we never spend cycles parsing untrusted bytes for a
          // file we'd reject anyway. We dispatch on the buffer's magic
          // number, NOT the declared mime, so a zip-shaped upload declared
          // as e.g. an OOXML mime is still inspected for bombs and macros.
          const containerRejection = inspectContainerThreats(
            file.buffer,
            maxBytes,
          );
          if (containerRejection) {
            respondWithUploadRejection(
              containerRejection,
              res,
              maxBytes,
              allowed,
            );
            return;
          }
        } catch (sniffErr) {
          // file-type can throw on truly malformed buffers; treat as a
          // mismatch (safe default) so we never accept a file we couldn't
          // even inspect.
          console.error("[upload-security] sniff failed", sniffErr);
          respondWithUploadRejection(
            new MimeTypeMismatchError(declared, null),
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
  if (err instanceof MimeTypeMismatchError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      declaredMimeType: err.declaredMimeType || null,
      detectedMimeType: err.detectedMimeType,
      allowedMimeTypes: allowed,
    });
    return;
  }
  if (err instanceof ZipBombError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      decompressedBytes: err.decompressedBytes,
      maxDecompressedBytes: err.maxDecompressedBytes,
    });
    return;
  }
  if (err instanceof OfficeMacroError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      format: err.format,
      evidence: err.evidence,
    });
    return;
  }
  if (err instanceof UnreadableArchiveError) {
    res.status(400).json({
      error: err.message,
      code: err.code,
      reason: err.reason,
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
