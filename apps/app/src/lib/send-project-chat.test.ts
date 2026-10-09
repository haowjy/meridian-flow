// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindChatSubmissions } from "@/client/chat-submissions";
import type { ThreadStoreActions } from "@/client/stores";
import { type SendProjectChatArgs, sendProjectChat } from "./send-project-chat";

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
    turns: vi.fn(() => []),
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

function send(overrides: Partial<Omit<SendProjectChatArgs, "threadActions" | "selectChat">> = {}): {
  result: ReturnType<typeof sendProjectChat>;
  threadActions: ThreadStoreActions & { calls: string[] };
  selectChat: Mock<(href: string) => void>;
} {
  const threadActions = actions();
  const selectChat = vi.fn<(href: string) => void>();
  const result = sendProjectChat({
    accountId: ACCOUNT,
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    text: "Draft the fight scene tonight",
    blocks: [{ type: "text", text: "Draft the fight scene tonight" }],
    references: [],
    submissionId: "sub-1",
    agent,
    workId: "no-work",
    ...overrides,
    threadActions,
    selectChat,
  });
  return { result, threadActions, selectChat };
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
  it("does not display, dispatch, or navigate when the durable record fails", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    try {
      const { result, threadActions, selectChat } = send();

      expect(result).toBeNull();
      expect(selectChat).not.toHaveBeenCalled();
      expect(threadActions.calls).toEqual([]);
      expect(setItem).toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});
