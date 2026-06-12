// @ts-nocheck
import { describe, expect, it } from "vitest";

import { resolveComposerAgentMode } from "./composer-agent-mode";

describe("resolveComposerAgentMode", () => {
  it("freezes once the server thread exists even with zero turns", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: false,
        hasActiveThread: true,
        currentAgent: "general",
        turnCount: 0,
        localTurnCount: 0,
      }),
    ).toBe("readonly");
  });

  it("stays interactive for optimistic package-card threads before server confirm", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: true,
        hasActiveThread: true,
        currentAgent: null,
        turnCount: 0,
        localTurnCount: 0,
      }),
    ).toBe("interactive");
  });

  it("stays interactive for deferred workbench new-chat until first send", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: true,
        hasActiveThread: true,
        currentAgent: null,
        turnCount: 0,
        localTurnCount: 0,
      }),
    ).toBe("interactive");
  });

  it("freezes after server confirm even when currentAgent is still null", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: false,
        hasActiveThread: true,
        currentAgent: null,
        turnCount: 0,
        localTurnCount: 0,
      }),
    ).toBe("readonly");
  });

  it("freezes when local optimistic turns exist (Home handoff)", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: true,
        hasActiveThread: true,
        currentAgent: null,
        turnCount: 0,
        localTurnCount: 1,
      }),
    ).toBe("readonly");
  });

  it("freezes when the thread has turns regardless of placement", () => {
    expect(
      resolveComposerAgentMode({
        isPendingServerCreate: false,
        hasActiveThread: true,
        currentAgent: "general",
        turnCount: 3,
        localTurnCount: 0,
      }),
    ).toBe("readonly");
  });
});
