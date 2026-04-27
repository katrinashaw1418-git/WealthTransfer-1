import { describe, expect, it } from "vitest";
import { clientLabelForTask } from "./adviser-task-automation";

describe("clientLabelForTask", () => {
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

  it("falls back to email when name is blank", () => {
    const label = clientLabelForTask({
      firstName: "",
      lastName: "",
      email: "linkclient@example.com",
      clientUserId: 26,
    });
    expect(label).toBe("linkclient@example.com");
    expect(label).not.toContain("Client #");
  });

  it("falls back to email when name is null", () => {
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
      clientLabelForTask({ firstName: "", lastName: "", email: "", clientUserId: 26 }),
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

  it("trims whitespace-only names", () => {
    expect(
      clientLabelForTask({
        firstName: "   ",
        lastName: "   ",
        email: "test@example.com",
        clientUserId: 5,
      }),
    ).toBe("test@example.com");
  });

  it("works with a partial name", () => {
    expect(
      clientLabelForTask({
        firstName: "Alex",
        lastName: "",
        email: "alex@example.com",
        clientUserId: 1,
      }),
    ).toBe("Alex");
  });
});
