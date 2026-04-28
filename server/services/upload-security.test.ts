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
import AdmZip from "adm-zip";
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  ZIP_BOMB_DECOMPRESSED_RATIO,
  buildUploadMiddleware,
  findCfbMacroStream,
  inspectContainerThreats,
  inspectZipContainer,
  isCfbContainer,
  isMimeMatch,
  isZipContainer,
  OfficeMacroError,
  resolveAllowedMimeTypes,
  resolveMaxUploadBytes,
  sniffMimeType,
  ZipBombError,
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

// =============================================================================
// Task #272 — zip-bomb + Office-macro container inspection
// -----------------------------------------------------------------------------
// The mime allow-list and the Task #161 sniffer between them stop binaries
// renamed to .pdf, but they still wave through any well-formed zip / OOXML /
// legacy-Office container. This block covers the second-stage inspection
// that protects us against:
//
//   * "zip bomb" archives whose central directory declares a decompressed
//     size large enough to exhaust the server when extracted, AND
//   * macro-bearing Office documents (OOXML .docm/.xlsm/.pptm carrying a
//     vbaProject.bin entry, or legacy CFB .doc/.xls/.ppt carrying a Macros /
//     VBA stream in the OLE directory).
//
// The fixtures are constructed in-memory so the suite stays hermetic — no
// binary blobs to commit, and we can deterministically tune sizes against
// the configured cap.
// =============================================================================

// Builds a minimal-but-valid OOXML wordprocessingml.document container
// (file-type's docx detector inspects [Content_Types].xml + the `word/`
// folder, so we have to ship those for the sniff stage to recognise the
// upload as docx rather than as a generic zip). When `withMacro` is true
// the archive also contains `word/vbaProject.bin`, which is the entry
// real .docm files carry.
function makeDocxBuffer(opts: { withMacro: boolean }): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
  );
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`,
    ),
  );
  if (opts.withMacro) {
    // Real VBA project bytes start with a small CFB header and follow a
    // documented binary layout, but the second-stage check only matches on
    // the entry NAME — the contents are irrelevant for that decision, so a
    // placeholder is sufficient and keeps the fixture small.
    zip.addFile(
      "word/vbaProject.bin",
      Buffer.from("placeholder VBA project bytes"),
    );
  }
  return zip.toBuffer();
}

// Build a "zip bomb" — an archive whose central-directory record claims
// `declaredSize` uncompressed bytes for its single entry. Real zip bombs
// achieve this by packing repeating zeros that deflate to almost nothing;
// adm-zip will compress our zero-filled buffer the same way, so the file
// on disk stays tiny while the central directory's size field reports the
// full count. That's the exact shape inspectZipContainer() looks for.
function makeZipBombBuffer(declaredSize: number): Buffer {
  const zip = new AdmZip();
  zip.addFile("payload.bin", Buffer.alloc(declaredSize, 0));
  return zip.toBuffer();
}

// Build a CFB (legacy Office) container shell with a directory entry whose
// name is `entryName`. Real legacy Office files have a much richer
// structure, but the macro check matches purely on the UTF-16LE-encoded
// stream-name pattern in the directory, so a synthetic CFB is enough to
// exercise the heuristic deterministically. Without `entryName` the buffer
// is a CFB-shaped blob with no macro stream — the negative control.
function makeCfbBuffer(entryName: string | null): Buffer {
  // 512-byte header + 512-byte directory sector. Directory entries are 128
  // bytes each; the first slot is the root entry, the second slot is where
  // we plant `entryName` when present.
  const header = Buffer.alloc(512, 0);
  // CFB magic.
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  const dirSector = Buffer.alloc(512, 0);
  if (entryName !== null) {
    // Plant the UTF-16LE encoded name + NUL terminator inside the second
    // directory entry's name field (offset 128, name field is 0..63 of the
    // 128-byte slot).
    const encoded = Buffer.from(entryName + "\0", "utf16le");
    encoded.copy(dirSector, 128);
  }
  return Buffer.concat([header, dirSector]);
}

describe("isZipContainer / isCfbContainer", () => {
  it("recognises a zip local-file-header (PK\\x03\\x04) as a zip", () => {
    const zip = makeDocxBuffer({ withMacro: false });
    expect(isZipContainer(zip)).toBe(true);
    expect(isCfbContainer(zip)).toBe(false);
  });

  it("recognises a CFB header as CFB but not as zip", () => {
    const cfb = makeCfbBuffer(null);
    expect(isCfbContainer(cfb)).toBe(true);
    expect(isZipContainer(cfb)).toBe(false);
  });

  it("does not classify arbitrary bytes as either container", () => {
    expect(isZipContainer(REAL_PDF_BYTES)).toBe(false);
    expect(isCfbContainer(REAL_PDF_BYTES)).toBe(false);
    expect(isZipContainer(Buffer.alloc(0))).toBe(false);
    expect(isCfbContainer(Buffer.alloc(2))).toBe(false);
  });
});

describe("inspectZipContainer", () => {
  it("returns the running totals for an honest archive under the cap", () => {
    const zip = makeDocxBuffer({ withMacro: false });
    const result = inspectZipContainer(zip, 10 * 1024 * 1024);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.totalDeclaredDecompressedBytes).toBeGreaterThan(0);
    expect(result.macroEntryName).toBeNull();
  });

  it("flags an OOXML archive that contains word/vbaProject.bin", () => {
    const zip = makeDocxBuffer({ withMacro: true });
    const result = inspectZipContainer(zip, 10 * 1024 * 1024);
    expect(result.macroEntryName).toBe("word/vbaProject.bin");
  });

  it("throws ZipBombError when the declared decompressed size exceeds the cap", () => {
    // 11 KiB declared, cap of 10 KiB → must reject.
    const zip = makeZipBombBuffer(11 * 1024);
    expect(() => inspectZipContainer(zip, 10 * 1024)).toThrow(ZipBombError);
    try {
      inspectZipContainer(zip, 10 * 1024);
    } catch (err) {
      expect(err).toBeInstanceOf(ZipBombError);
      const bomb = err as ZipBombError;
      expect(bomb.code).toBe("UPLOAD_ZIP_BOMB");
      expect(bomb.maxDecompressedBytes).toBe(10 * 1024);
      expect(bomb.decompressedBytes).toBeGreaterThan(10 * 1024);
    }
  });
});

describe("findCfbMacroStream", () => {
  it("finds the UTF-16LE encoded VBA stream name in a CFB buffer", () => {
    expect(findCfbMacroStream(makeCfbBuffer("VBA"))).toBe("VBA");
  });

  it("finds the Macros stream name", () => {
    expect(findCfbMacroStream(makeCfbBuffer("Macros"))).toBe("Macros");
  });

  it("finds the _VBA_PROJECT_CUR stream name", () => {
    expect(findCfbMacroStream(makeCfbBuffer("_VBA_PROJECT_CUR"))).toBe(
      "_VBA_PROJECT_CUR",
    );
  });

  it("returns null when no macro stream is present", () => {
    expect(findCfbMacroStream(makeCfbBuffer(null))).toBeNull();
    expect(findCfbMacroStream(makeCfbBuffer("WordDocument"))).toBeNull();
  });

  it("does not false-positive on body text containing the word 'Macros'", () => {
    // Body text encoded as UTF-16LE without a NUL terminator must NOT match.
    // This is the property that makes the substring scan safe to run on
    // legacy Office files whose body legitimately mentions the word.
    const body = Buffer.from("The Macros chapter explains everything.", "utf16le");
    const wrapped = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504, 0),
      body,
    ]);
    expect(findCfbMacroStream(wrapped)).toBeNull();
  });
});

describe("inspectContainerThreats (integration)", () => {
  it("returns null for a non-container payload", () => {
    expect(inspectContainerThreats(REAL_PDF_BYTES, 1024)).toBeNull();
  });

  it("rejects a zip-bomb fixture with ZipBombError", () => {
    // maxBytes = 1 KiB → cap = 10 KiB. Declare 12 KiB to clear it.
    const bomb = makeZipBombBuffer(12 * 1024);
    const rejection = inspectContainerThreats(bomb, 1024);
    expect(rejection).toBeInstanceOf(ZipBombError);
  });

  it("rejects a docm fixture (OOXML with vbaProject.bin) with OfficeMacroError", () => {
    const docm = makeDocxBuffer({ withMacro: true });
    const rejection = inspectContainerThreats(docm, 25 * 1024 * 1024);
    expect(rejection).toBeInstanceOf(OfficeMacroError);
    const macro = rejection as OfficeMacroError;
    expect(macro.format).toBe("ooxml");
    expect(macro.evidence).toBe("word/vbaProject.bin");
  });

  it("returns null for a clean docx (no macros, sensible decompressed size)", () => {
    const docx = makeDocxBuffer({ withMacro: false });
    expect(inspectContainerThreats(docx, 25 * 1024 * 1024)).toBeNull();
  });

  it("rejects a CFB blob that contains a VBA stream", () => {
    const macroDoc = makeCfbBuffer("VBA");
    const rejection = inspectContainerThreats(macroDoc, 25 * 1024 * 1024);
    expect(rejection).toBeInstanceOf(OfficeMacroError);
    const macro = rejection as OfficeMacroError;
    expect(macro.format).toBe("cfb");
    expect(macro.evidence).toBe("VBA");
  });

  it("returns null for a CFB blob with no macro stream", () => {
    expect(inspectContainerThreats(makeCfbBuffer(null), 25 * 1024 * 1024)).toBeNull();
  });

  it("exposes a sane DECOMPRESSED_RATIO so honest Office docs are not rejected", () => {
    // Sanity check: a docx whose declared decompressed size is comfortably
    // under maxBytes * ratio must pass. Without this, a ratio refactor that
    // accidentally lowers the cap to 1x would silently break every upload.
    expect(ZIP_BOMB_DECOMPRESSED_RATIO).toBeGreaterThanOrEqual(2);
    const docx = makeDocxBuffer({ withMacro: false });
    expect(inspectContainerThreats(docx, 1024 * 1024)).toBeNull();
  });
});

describe("buildUploadMiddleware — Task #272 container inspection", () => {
  it("rejects a zip bomb at the HTTP layer with 400 + UPLOAD_ZIP_BOMB", async () => {
    // Allow application/zip just for this test so we can attach a raw zip
    // without tripping the mime allow-list.
    const { app, onUploaded } = makeApp({
      maxBytes: 1024,
      allowedMimeTypes: ["application/zip"],
    });
    const bomb = makeZipBombBuffer(12 * 1024);
    const res = await request(app)
      .post("/upload")
      .attach("file", bomb, {
        filename: "bomb.zip",
        contentType: "application/zip",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_ZIP_BOMB",
      maxDecompressedBytes: 1024 * ZIP_BOMB_DECOMPRESSED_RATIO,
    });
    expect(res.body.decompressedBytes).toBeGreaterThan(
      1024 * ZIP_BOMB_DECOMPRESSED_RATIO,
    );
    // The route handler — which would have written the bomb to object
    // storage — must NEVER run.
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("rejects a macro-laden .docm at the HTTP layer with 400 + UPLOAD_OFFICE_MACRO", async () => {
    // The default allow-list lets through the wordprocessingml.document
    // mime that file-type detects from our fixture, so no override is
    // needed here. This is the exact attack the task is closing: a .docm
    // re-labelled as a plain .docx slipping past the mime allow-list.
    const { app, onUploaded } = makeApp();
    const docm = makeDocxBuffer({ withMacro: true });
    const res = await request(app)
      .post("/upload")
      .attach("file", docm, {
        filename: "expense-claim.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "UPLOAD_OFFICE_MACRO",
      format: "ooxml",
      evidence: "word/vbaProject.bin",
    });
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("accepts a clean .docx (positive control: legitimate Office uploads still work)", async () => {
    // Without this control we'd be one wrong refactor away from rejecting
    // every adviser document. The fixture contains no vbaProject.bin and
    // its declared decompressed size is well under the cap.
    const { app, onUploaded } = makeApp();
    const docx = makeDocxBuffer({ withMacro: false });
    const res = await request(app)
      .post("/upload")
      .attach("file", docx, {
        filename: "client-letter.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
});
