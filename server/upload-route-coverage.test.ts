// =============================================================================
// Task #162 — upload route coverage drift catcher
// =============================================================================
// Audits, at every CI run, that the only place in the server folder that
// imports `multer` directly is the centralised factory at
// `server/services/upload-security.ts`. Every other multipart upload route
// MUST go through `buildUploadMiddleware()` so the size cap, mime allow-list,
// and structured 400 rejection contract apply uniformly.
//
// The original Task #148 hardened a single adviser route. Without a static
// check, a future contributor could drop a raw `multer({ ... })` call into a
// new endpoint and silently re-open the surface area we just closed (large
// payloads landing in object storage, executable mime types accepted, etc.).
// This sibling test — modelled on `admin-routes-coverage.test.ts` — fails
// fast in CI when that happens, with a message pointing the contributor at
// `buildUploadMiddleware`.
//
// Implementation: pure static analysis. We walk `server/` for every `.ts`
// file (excluding `node_modules` and `.local`), then look for any of the
// canonical multer import shapes:
//   * `import ... from "multer"`
//   * `import("multer")`
//   * `require("multer")`
// The single permitted file is `server/services/upload-security.ts`. Test
// files are excluded from the sweep — they may legitimately stub multer
// against the factory's own contract.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));

// The ONLY file allowed to import multer directly. Anything else must go
// through `buildUploadMiddleware()` from this module.
const ALLOWED_MULTER_IMPORTERS = new Set<string>([
  path.join("services", "upload-security.ts"),
]);

// Canonical import shapes we forbid outside the allow-list. We deliberately
// match all three so `import multer from "multer"`, dynamic
// `await import("multer")`, and CJS `require("multer")` are all caught.
const MULTER_IMPORT_REGEX =
  /(?:from\s+["']multer["'])|(?:import\(\s*["']multer["']\s*\))|(?:require\(\s*["']multer["']\s*\))/;

function walkTsFiles(root: string, rel = ""): string[] {
  const here = path.join(root, rel);
  const out: string[] = [];
  for (const entry of readdirSync(here)) {
    // Skip dependency + tooling caches; they may bundle multer themselves
    // and are not source we own.
    if (entry === "node_modules" || entry === ".local" || entry === "dist") {
      continue;
    }
    const abs = path.join(here, entry);
    const childRel = rel ? path.join(rel, entry) : entry;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(root, childRel));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Test files may stub or import multer for coverage of the factory; do
    // not police them here. The .test.ts convention is project-wide.
    if (entry.endsWith(".test.ts")) continue;
    out.push(childRel);
  }
  return out;
}

describe("upload route coverage", () => {
  it("only `server/services/upload-security.ts` may import multer directly", () => {
    const files = walkTsFiles(SERVER_ROOT);

    // Sanity: the walk must find SOMETHING — otherwise the directory layout
    // changed underneath us and we'd be vacuously passing.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rel of files) {
      if (ALLOWED_MULTER_IMPORTERS.has(rel)) continue;
      const source = readFileSync(path.join(SERVER_ROOT, rel), "utf8");
      if (MULTER_IMPORT_REGEX.test(source)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      "Found file(s) importing `multer` directly outside the centralised " +
        "factory:\n" +
        offenders.map((f) => `  - server/${f}`).join("\n") +
        "\n\nUpload routes MUST go through `buildUploadMiddleware()` from " +
        "`server/services/upload-security.ts` so the size cap, mime " +
        "allow-list, and structured 400 rejection contract are applied " +
        "uniformly. If a new upload route legitimately needs raw multer " +
        "(it almost certainly does not), extend the factory instead and " +
        "add a justification + the file path to `ALLOWED_MULTER_IMPORTERS` " +
        "in this test.",
    ).toEqual([]);

    // Sanity: the allow-listed file MUST actually still import multer —
    // otherwise the factory has been deleted and every upload route in the
    // codebase is now unguarded.
    const factorySrc = readFileSync(
      path.join(SERVER_ROOT, "services", "upload-security.ts"),
      "utf8",
    );
    expect(MULTER_IMPORT_REGEX.test(factorySrc)).toBe(true);
  });
});
