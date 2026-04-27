// Shared client display-name helper. Resolution: name -> email -> Client #<id>.
// Used by server task generation, adviser-access notifications, and adviser UI.

export interface DisplayNameInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

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
