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

export {};
