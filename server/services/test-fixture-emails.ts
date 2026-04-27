// =============================================================================
// TEST-FIXTURE EMAIL DETECTION
// -----------------------------------------------------------------------------
// Single source of truth for "does this email belong to an automated test
// fixture?". Adviser-facing read paths import this helper and drop fixture
// clients from any list a real adviser would otherwise see — defence in depth
// against fixture leaks like the one in Task #286 (the Top Clients table
// surfacing rows like `adviser-race-...@example.com` to a real adviser).
//
// Adding a new fixture pattern? Add it here once and every adviser surface
// inherits the protection.
//
// The helper is exported so cleanup scripts (e.g.
// scripts/deactivate-fixture-adviser-client-links.ts) can reuse the exact
// same matcher the read path uses — no risk of the script and the live
// filter drifting out of sync.
// =============================================================================

const FIXTURE_LOCAL_SUBSTRINGS = [
  "__prelaunch_",
  "__feegate_",
  "__txsafety_",
] as const;

const FIXTURE_LOCAL_PREFIXES = [
  "adviser-race-",
  "adviser-ok-",
  "okadv-",
] as const;

const FIXTURE_DOMAIN_SUFFIXES = ["@example.com"] as const;

export interface FixtureEmailMatch {
  matched: true;
  pattern: string;
}

export interface FixtureEmailMiss {
  matched: false;
}

export type FixtureEmailMatchResult = FixtureEmailMatch | FixtureEmailMiss;

/**
 * Check whether an email looks like an automated test fixture. Matches:
 *   - any address ending in `@example.com`
 *   - any local-part containing `__prelaunch_`, `__feegate_`, `__txsafety_`
 *   - any local-part starting with `adviser-race-`, `adviser-ok-`, `okadv-`
 *
 * Comparison is case-insensitive and tolerant of leading/trailing whitespace.
 * Returns false for null/undefined/empty.
 */
export function isTestFixtureEmail(email: string | null | undefined): boolean {
  return matchTestFixtureEmail(email).matched;
}

/**
 * Like {@link isTestFixtureEmail} but also returns which pattern matched, so
 * callers can include the pattern name in structured warnings without
 * recomputing the match.
 */
export function matchTestFixtureEmail(
  email: string | null | undefined,
): FixtureEmailMatchResult {
  if (!email) return { matched: false };
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return { matched: false };

  for (const suffix of FIXTURE_DOMAIN_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return { matched: true, pattern: `domain:${suffix}` };
    }
  }

  const at = trimmed.lastIndexOf("@");
  const local = at >= 0 ? trimmed.slice(0, at) : trimmed;

  for (const sub of FIXTURE_LOCAL_SUBSTRINGS) {
    if (local.includes(sub)) {
      return { matched: true, pattern: `local-substring:${sub}` };
    }
  }

  for (const pre of FIXTURE_LOCAL_PREFIXES) {
    if (local.startsWith(pre)) {
      return { matched: true, pattern: `local-prefix:${pre}` };
    }
  }

  return { matched: false };
}
