// =============================================================================
// Task #148 — admin route coverage drift catcher
// =============================================================================
// Audits, at every CI run, that EVERY `/api/admin/*` route registration is
// wrapped by an auth+role guard. This is the test the original task required
// to "catch future drift" — without it, a future contributor could add an
// admin endpoint and forget the wrapper, leaving an unauthenticated admin
// surface in production.
//
// Two invariants this file enforces:
//
//   1. Every `app.<method>("/api/admin/...", ...)` registration in
//      `server/admin-routes.ts` is wrapped by `adminRoute(`,
//      `feeReportingRoute(`, or another approved guard. The handler shape we
//      reject is "raw" express handlers like
//          app.get("/api/admin/foo", async (req, res) => { ... })
//      which would skip both auth and role checks.
//
//   2. NO `/api/admin/*` route appears OUTSIDE `server/admin-routes.ts`.
//      The only acceptable home for admin endpoints is the file with the
//      centralised wrapper helpers — splitting them across files is the
//      easiest way to forget a guard.
//
// Implementation: pure static analysis of the source files. We deliberately
// do NOT spin up the Express app or import the route module — that would
// pull in the database layer and slow the test down for no extra signal.
// The regex below matches the exact `app.METHOD("/api/admin..."` shape used
// throughout the codebase (multi-line registrations are the norm). Any new
// shape (e.g. registering routes via a router) would slip past this check;
// if/when such a pattern lands the test should be extended in the same PR.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Project uses ESM ("type": "module"), so __dirname is not defined; derive
// it from import.meta.url. Resolves to the directory holding this file.
const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Files that may legitimately contain HTTP route registrations. If a new
// route file is added, extend this list AND make sure any admin endpoints in
// it land in admin-routes.ts instead.
const ROUTE_FILES = [
  "admin-routes.ts",
  "routes.ts",
  "adviser-routes.ts",
  "client-routes.ts",
];

// The wrappers that satisfy the "auth + role" requirement. `adminRoute`
// requires role === 'admin'; `feeReportingRoute` allows admin OR
// compliance_admin (used by the read-only fee reporting endpoints);
// `adminStreamRoute` is the streaming variant of `adminRoute` for endpoints
// that must own the response body themselves (downloads, text/markdown).
// Any future wrapper that also enforces an admin-or-equivalent role MUST
// be listed here for the static check to recognise it.
const APPROVED_ADMIN_WRAPPERS = [
  "adminRoute",
  "feeReportingRoute",
  "adminStreamRoute",
];

// Match `app.get("/api/admin/...", <next-token>` and capture both the path
// and the next non-whitespace token after the path-string + comma.
// The `s` flag lets `.` cross newlines so multi-line registrations match.
const ADMIN_ROUTE_REGEX =
  /app\.(get|post|put|patch|delete)\(\s*"(\/api\/admin[^"]*)"\s*,\s*([A-Za-z_][\w$]*)/gs;

// Same pattern but matching ANY method/path that begins with "/api/admin"
// — used by the "no admin routes outside admin-routes.ts" sweep so we
// catch even oddly-shaped registrations (e.g. with middleware between the
// path and the wrapper, where capture group 3 might not be an identifier).
const ANY_ADMIN_PATH_REGEX =
  /app\.(?:get|post|put|patch|delete)\(\s*"(\/api\/admin[^"]*)"/g;

function readSource(file: string): string {
  return readFileSync(path.join(SERVER_ROOT, file), "utf8");
}

describe("admin route coverage", () => {
  it("wraps every /api/admin/* route in admin-routes.ts with an approved auth+role guard", () => {
    const source = readSource("admin-routes.ts");

    const findings: Array<{ method: string; path: string; wrapper: string }> = [];
    for (const m of source.matchAll(ADMIN_ROUTE_REGEX)) {
      findings.push({ method: m[1], path: m[2], wrapper: m[3] });
    }

    // Sanity: the file must contain at least one admin route — otherwise the
    // regex has silently broken and we'd be vacuously passing.
    expect(findings.length).toBeGreaterThan(0);

    const ungated = findings.filter(
      (f) => !APPROVED_ADMIN_WRAPPERS.includes(f.wrapper),
    );
    expect(
      ungated,
      `Found admin route(s) NOT wrapped by ${APPROVED_ADMIN_WRAPPERS.join(
        " or ",
      )}:\n` +
        ungated
          .map((f) => `  - ${f.method.toUpperCase()} ${f.path} → ${f.wrapper}`)
          .join("\n") +
        "\n\nEvery /api/admin/* route MUST be wrapped by an auth+role guard.",
    ).toEqual([]);
  });

  it("never registers /api/admin/* routes outside server/admin-routes.ts", () => {
    const offenders: Array<{ file: string; path: string }> = [];
    for (const file of ROUTE_FILES) {
      if (file === "admin-routes.ts") continue;
      const source = readSource(file);
      for (const m of source.matchAll(ANY_ADMIN_PATH_REGEX)) {
        offenders.push({ file, path: m[1] });
      }
    }
    expect(
      offenders,
      "Found /api/admin/* route(s) defined OUTSIDE server/admin-routes.ts:\n" +
        offenders.map((o) => `  - ${o.file}: ${o.path}`).join("\n") +
        "\n\nMove these into server/admin-routes.ts so the centralised " +
        "auth+role wrappers apply.",
    ).toEqual([]);
  });
});
