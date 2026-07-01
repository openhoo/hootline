import { describe, expect, it } from "vitest";

import { isValidTicketIntake } from "./index";

describe("support contracts", () => {
  it("rejects malformed ticket intake payloads", () => {
    expect(
      isValidTicketIntake({
        id: "T-100",
        requesterEmail: "not-an-email",
        subject: "Login help",
      }),
    ).toBe(false);
  });
});
