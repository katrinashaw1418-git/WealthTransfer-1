// =============================================================================
// Task #471 — Backwards-compat shim.
// -----------------------------------------------------------------------------
// The Gate-A banner was renamed to `DeductionsDisabledBanner` (Task #471) so
// it matches the canonical name used by the new compliance vocabulary work
// and so future surfaces can drop it inline. This file remains so any older
// import paths (e.g. `@/components/deduction-execution-banner`) keep working
// without a sweep across the codebase. Prefer importing
// `@/components/deductions-disabled-banner` in new code.
// =============================================================================

export { default } from "./deductions-disabled-banner";
