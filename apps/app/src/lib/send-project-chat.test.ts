// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindChatSubmissions, readChatSubmissions } from "@/client/chat-submissions";
import { DeviceChatSubmissionJournal } from "@/client/chat-submissions/store";
import type { ThreadStoreActions } from "@/client/stores";
import { WorkingSetSyncDriver } from "@/client/working-set/driver";
import { DeviceWorkingSetStore } from "@/client/working-set/store";
import {
  rehydrateFirstSendSubmission,
  type SendProjectChatArgs,
  sendProjectChat,
} from "./send-project-chat";

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
    submissionId: "sub-1",
    agent,
    workId: null,
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
  it("mints a uuid, writes local state, and selectChats before persist", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(uuid)
      .mockReturnValue("11111111-1111-4111-8111-111111111111");

    const { result, threadActions, selectChat } = send();

    expect(result?.threadId).toBe(uuid);
    expect(selectChat).toHaveBeenCalledWith(uuid);
    expect(threadActions.calls).toEqual([
      "ensureThread",
      "markPendingCreation",
      "markHandoffPending",
      "appendUserTurn",
      "ensureAssistantTurn",
      "markPendingStream",
    ]);
    expect(selectChat.mock.invocationCallOrder[0]).toBeGreaterThan(
      (threadActions.markPendingStream as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    // Durable witness exists for the identity we just navigated to.
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ kind: "first-send", submissionId: "sub-1", threadId: uuid }),
    ]);
  });

  it("skips navigation on follow-up send", () => {
    const { threadActions, selectChat } = send({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      text: "Continue",
      submissionId: "sub-2",
    });
    expect(selectChat).not.toHaveBeenCalled();
    expect(threadActions.ensureThread).not.toHaveBeenCalled();
    expect(threadActions.markPendingStream).not.toHaveBeenCalled();
  });

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

  it("recovers a dock first send after reload without a URL chat identity", () => {
    const projectId = "550e8400-e29b-41d4-a716-446655440000";
    const store = new DeviceWorkingSetStore(window.localStorage);
    const driver = new WorkingSetSyncDriver(store, vi.fn());
    driver.configure(ACCOUNT, false);
    window.history.replaceState({}, "", `/p/${projectId}/editor`);
    const result = sendProjectChat({
      accountId: ACCOUNT,
      projectId,
      text: "Keep this first send",
      submissionId: "dock-reload",
      agent,
      workId: null,
      threadActions: actions(),
      selectChat: (threadId) => driver.setCurrentChat(projectId, { kind: "thread", threadId }),
    });
    expect(window.location.pathname).toBe(`/p/${projectId}/editor`);
    const reloadedStore = new DeviceWorkingSetStore(window.localStorage);
    reloadedStore.setUser(ACCOUNT);
    const currentId = reloadedStore.read(projectId)?.snapshot.lastThreadId;
    expect(currentId).toBe(result?.threadId);
    const reloadedJournal = new DeviceChatSubmissionJournal(window.localStorage);
    reloadedJournal.setUser(ACCOUNT);
    const intent = reloadedJournal.entries().find((entry) => entry.threadId === currentId);
    if (intent?.kind !== "first-send") throw new Error("First-send intent was lost");
    const recovery = rehydrateFirstSendSubmission(intent, actions(), ACCOUNT);
    expect(recovery).toMatchObject({
      text: "Keep this first send",
      submissionId: "dock-reload",
      projectId,
    });
  });
});
