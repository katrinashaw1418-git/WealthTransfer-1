// =============================================================================
// Task #283 — pin the contract on the shared display-name helper
// -----------------------------------------------------------------------------
// The helper is consumed by the server task automation, the
// adviser-access notification builder, and every adviser UI page that
// renders a client name. Anything other than "name -> email -> Client #id"
// is a regression — pin it here.
// =============================================================================
import { describe, expect, it } from "vitest";
import { clientDisplayName } from "./display-name";

describe("clientDisplayName", () => {
  it("returns the trimmed full name when both first and last are present", () => {
    expect(
      clientDisplayName({ firstName: "Jane", lastName: "Doe" }, 26),
    ).toBe("Jane Doe");
  });

  it("uses just the first name when last is missing", () => {
    expect(
      clientDisplayName({ firstName: "Alex", lastName: "" }, 1),
    ).toBe("Alex");
  });

  it("uses just the last name when first is missing", () => {
    expect(
      clientDisplayName({ firstName: null, lastName: "Smith" }, 2),
    ).toBe("Smith");
  });

  it("falls back to email when name is blank", () => {
    expect(
      clientDisplayName(
        { firstName: "", lastName: "", email: "jane@example.com" },
        26,
      ),
    ).toBe("jane@example.com");
  });

  it("falls back to email when name fields are null", () => {
    expect(
      clientDisplayName(
        { firstName: null, lastName: null, email: "ghost@example.com" },
        99,
      ),
    ).toBe("ghost@example.com");
  });

  it("falls back to Client #<id> only when both name and email are missing", () => {
    expect(
      clientDisplayName(
        { firstName: "", lastName: "", email: "" },
        26,
      ),
    ).toBe("Client #26");
    expect(
      clientDisplayName({ firstName: null, lastName: null, email: null }, 7),
    ).toBe("Client #7");
    expect(clientDisplayName({}, 5)).toBe("Client #5");
  });

  it("treats whitespace-only names and emails as missing", () => {
    expect(
      clientDisplayName(
        { firstName: "   ", lastName: "   ", email: "   " },
        9,
      ),
    ).toBe("Client #9");
  });

  it("does not mutate the input object", () => {
    const input = { firstName: "Jane", lastName: "Doe", email: "jane@example.com" };
    const snapshot = { ...input };
    clientDisplayName(input, 1);
    expect(input).toEqual(snapshot);
  });
});
