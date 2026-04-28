// Shared test-env bootstrap. Imported as the FIRST line of any tsx
// verification script that touches `server/auth.ts` (which throws at
// module-init when JWT_SECRET is unset and isLocalDev is false).
//
// ESM hoists static imports above all body code in the same file, so a
// script that wants to set process.env.JWT_SECRET BEFORE downstream
// imports of server/auth.ts must do it in a side-effect import — this
// module is exactly that.
//
// `dotenv/config` populates env from .env first; the `||=` defaults are
// a safety belt for environments where .env is absent.
import "dotenv/config";

process.env.NODE_ENV ||= "test";
process.env.JWT_SECRET ||= "test-jwt-secret";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET not loaded");
}

// TASK #366 — Hard guard against fixture / seed insertion in production.
// Every `scripts/test-*.ts` and the pre-launch / leak-gate scripts import
// THIS bootstrap as their first side-effect import, so refusing here
// short-circuits the script before any insertion path runs.
//
// The check runs AFTER the `NODE_ENV ||= "test"` default above, so a
// developer running `npx tsx scripts/test-foo.ts` with no env at all is
// still allowed (NODE_ENV becomes "test"). It refuses if NODE_ENV was
// explicitly set to "production" before the script started, OR if
// NODE_ENV is "development" without the local-dev signal that the auth
// layer also requires (mirrors `isLocalDev` in `server/auth.ts`).
import { assertFixtureInsertionAllowed } from "../server/services/fixture-data-guard";
assertFixtureInsertionAllowed("scripts/_bootstrap-test-env.ts");

export {};
