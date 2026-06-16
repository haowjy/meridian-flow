import type { Thread } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import { resolveChatThreadId } from "./chat-thread-resolution";

const projectId = "00000000-0000-4000-8000-000000000000";

function thread(id: string, kind: Thread["kind"] = "primary"): Thread {
  return {
    id,
    projectId,
    workId: null,
    userId: "user_1",
    kind,
    status: "idle",
    title: id,
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: kind === "subagent" ? 1 : 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("resolveChatThreadId", () => {
  it("prefers URL selection over local fallbacks", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: "url-thread",
        pendingThreadId: "pending-thread",
        projectThreads: [thread("project-thread")],
      }),
    ).toBe("url-thread");
  });

  it("uses the pending optimistic thread before fetched project threads", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: "pending-thread",
        projectThreads: [thread("project-thread")],
      }),
    ).toBe("pending-thread");
  });

  it("falls back to the first primary project thread", () => {
    expect(
      resolveChatThreadId({
        explicitThreadId: null,
        pendingThreadId: null,
        projectThreads: [thread("sub", "subagent"), thread("primary")],
      }),
    ).toBe("primary");
  });
});
