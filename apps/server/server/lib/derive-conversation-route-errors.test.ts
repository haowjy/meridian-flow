import { describe, expect, it } from "vitest";
import { DerivedSourceNotFoundError } from "../domains/threads/index.js";
import { deriveConversationErrorStatus } from "./derive-conversation-route-errors.js";

describe("derive conversation route errors", () => {
  it("maps a missing or unowned source to not found", () => {
    expect(deriveConversationErrorStatus(new DerivedSourceNotFoundError())).toBe(404);
  });
});
