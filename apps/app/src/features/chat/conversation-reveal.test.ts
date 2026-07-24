import { afterEach, describe, expect, it } from "vitest";
import {
  completeConversationReveal,
  peekConversationReveal,
  requestConversationReveal,
} from "./conversation-reveal";

afterEach(() => {
  const pending = peekConversationReveal();
  if (pending) completeConversationReveal(pending);
});

describe("conversation reveal handshake", () => {
  it("clears only the matching request", () => {
    const reveal = { threadId: "thread-1", turnId: "turn-1", changeId: "change-1" };
    requestConversationReveal(reveal);

    completeConversationReveal({ ...reveal, changeId: "other" });
    expect(peekConversationReveal()).toEqual(reveal);
    completeConversationReveal(reveal);
    expect(peekConversationReveal()).toBeNull();
  });
});
