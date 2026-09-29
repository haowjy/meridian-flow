import { describe, expect, it } from "vitest";
import { MAX_USER_MESSAGE_TEXT } from "../admission/user-turn-admission.js";
import { threadControlRequestSchema } from "./thread-control-request.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("thread control request", () => {
  it("trims instructions and treats empty text as absent", () => {
    expect(
      threadControlRequestSchema.parse({
        id,
        control: { kind: "compact", instructions: "  Keep rival promises.  " },
      }),
    ).toEqual({ id, control: { kind: "compact", instructions: "Keep rival promises." } });
    expect(
      threadControlRequestSchema.parse({
        id,
        control: { kind: "compact", instructions: "   " },
      }),
    ).toEqual({ id, control: { kind: "compact" } });
  });

  it("uses the writer-message text limit", () => {
    expect(
      threadControlRequestSchema.safeParse({
        id,
        control: { kind: "compact", instructions: "x".repeat(MAX_USER_MESSAGE_TEXT + 1) },
      }).success,
    ).toBe(false);
  });
});
