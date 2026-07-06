import { describe, expect, it, vi } from "vitest";
import { handleWorkWriteModeRequest } from "./work-write-mode-route.js";

const projectId = "project-1";
const workId = "work-1" as never;
const userId = "user-1" as never;

function deps(options: { mode?: "direct" | "draft" } = {}) {
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
      },
      branchPush: {
        setWorkPushPolicy: vi.fn(async (): Promise<unknown> => ({ status: "updated" })),
      },
    },
  };
}

describe("handleWorkWriteModeRequest", () => {
  it("switches to draft/manual policy", async () => {
    const state = deps({ mode: "direct" });
    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "draft",
      }),
    ).resolves.toEqual({ aiWriteMode: "draft", status: "updated" });
    expect(state.services.branchPush.setWorkPushPolicy).toHaveBeenCalledWith({
      workId,
      policy: "manual",
      confirmedPush: undefined,
      pushedByUserId: userId,
    });
    expect(state.work.aiWriteMode).toBe("direct");
  });

  it("returns server confirmation when auto-apply would push pending branch changes", async () => {
    const state = deps({ mode: "draft" });
    state.services.branchPush.setWorkPushPolicy.mockResolvedValueOnce({
      status: "confirmation_required",
      unpushedCount: 2,
      reason: "Switching to Auto-apply will apply 2 pending changes.",
    });

    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "direct",
      }),
    ).resolves.toEqual({
      aiWriteMode: "draft",
      status: "confirmation_required",
      reason: "pending_branch_changes",
      pendingChangeCount: 2,
      message: "Switching to Auto-apply will apply 2 pending changes.",
    });
  });

  it("switches to direct/auto policy after server push succeeds", async () => {
    const state = deps({ mode: "draft" });
    await expect(
      handleWorkWriteModeRequest(state.services, {
        projectId,
        workId,
        userId,
        aiWriteMode: "direct",
        confirmedPush: true,
      }),
    ).resolves.toEqual({ aiWriteMode: "direct", status: "updated" });
    expect(state.services.branchPush.setWorkPushPolicy).toHaveBeenCalledWith({
      workId,
      policy: "auto",
      confirmedPush: true,
      pushedByUserId: userId,
    });
    expect(state.work.aiWriteMode).toBe("draft");
  });
});
