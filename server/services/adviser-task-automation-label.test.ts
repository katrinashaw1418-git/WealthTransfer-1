// =============================================================================
// Task #283 — adviser task labels never show "Client #<id>" when there's an
// email on file
// -----------------------------------------------------------------------------
// Locks in the label fallback contract for the adviser task automation
// (KYC follow-ups, fee consent renewals, portfolio reviews). Before this
// fix, KYC tasks rendered as "Follow up KYC for Client #26" whenever the
// linked client had blank firstName/lastName, even though the user had a
// usable email on file.
//
// The label helper is a pure function so this is a fast unit test — no
// DB fixture required.
// =============================================================================
import { describe, expect, it } from "vitest";
import { clientLabelForTask } from "./adviser-task-automation";

describe("clientLabelForTask — adviser task display label", () => {
  it("uses the full name when present", () => {
    expect(
      clientLabelForTask({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        clientUserId: 26,
      }),
    ).toBe("Jane Doe");
  });

  it("falls back to email when name is blank — does NOT render Client #<id>", () => {
    const label = clientLabelForTask({
      firstName: "",
      lastName: "",
      email: "linkclient@example.com",
      clientUserId: 26,
    });
    expect(label).toBe("linkclient@example.com");
    expect(label).not.toContain("Client #");
  });

  it("falls back to email when name fields are null", () => {
    expect(
      clientLabelForTask({
        firstName: null,
        lastName: null,
        email: "ghost@example.com",
        clientUserId: 99,
      }),
    ).toBe("ghost@example.com");
  });

  it("falls back to Client #<id> only when both name and email are missing", () => {
    expect(
      clientLabelForTask({
        firstName: "",
        lastName: "",
        email: "",
        clientUserId: 26,
      }),
    ).toBe("Client #26");
    expect(
      clientLabelForTask({
        firstName: null,
        lastName: null,
        email: null,
        clientUserId: 7,
      }),
    ).toBe("Client #7");
  });

  it("trims whitespace-only names so they don't masquerade as a real label", () => {
    expect(
      clientLabelForTask({
        firstName: "   ",
        lastName: "   ",
        email: "test@example.com",
        clientUserId: 5,
      }),
    ).toBe("test@example.com");
  });

  it("works with a first name only or a last name only", () => {
    expect(
      clientLabelForTask({
        firstName: "Alex",
        lastName: "",
        email: "alex@example.com",
        clientUserId: 1,
      }),
    ).toBe("Alex");
    expect(
      clientLabelForTask({
        firstName: null,
        lastName: "Smith",
        email: "smith@example.com",
        clientUserId: 2,
      }),
    ).toBe("Smith");
  });
});
