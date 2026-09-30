import { describe, expect, it } from "vitest";
import { DerivedSourceNotFoundError, ForkCutoffError } from "../domains/threads/index.js";
import { deriveConversationErrorStatus } from "./derive-conversation-route-errors.js";

describe("derive conversation route errors", () => {
  it("maps a missing or unowned source to not found", () => {
    expect(deriveConversationErrorStatus(new DerivedSourceNotFoundError())).toBe(404);
  });

  it("maps an unsettled prefix to conflict and other cutoff refusals to bad request", () => {
    expect(deriveConversationErrorStatus(new ForkCutoffError("unsettled_history", "turn"))).toBe(
      409,
    );
    expect(
      deriveConversationErrorStatus(new ForkCutoffError("turn_not_in_transcript", "turn")),
    ).toBe(400);
    expect(deriveConversationErrorStatus(new ForkCutoffError("turn_not_actionable", "turn"))).toBe(
      400,
    );
  });
});
