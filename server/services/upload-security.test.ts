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
  resolveAllowedMimeTypes,
  resolveMaxUploadBytes,
} from "./upload-security";

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
    const body = Buffer.from("%PDF-1.4 tiny");
    const res = await request(app)
      .post("/upload")
      .attach("file", body, {
        filename: "ok.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mimeType: "application/pdf",
      sizeBytes: body.length,
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
      .attach("file", Buffer.from("%PDF tiny"), {
        filename: "ok.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UPLOAD_MIME_REJECTED");
    expect(res.body.allowedMimeTypes).toEqual(["image/png"]);
    expect(onUploaded).not.toHaveBeenCalled();
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
