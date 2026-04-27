// =============================================================================
// Task #148 — automated tests for the upload size + mime allow-list
// =============================================================================
// Locks in three guarantees of buildUploadMiddleware():
//
//   1. Files larger than the configured byte cap are rejected with HTTP 400
//      and a stable `code: "UPLOAD_TOO_LARGE"` payload — and crucially,
//      the route handler that would have written to object storage is
//      NEVER invoked. (Multer truncates the stream before handing bytes
//      to the storage engine, but the route-level expectation is what we
//      contract on.)
//
//   2. Files whose declared mime type is outside the allow-list are
//      rejected with HTTP 400 and `code: "UPLOAD_MIME_REJECTED"`. The
//      route handler is again NEVER invoked. The 400 payload includes the
//      allow-list so a client can adapt without scraping documentation.
//
//   3. A file inside both limits flows through to the route handler with
//      `req.file.buffer` populated. This is the happy path — without it
//      we'd be one wrong refactor away from rejecting every legitimate
//      upload.
//
// We exercise the middleware by mounting it on a tiny throw-away Express app
// and posting multipart bodies via supertest, so the test reflects the same
// HTTP contract the real route enforces — not just the multer config in
// isolation.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  buildUploadMiddleware,
  isMimeMatch,
  resolveAllowedMimeTypes,
  resolveMaxUploadBytes,
  sniffMimeType,
} from "./upload-security";

// Task #161 — fixtures for content-based mime sniffing tests. All buffers
// here are constructed from real magic numbers so file-type detects them
// the same way it would in production. Keeping the bytes inline (rather
// than reading test fixture files) keeps the test suite hermetic.

// Minimal valid-enough PDF: starts with "%PDF-" magic + binary marker so
// file-type confidently classifies it as application/pdf. Trailing bytes
// don't matter for sniffing.
const REAL_PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary"),
  Buffer.from("1 0 obj<<>>endobj\n%%EOF"),
]);

// Minimal Windows PE/EXE: "MZ" header followed by enough zeroes to satisfy
// the DOS stub layout. file-type returns application/x-msdownload for this.
const FAKE_EXE_BYTES = (() => {
  const header = Buffer.alloc(64, 0);
  header.write("MZ", 0, "ascii");
  // Offset 0x3c is the e_lfanew pointer to the PE header.
  header.writeUInt32LE(64, 60);
  const pe = Buffer.alloc(24, 0);
  pe.write("PE\0\0", 0, "ascii");
  return Buffer.concat([header, pe]);
})();

// Smallest legal-looking PNG: 8-byte signature + an IHDR chunk. file-type
// recognises this as image/png.
const REAL_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x00, 0x01, // width = 1
  0x00, 0x00, 0x00, 0x01, // height = 1
  0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, colour type, etc.
]);

function makeApp(opts?: Parameters<typeof buildUploadMiddleware>[0]) {
  const app = express();
  const mw = buildUploadMiddleware(opts);
  // The handler is what would write to object storage in production; in the
  // tests it just echoes the parsed file metadata back so we can assert on
  // it. If the middleware allowed a rejected upload through, this handler
  // would run AND we'd see its echo — that's the negative-case sentinel.
  const onUploaded = vi.fn((req: express.Request, res: express.Response) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    res.json({
      ok: true,
      sizeBytes: file?.size ?? null,
      mimeType: file?.mimetype ?? null,
    });
  });
  app.post("/upload", mw.handler, onUploaded);
  return { app, mw, onUploaded };
}

describe("buildUploadMiddleware", () => {
  it("accepts a small PDF inside both the size and mime allow-list", async () => {
    const { app, onUploaded, mw } = makeApp();
    const res = await request(app)
      .post("/upload")
      .attach("file", REAL_PDF_BYTES, {
        filename: "ok.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mimeType: "application/pdf",
      sizeBytes: REAL_PDF_BYTES.length,
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    // Sanity-check the helper resolved the env-defaulted limits.
    expect(mw.maxBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(mw.allowedMimeTypes).toEqual(
      DEFAULT_ALLOWED_MIME_TYPES.map((s) => s.toLowerCase()),
    );
  });

  it("rejects an oversized file with 400 + UPLOAD_TOO_LARGE and never invokes the route handler", async () => {
    // Configure a tiny 1 KiB cap so we don't have to allocate 25 MiB in tests.
    const { app, onUploaded, mw } = makeApp({ maxBytes: 1024 });
    const body = Buffer.alloc(2048, 0x41); // 2 KiB of 'A'
    const res = await request(app)
      .post("/upload")
      .attach("file", body, {
        filename: "too-big.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_TOO_LARGE",
      maxBytes: 1024,
    });
    expect(res.body.error).toMatch(/maximum upload size/i);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(mw.maxBytes).toBe(1024);
  });

  it("rejects a disallowed mime type with 400 + UPLOAD_MIME_REJECTED and never invokes the route handler", async () => {
    const { app, onUploaded } = makeApp();
    const body = Buffer.from("MZ" + "executable bytes here");
    const res = await request(app)
      .post("/upload")
      .attach("file", body, {
        filename: "evil.exe",
        contentType: "application/x-msdownload",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_MIME_REJECTED",
      mimeType: "application/x-msdownload",
    });
    // The 400 payload exposes the allow-list so the caller knows what to send.
    expect(Array.isArray(res.body.allowedMimeTypes)).toBe(true);
    expect(res.body.allowedMimeTypes).toContain("application/pdf");
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("rejects a second file when the request contains more than one", async () => {
    const { app, onUploaded } = makeApp();
    const res = await request(app)
      .post("/upload")
      .attach("file", Buffer.from("%PDF one"), {
        filename: "one.pdf",
        contentType: "application/pdf",
      })
      .attach("file", Buffer.from("%PDF two"), {
        filename: "two.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    // Either LIMIT_FILE_COUNT or LIMIT_UNEXPECTED_FILE is acceptable here —
    // multer raises one or the other depending on how it sees the second
    // file in the multipart stream. Both are surfaced as 400 by the helper.
    expect(["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"]).toContain(
      res.body.code,
    );
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("respects a route-level mime allow-list override", async () => {
    const { app, onUploaded } = makeApp({
      allowedMimeTypes: ["image/png"],
    });
    // PDFs are in the default list but NOT in this route's override, so they
    // should now be rejected.
    const res = await request(app)
      .post("/upload")
      .attach("file", REAL_PDF_BYTES, {
        filename: "ok.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UPLOAD_MIME_REJECTED");
    expect(res.body.allowedMimeTypes).toEqual(["image/png"]);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Task #161 — content-based mime sniffing tests
  // ---------------------------------------------------------------------------
  // The declared-mime tests above only protect against callers who are honest
  // about what they're sending. These tests cover the disguise-the-extension
  // attack: bytes whose real type does NOT match the multipart Content-Type
  // header. Even though the declared type is in the allow-list, the upload
  // must be rejected because the actual bytes are something else.
  // ===========================================================================

  it("rejects an EXE renamed to .pdf even when the declared mime is application/pdf", async () => {
    // The classic disguise: attacker takes a Windows executable and uploads
    // it as Content-Type: application/pdf to bypass the mime allow-list.
    // The declared type IS allowed, so the old declared-mime check would
    // accept this. The new sniffer should detect application/x-msdownload
    // from the leading "MZ" bytes and reject with UPLOAD_MIME_MISMATCH.
    const { app, onUploaded } = makeApp();
    const res = await request(app)
      .post("/upload")
      .attach("file", FAKE_EXE_BYTES, {
        filename: "evil.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_MIME_MISMATCH",
      declaredMimeType: "application/pdf",
      detectedMimeType: "application/x-msdownload",
    });
    expect(res.body.error).toMatch(/does not match/i);
    // The route handler — which would have written the EXE to object
    // storage — must never run.
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("accepts a legitimate PDF whose magic bytes match the declared mime", async () => {
    // The positive-control to the test above. Without this we'd be one wrong
    // refactor away from rejecting every legitimate PDF the advisers upload.
    const { app, onUploaded } = makeApp();
    const res = await request(app)
      .post("/upload")
      .attach("file", REAL_PDF_BYTES, {
        filename: "client-statement.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mimeType: "application/pdf",
      sizeBytes: REAL_PDF_BYTES.length,
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("rejects a PNG that's been declared as image/jpeg (mismatch within the allow-list)", async () => {
    // Subtler than the EXE case: both image/png and image/jpeg are in the
    // allow-list, so a pure declared-mime check would happily accept a PNG
    // labelled as JPEG. The sniffer must catch the mismatch — otherwise we
    // can't trust the mime we persist on the document row.
    const { app, onUploaded } = makeApp();
    const res = await request(app)
      .post("/upload")
      .attach("file", REAL_PNG_BYTES, {
        filename: "looks-like.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_MIME_MISMATCH",
      declaredMimeType: "image/jpeg",
      detectedMimeType: "image/png",
    });
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("accepts plain text declared as text/plain even though file-type returns no signature", async () => {
    // text/plain has no magic number — `fileTypeFromBuffer` returns
    // `undefined`. The compatible-pair table explicitly accepts that for
    // the small set of text mimes our allow-list lets through. Without this
    // exemption every CSV / TXT upload would be falsely rejected.
    const { app, onUploaded } = makeApp();
    const body = Buffer.from("dear adviser,\nplease find enclosed...\n");
    const res = await request(app)
      .post("/upload")
      .attach("file", body, {
        filename: "note.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mimeType: "text/plain",
      sizeBytes: body.length,
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("exposes the sniffed mime type on req.file.detectedMimeType for the route handler", async () => {
    // The adviser document upload route needs the detected mime so it can
    // record BOTH the declared and the sniffed types in the audit log.
    // This test pins the contract that the middleware decorates `req.file`
    // with `detectedMimeType` — without it, the audit row would silently
    // record `null` and the regulator-facing forensics would be useless.
    const app = express();
    const mw = buildUploadMiddleware();
    let capturedDetected: unknown;
    app.post("/upload", mw.handler, (req, res) => {
      const file = (req as unknown as {
        file?: Express.Multer.File & { detectedMimeType?: string | null };
      }).file;
      capturedDetected = file?.detectedMimeType;
      res.json({ ok: true });
    });
    const res = await request(app)
      .post("/upload")
      .attach("file", REAL_PDF_BYTES, {
        filename: "ok.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);
    expect(capturedDetected).toBe("application/pdf");
  });
});

describe("sniffMimeType / isMimeMatch", () => {
  it("detects a PDF from its leading bytes", async () => {
    expect(await sniffMimeType(REAL_PDF_BYTES)).toEqual({
      detectedMimeType: "application/pdf",
    });
  });

  it("detects a Windows executable as application/x-msdownload", async () => {
    expect(await sniffMimeType(FAKE_EXE_BYTES)).toEqual({
      detectedMimeType: "application/x-msdownload",
    });
  });

  it("returns null for plain-text input that has no magic number", async () => {
    expect(await sniffMimeType(Buffer.from("just words\n"))).toEqual({
      detectedMimeType: null,
    });
  });

  it("returns null for an empty buffer instead of throwing", async () => {
    expect(await sniffMimeType(Buffer.alloc(0))).toEqual({
      detectedMimeType: null,
    });
  });

  it("treats matching declared and detected types as a match", () => {
    expect(isMimeMatch("application/pdf", "application/pdf")).toBe(true);
    expect(isMimeMatch("IMAGE/PNG", "image/png")).toBe(true);
  });

  it("treats mismatched detected types as a non-match even when both are allowed", () => {
    expect(isMimeMatch("image/jpeg", "image/png")).toBe(false);
    expect(isMimeMatch("application/pdf", "application/x-msdownload")).toBe(
      false,
    );
  });

  it("accepts null detection for the text mimes that have no magic number", () => {
    expect(isMimeMatch("text/plain", null)).toBe(true);
    expect(isMimeMatch("text/csv", null)).toBe(true);
  });

  it("rejects null detection for binary mimes that should always have a signature", () => {
    expect(isMimeMatch("application/pdf", null)).toBe(false);
    expect(isMimeMatch("image/png", null)).toBe(false);
  });

  it("accepts application/x-cfb as the detected type for legacy Office formats", () => {
    // file-type reports the OLE Compound File container for .doc/.xls/.ppt
    // rather than the OLE-specific application mime. The compatible-pair
    // table must let those through or every legacy-Office upload would be
    // rejected.
    expect(isMimeMatch("application/msword", "application/x-cfb")).toBe(true);
    expect(isMimeMatch("application/vnd.ms-excel", "application/x-cfb")).toBe(
      true,
    );
    expect(
      isMimeMatch("application/vnd.ms-powerpoint", "application/x-cfb"),
    ).toBe(true);
  });
});

describe("resolveMaxUploadBytes / resolveAllowedMimeTypes", () => {
  it("falls back to the default cap when MAX_UPLOAD_BYTES is unset or invalid", () => {
    const original = process.env.MAX_UPLOAD_BYTES;
    try {
      delete process.env.MAX_UPLOAD_BYTES;
      expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
      process.env.MAX_UPLOAD_BYTES = "not-a-number";
      expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
      process.env.MAX_UPLOAD_BYTES = "0";
      expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
      process.env.MAX_UPLOAD_BYTES = "-1";
      expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    } finally {
      if (original === undefined) delete process.env.MAX_UPLOAD_BYTES;
      else process.env.MAX_UPLOAD_BYTES = original;
    }
  });

  it("honours a positive MAX_UPLOAD_BYTES override", () => {
    const original = process.env.MAX_UPLOAD_BYTES;
    try {
      process.env.MAX_UPLOAD_BYTES = "5000";
      expect(resolveMaxUploadBytes()).toBe(5000);
    } finally {
      if (original === undefined) delete process.env.MAX_UPLOAD_BYTES;
      else process.env.MAX_UPLOAD_BYTES = original;
    }
  });

  it("falls back to the default mime allow-list when UPLOAD_ALLOWED_MIME_TYPES is unset or empty", () => {
    const original = process.env.UPLOAD_ALLOWED_MIME_TYPES;
    try {
      delete process.env.UPLOAD_ALLOWED_MIME_TYPES;
      expect(resolveAllowedMimeTypes()).toEqual([...DEFAULT_ALLOWED_MIME_TYPES]);
      process.env.UPLOAD_ALLOWED_MIME_TYPES = "   ,  , ";
      expect(resolveAllowedMimeTypes()).toEqual([...DEFAULT_ALLOWED_MIME_TYPES]);
    } finally {
      if (original === undefined) delete process.env.UPLOAD_ALLOWED_MIME_TYPES;
      else process.env.UPLOAD_ALLOWED_MIME_TYPES = original;
    }
  });

  it("honours a comma-separated UPLOAD_ALLOWED_MIME_TYPES override (lowercased + trimmed)", () => {
    const original = process.env.UPLOAD_ALLOWED_MIME_TYPES;
    try {
      process.env.UPLOAD_ALLOWED_MIME_TYPES = " Image/PNG , application/PDF ";
      expect(resolveAllowedMimeTypes()).toEqual([
        "image/png",
        "application/pdf",
      ]);
    } finally {
      if (original === undefined) delete process.env.UPLOAD_ALLOWED_MIME_TYPES;
      else process.env.UPLOAD_ALLOWED_MIME_TYPES = original;
    }
  });
});
