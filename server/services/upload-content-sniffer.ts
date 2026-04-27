// =============================================================================
// TASK #117 — Magic-byte sniffing for the client document upload route
// -----------------------------------------------------------------------------
// `buildUploadMiddleware` (Task #148) already enforces a mime allow-list, but
// it trusts the multipart `Content-Type` header the client sends. A hostile
// adviser can label an HTML payload with `image/png` and slip past that
// check entirely. This module closes the gap by inspecting the leading bytes
// of the uploaded buffer and refusing the upload when the sniffed family
// does not match what the caller declared.
//
// The sniffer is intentionally narrow: it only knows how to recognise the
// families that appear in DEFAULT_ALLOWED_MIME_TYPES. Anything outside that
// universe — executables, archives, scripts, video — sniffs as "unknown"
// and is rejected. We don't try to be a full libmagic clone; the goal is
// "the bytes look like the kind of file the caller said they were".
//
// Where this is enforced:
//   * `uploadClientDocument()` calls `assertContentMatchesDeclaredMime()`
//     before writing anything to object storage. The check throws a 415
//     (Unsupported Media Type) so the route surface returns the same
//     deterministic shape callers already handle for a 4xx upload reject.
// =============================================================================

export type DetectedFamily =
  | "pdf"
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "heic" // covers heic + heif, both share the ISO-BMFF ftyp container
  | "tiff"
  | "zip-ooxml" // .docx / .xlsx / .pptx (all zip containers)
  | "ole2" // legacy .doc / .xls / .ppt (compound file binary format)
  | "text" // plain text / csv — sniffed by absence of binary bytes
  | "unknown";

// Map a declared mime type to the family (or families) the bytes are
// expected to belong to. Anything not in this map is considered outside
// the supported set — `assertContentMatchesDeclaredMime` rejects it.
const MIME_TO_EXPECTED_FAMILIES: Record<string, readonly DetectedFamily[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heic"],
  "image/tiff": ["tiff"],
  "text/plain": ["text"],
  "text/csv": ["text"],
  // Legacy Office (binary OLE2 compound file).
  "application/msword": ["ole2"],
  "application/vnd.ms-excel": ["ole2"],
  "application/vnd.ms-powerpoint": ["ole2"],
  // Modern Office (zip container — OOXML).
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "zip-ooxml",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    "zip-ooxml",
  ],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "zip-ooxml",
  ],
};

export class UploadContentMismatchError extends Error {
  readonly status = 415;
  readonly code = "UPLOAD_CONTENT_MISMATCH";
  constructor(
    public readonly declaredMimeType: string | null,
    public readonly detectedFamily: DetectedFamily,
  ) {
    super(
      `Uploaded file content does not match declared type "${
        declaredMimeType ?? "(unknown)"
      }" (detected: ${detectedFamily})`,
    );
  }
}

// ---------------------------------------------------------------------------
// detectFileFamily — pure function, never throws.
// ---------------------------------------------------------------------------
// Inspects the leading bytes of `bytes` and returns the recognised family,
// or "unknown" if no signature matches. Order matters: the more specific
// signatures (PDF, PNG, JPEG, GIF, WebP, ISO-BMFF ftyp, TIFF, ZIP, OLE2)
// are checked before the printable-text heuristic, so a `<html>` payload
// labelled `image/png` is detected as "text" (not as HTML — text is the
// best we can do without HTML-aware parsing) and a real PNG is detected
// as "png" before the text heuristic ever runs.
// ---------------------------------------------------------------------------
export function detectFileFamily(bytes: Buffer): DetectedFamily {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) {
    return "unknown";
  }

  // PDF — "%PDF-" at the start. The PDF spec allows up to 1 KiB of leading
  // junk per Adobe's reader behaviour, but our writers always emit a clean
  // file so the strict prefix check is good enough.
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }

  // PNG — 8-byte signature.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG — SOI marker (FF D8 FF). Any JPEG variant (JFIF, EXIF, SPIFF)
  // starts with this 3-byte sequence.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }

  // GIF — "GIF87a" or "GIF89a".
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "gif";
  }

  // WebP — RIFF container with "WEBP" at offset 8.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }

  // HEIC / HEIF — ISO-BMFF "ftyp" box at offset 4 with a HEIC-family brand.
  // The 4-byte size precedes "ftyp", then the major brand at bytes 8..12.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  ) {
    const brand = bytes.slice(8, 12).toString("ascii");
    // Common HEIC/HEIF brands. mif1/msf1 are HEIF stills, heic/heix/heim/heis
    // are HEVC-encoded HEIC, hevc/hevx are HEVC sequences. We accept all
    // because Apple devices in the wild emit the full set.
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "heim" ||
      brand === "heis" ||
      brand === "heif" ||
      brand === "mif1" ||
      brand === "msf1" ||
      brand === "hevc" ||
      brand === "hevx"
    ) {
      return "heic";
    }
  }

  // TIFF — little-endian "II*\0" or big-endian "MM\0*".
  if (
    (bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x4d &&
      bytes[1] === 0x4d &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x2a)
  ) {
    return "tiff";
  }

  // ZIP container — PK\x03\x04 (local file header) or PK\x05\x06 (empty
  // archive end-of-central-directory). OOXML files (.docx/.xlsx/.pptx) are
  // zip archives, so any caller declaring an OOXML mime gets matched here.
  // We don't crack the archive open to confirm the OOXML content type —
  // that's what the upstream allow-list is for; the magic-byte check only
  // needs to confirm "this is a zip".
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  ) {
    return "zip-ooxml";
  }

  // OLE2 / Compound File Binary Format — legacy Office (.doc/.xls/.ppt).
  // 8-byte signature D0 CF 11 E0 A1 B1 1A E1.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return "ole2";
  }

  // Text — sniff a sample of the buffer for printable / whitespace bytes
  // only. We deliberately reject buffers that contain NUL or other control
  // bytes (other than tab/CR/LF), which catches binary payloads pretending
  // to be text/plain. We also reject buffers that look like HTML / XML
  // markup so a `<script>...</script>` payload labelled `text/plain` is
  // refused — the download route adds X-Content-Type-Options: nosniff and
  // an `attachment` disposition, but a defence-in-depth refusal here means
  // a bug in either of those headers can't reopen the XSS path on its own.
  if (looksLikeSafeText(bytes)) {
    return "text";
  }

  return "unknown";
}

function looksLikeSafeText(bytes: Buffer): boolean {
  const SAMPLE = Math.min(bytes.length, 4096);
  if (SAMPLE === 0) return false;
  for (let i = 0; i < SAMPLE; i++) {
    const b = bytes[i];
    // Allow tab (0x09), LF (0x0A), CR (0x0D), and printable ASCII +
    // non-control UTF-8 continuation bytes (>= 0x20). Reject NUL and
    // other C0 control bytes — they're a strong signal the buffer is
    // actually binary.
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20) return false;
    if (b === 0x7f) return false; // DEL
  }
  // Reject obvious markup. We're not trying to parse HTML — just looking
  // for the leading-token shapes a browser would treat as "definitely
  // markup" if MIME sniffing ever did kick in.
  const head = bytes
    .slice(0, Math.min(SAMPLE, 512))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<?xml") ||
    head.startsWith("<svg")
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// assertContentMatchesDeclaredMime — throws 415 on a mismatch.
// ---------------------------------------------------------------------------
// `declaredMimeType` is whatever the upload route stored on the row (which
// is in turn whatever the multipart layer parsed off the `Content-Type`
// header). A null / empty / unsupported declared type is treated the same
// as a mismatch — the caller MUST tell us what they're uploading.
// ---------------------------------------------------------------------------
export function assertContentMatchesDeclaredMime(
  declaredMimeType: string | null | undefined,
  bytes: Buffer,
): DetectedFamily {
  const declared = (declaredMimeType ?? "").trim().toLowerCase();
  const expected = declared ? MIME_TO_EXPECTED_FAMILIES[declared] : undefined;
  const detected = detectFileFamily(bytes);
  if (!expected) {
    // Either no declared mime, or one that isn't on the supported list at
    // all. The upstream allow-list should have caught this, but failing
    // closed here means a future caller that bypasses multer (e.g. an
    // internal job) still gets the same protection.
    throw new UploadContentMismatchError(declared || null, detected);
  }
  if (!expected.includes(detected)) {
    throw new UploadContentMismatchError(declared, detected);
  }
  return detected;
}
