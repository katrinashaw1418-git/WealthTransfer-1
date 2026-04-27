import { describe, expect, it } from "vitest";
import { clientDisplayName } from "./display-name";

describe("clientDisplayName", () => {
  it("returns full name when both present", () => {
    expect(clientDisplayName({ firstName: "Jane", lastName: "Doe" }, 26)).toBe("Jane Doe");
  });

  it("uses first name only when last is missing", () => {
    expect(clientDisplayName({ firstName: "Alex", lastName: "" }, 1)).toBe("Alex");
  });

  it("uses last name only when first is missing", () => {
    expect(clientDisplayName({ firstName: null, lastName: "Smith" }, 2)).toBe("Smith");
  });

  it("falls back to email when name is blank", () => {
    expect(
      clientDisplayName({ firstName: "", lastName: "", email: "jane@example.com" }, 26),
    ).toBe("jane@example.com");
  });

  it("falls back to email when name fields are null", () => {
    expect(
      clientDisplayName({ firstName: null, lastName: null, email: "ghost@example.com" }, 99),
    ).toBe("ghost@example.com");
  });

  it("falls back to Client #<id> when both name and email are missing", () => {
    expect(clientDisplayName({ firstName: "", lastName: "", email: "" }, 26)).toBe("Client #26");
    expect(clientDisplayName({}, 5)).toBe("Client #5");
  });

  it("treats whitespace-only fields as missing", () => {
    expect(
      clientDisplayName({ firstName: "   ", lastName: "   ", email: "   " }, 9),
    ).toBe("Client #9");
  });

  it("does not mutate the input", () => {
    const input = { firstName: "Jane", lastName: "Doe", email: "jane@example.com" };
    const snapshot = { ...input };
    clientDisplayName(input, 1);
    expect(input).toEqual(snapshot);
  });
});
