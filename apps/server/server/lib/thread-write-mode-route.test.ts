import type { AiWriteMode } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { handleThreadWriteModeRequest } from "./thread-write-mode-route.js";

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
}));

const threadId = "thread-1";
const userId = "user-1";

describe("handleThreadWriteModeRequest", () => {
  it("switches a thread to draft mode", async () => {
    const state = makeThreadState({ aiWriteMode: "direct", activeDraftCount: 1 });

    await expect(
      handleThreadWriteModeRequest(state.deps, { threadId, userId, aiWriteMode: "draft" }),
    ).resolves.toEqual({ aiWriteMode: "draft" });

    expect(state.thread.aiWriteMode).toBe("draft");
  });

  it("blocks direct mode while the thread still has active drafts", async () => {
    const state = makeThreadState({ aiWriteMode: "draft", activeDraftCount: 1 });

    await expect(
      handleThreadWriteModeRequest(state.deps, { threadId, userId, aiWriteMode: "direct" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(state.thread.aiWriteMode).toBe("draft");
  });

  it("switches to direct mode after drafts are resolved", async () => {
    const state = makeThreadState({ aiWriteMode: "draft", activeDraftCount: 0 });

    await expect(
      handleThreadWriteModeRequest(state.deps, { threadId, userId, aiWriteMode: "direct" }),
    ).resolves.toEqual({ aiWriteMode: "direct" });

    expect(state.thread.aiWriteMode).toBe("direct");
  });

  it("hides threads owned by another user", async () => {
    const state = makeThreadState({ ownerId: "user-2", aiWriteMode: "direct" });

    await expect(
      handleThreadWriteModeRequest(state.deps, { threadId, userId, aiWriteMode: "draft" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(state.thread.aiWriteMode).toBe("direct");
  });

  it("rejects unknown write modes", async () => {
    const state = makeThreadState({ aiWriteMode: "direct" });

    await expect(
      handleThreadWriteModeRequest(state.deps, { threadId, userId, aiWriteMode: "automatic" }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(state.thread.aiWriteMode).toBe("direct");
  });
});

function makeThreadState(options: {
  ownerId?: string;
  aiWriteMode: AiWriteMode;
  activeDraftCount?: number;
}) {
  const thread = {
    id: threadId,
    userId: options.ownerId ?? userId,
    projectId: "project-1",
    aiWriteMode: options.aiWriteMode,
  };
  return {
    thread,
    deps: {
      threads: {
        findById: vi.fn(async () => thread),
        updateWriteMode: vi.fn(async (_id: string, aiWriteMode: AiWriteMode) => {
          thread.aiWriteMode = aiWriteMode;
        }),
      },
      drafts: {
        listActiveDrafts: vi.fn(async () =>
          Array.from({ length: options.activeDraftCount ?? 0 }, (_, index) => ({
            id: `draft-${index}`,
          })),
        ),
      },
    },
  };
}
