import type { Thread } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { resolveChatThreadId } from "./chat-thread-resolution";

function thread(id: string, kind: Thread["kind"] = "primary"): Thread {
  return { id, kind, deletedAt: null } as Thread;
}

const projectThreads = [thread("first"), thread("remembered"), thread("explicit")];

describe("chat thread resolution", () => {
  it("prefers a valid explicit thread over every fallback", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: "explicit",
        pendingThreadId: "pending",
        rememberedThreadId: "remembered",
        projectThreads,
      }),
    ).toBe("explicit");
  });

  it("prefers a pending optimistic thread over the remembered thread", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: "pending",
        rememberedThreadId: "remembered",
        projectThreads,
      }),
    ).toBe("pending");
  });

  it("uses a valid remembered thread before the first project thread", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        rememberedThreadId: "remembered",
        projectThreads,
      }),
    ).toBe("remembered");
  });

  it("falls through unknown explicit and remembered ids", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: "deleted-explicit",
        pendingThreadId: null,
        rememberedThreadId: "deleted-remembered",
        projectThreads,
      }),
    ).toBe("first");
  });

  it("falls through a remembered soft-deleted thread", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        rememberedThreadId: "deleted",
        projectThreads: [
          { ...thread("deleted"), deletedAt: "2026-07-17T00:00:00.000Z" },
          thread("first"),
        ],
      }),
    ).toBe("first");
  });

  it("prefers a primary thread for the list fallback and otherwise uses the first", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        rememberedThreadId: null,
        projectThreads: [thread("subagent", "subagent"), thread("primary")],
      }),
    ).toBe("primary");
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        rememberedThreadId: null,
        projectThreads: [thread("subagent", "subagent")],
      }),
    ).toBe("subagent");
  });

  it("returns null when no rung resolves", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        rememberedThreadId: null,
        projectThreads: [],
      }),
    ).toBeNull();
  });
});
