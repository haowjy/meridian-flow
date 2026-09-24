// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindChatSubmissions, readChatSubmissions } from "@/client/chat-submissions";
import type { ThreadStoreActions } from "@/client/stores";
import { inflightChatHref, type SendProjectChatArgs, sendProjectChat } from "./send-project-chat";

vi.mock("./thread-title", () => ({
  deriveTitleFromMessage: (text: string) => text.trim().slice(0, 40),
}));

const ACCOUNT = "account";

const agent = {
  name: "General",
  slug: "general",
  selection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
};

function actions(): ThreadStoreActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureThread: vi.fn(() => calls.push("ensureThread")),
    markPendingCreation: vi.fn(() => calls.push("markPendingCreation")),
    markHandoffPending: vi.fn(() => calls.push("markHandoffPending")),
    appendUserTurn: vi.fn(() => {
      calls.push("appendUserTurn");
      return { id: "turn_local_1" };
    }),
    ensureAssistantTurn: vi.fn(() => calls.push("ensureAssistantTurn")),
    markPendingStream: vi.fn(() => calls.push("markPendingStream")),
  } as unknown as ThreadStoreActions & { calls: string[] };
}

function send(overrides: Partial<Omit<SendProjectChatArgs, "threadActions" | "replace">> = {}): {
  result: ReturnType<typeof sendProjectChat>;
  threadActions: ThreadStoreActions & { calls: string[] };
  replace: Mock<(href: string) => void>;
} {
  const threadActions = actions();
  const replace = vi.fn<(href: string) => void>();
  const result = sendProjectChat({
    accountId: ACCOUNT,
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    text: "Draft the fight scene tonight",
    submissionId: "sub-1",
    agent,
    workId: null,
    ...overrides,
    threadActions,
    replace,
  });
  return { result, threadActions, replace };
}

beforeEach(() => {
  window.localStorage.clear();
  bindChatSubmissions(ACCOUNT);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("sendProjectChat", () => {
  it("mints a uuid, writes local state, and replaces before persist", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(uuid)
      .mockReturnValue("11111111-1111-4111-8111-111111111111");

    const { result, threadActions, replace } = send();

    expect(result?.threadId).toBe(uuid);
    expect(replace).toHaveBeenCalledWith(`/p/550e8400-e29b-41d4-a716-446655440000/chat/${uuid}`);
    expect(threadActions.calls).toEqual([
      "ensureThread",
      "markPendingCreation",
      "markHandoffPending",
      "appendUserTurn",
      "ensureAssistantTurn",
      "markPendingStream",
    ]);
    expect(replace.mock.invocationCallOrder[0]).toBeGreaterThan(
      (threadActions.markPendingStream as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    // Durable witness exists for the identity we just navigated to.
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ kind: "first-send", submissionId: "sub-1", threadId: uuid }),
    ]);
  });

  it("skips navigation on follow-up send", () => {
    const { threadActions, replace } = send({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      text: "Continue",
      submissionId: "sub-2",
    });
    expect(replace).not.toHaveBeenCalled();
    expect(threadActions.ensureThread).not.toHaveBeenCalled();
    expect(threadActions.markPendingStream).not.toHaveBeenCalled();
  });

  it("does not display, dispatch, or navigate when the durable record fails", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    try {
      const { result, threadActions, replace } = send();

      expect(result).toBeNull();
      expect(replace).not.toHaveBeenCalled();
      expect(threadActions.calls).toEqual([]);
      expect(setItem).toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("builds a uuid chat address", () => {
    expect(
      inflightChatHref(
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("/p/550e8400-e29b-41d4-a716-446655440000/chat/550e8400-e29b-41d4-a716-446655440000");
  });
});
