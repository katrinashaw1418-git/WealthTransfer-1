// =============================================================================
// Task #283 — shared client display-name helper
// -----------------------------------------------------------------------------
// Single source of truth for resolving a client's display name across the
// adviser portal (server task generation + every client-side adviser
// page). Resolution chain:
//
//   1. trimmed `${firstName} ${lastName}`  if non-empty
//   2. email                                 if non-empty
//   3. `Client #${id}`                       (always present as a last resort)
//
// Why a shared module:
//   - Before this helper, the server task automation, the
//     adviser-access notification map, and a dozen adviser UI pages each
//     had their own inline expression — and several rendered
//     `${firstName} ${lastName}` directly without any fallback, so blank
//     placeholder names leaked through as empty labels.
//   - Lives under `shared/` so both `@shared/display-name` (frontend)
//     and `import { ... } from "@shared/display-name"` (server) hit
//     the same code path.
//   - Pure function, no I/O, easy to unit-test in isolation.
//
// HARD RULE: never mutate the input. Callers may pass live React props
// or DB row objects; this helper must be safe to call from a render.
// =============================================================================

export interface DisplayNameInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

/**
 * Resolve a human-readable display label for a client-like object.
 * See file header for the resolution chain.
 *
 * @param input  Object with optional firstName/lastName/email fields.
 * @param idForFallback  The numeric id to use in the `Client #<id>`
 *   last-resort fallback. Required so the fallback is always actionable.
 */
export function clientDisplayName(
  input: DisplayNameInput,
  idForFallback: number,
): string {
  const fullName = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();
  if (fullName) return fullName;
  const email = input.email?.trim();
  if (email) return email;
  return `Client #${idForFallback}`;
}
