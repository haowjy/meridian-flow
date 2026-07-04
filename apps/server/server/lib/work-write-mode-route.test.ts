import { describe, expect, it, vi } from "vitest";
import { handleWorkWriteModeRequest } from "./work-write-mode-route.js";

const projectId = "project-1";
const workId = "work-1" as never;
const userId = "user-1" as never;

function deps(options: { mode?: "direct" | "draft"; activeDraftCount?: number } = {}) {
  const work = {
    id: workId,
    createdByUserId: userId,
    aiWriteMode: options.mode ?? "direct",
  };
  return {
    work,
    services: {
      works: {
        findById: vi.fn(async () => work),
        updateWriteMode: vi.fn(async (_id, aiWriteMode) => {
          work.aiWriteMode = aiWriteMode;
        }),
      },
      drafts: {
        listActiveDraftsByWork: vi.fn(async () =>
          Array.from({ length: options.activeDraftCount ?? 0 }, (_, index) => ({ index })),
        ),
      },
    },
  };
}

describe("handleWorkWriteModeRequest", () => {
  it("allows switching to draft even with active drafts", async () => {
    const state = deps({ mode: "direct", activeDraftCount: 1 });
    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "draft",
      }),
    ).resolves.toEqual({ aiWriteMode: "draft", status: "updated" });
    expect(state.work.aiWriteMode).toBe("draft");
  });

  it("rejects switching to direct while active drafts exist", async () => {
    const state = deps({ mode: "draft", activeDraftCount: 2 });
    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "direct",
      }),
    ).resolves.toEqual({
      aiWriteMode: "draft",
      status: "rejected",
      reason: "active_drafts",
      activeDraftCount: 2,
    });
    expect(state.services.works.updateWriteMode).not.toHaveBeenCalled();
  });

  it("allows switching to direct after drafts are gone", async () => {
    const state = deps({ mode: "draft", activeDraftCount: 0 });
    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "direct",
      }),
    ).resolves.toEqual({ aiWriteMode: "direct", status: "updated" });
    expect(state.work.aiWriteMode).toBe("direct");
  });
});
