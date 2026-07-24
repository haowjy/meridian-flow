import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeConversationReveal,
  peekConversationReveal,
  registerConversationRevealNavigator,
  requestConversationReveal,
} from "./conversation-reveal";

afterEach(() => {
  const pending = peekConversationReveal();
  if (pending) completeConversationReveal(pending);
});

describe("conversation reveal handshake", () => {
  it("navigates immediately and clears only the matching request", () => {
    const navigate = vi.fn();
    const unregister = registerConversationRevealNavigator(navigate);
    const reveal = { threadId: "thread-1", turnId: "turn-1", changeId: "change-1" };
    requestConversationReveal(reveal);

    expect(navigate).toHaveBeenCalledWith("thread-1");
    completeConversationReveal({ ...reveal, changeId: "other" });
    expect(peekConversationReveal()).toEqual(reveal);
    completeConversationReveal(reveal);
    expect(peekConversationReveal()).toBeNull();
    unregister();
  });

  it("replays pending navigation when the project shell registers", () => {
    const reveal = { threadId: "thread-2", turnId: "turn-2", changeId: "change-2" };
    requestConversationReveal(reveal);
    const navigate = vi.fn();
    const unregister = registerConversationRevealNavigator(navigate);
    expect(navigate).toHaveBeenCalledWith("thread-2");
    unregister();
  });

  it("completes a thread-only reveal once navigation is dispatched", () => {
    const unregister = registerConversationRevealNavigator(vi.fn());
    requestConversationReveal({ threadId: "thread-3", turnId: null, changeId: "change-3" });
    expect(peekConversationReveal()).toBeNull();
    unregister();
  });
});
