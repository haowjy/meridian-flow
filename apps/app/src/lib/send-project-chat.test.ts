import { describe, expect, it, vi } from "vitest";
import type { ThreadStoreActions } from "@/client/stores";
import { inflightChatHref, sendProjectChat } from "./send-project-chat";

vi.mock("./thread-title", () => ({
  deriveTitleFromMessage: (text: string) => text.trim().slice(0, 40),
}));

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

describe("sendProjectChat", () => {
  it("mints a uuid, writes local state, and replaces before persist", () => {
    const threadActions = actions();
    const replace = vi.fn();
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(uuid)
      .mockReturnValue("11111111-1111-4111-8111-111111111111");

    const result = sendProjectChat({
      accountId: "account",
      projectId: "project-1",
      projectSlug: "serial",
      text: "Draft the fight scene tonight",
      submissionId: "sub-1",
      agent,
      workId: null,
      threadActions,
      replace,
    });

    expect(result.threadId).toBe(uuid);
    expect(replace).toHaveBeenCalledWith(`/p/serial/chat/${uuid}`);
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
  });

  it("skips navigation on follow-up send", () => {
    const threadActions = actions();
    const replace = vi.fn();
    sendProjectChat({
      accountId: "account",
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      projectId: "project-1",
      projectSlug: "serial",
      text: "Continue",
      submissionId: "sub-2",
      agent,
      workId: null,
      threadActions,
      replace,
    });
    expect(replace).not.toHaveBeenCalled();
    expect(threadActions.ensureThread).not.toHaveBeenCalled();
    expect(threadActions.markPendingStream).not.toHaveBeenCalled();
  });

  it("builds a uuid chat address", () => {
    expect(inflightChatHref("serial", "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/p/serial/chat/550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
