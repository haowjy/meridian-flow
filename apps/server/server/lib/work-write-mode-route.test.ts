/** Contract tests for Work-level write-mode transitions. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { handleWorkWriteModeRequest } from "./work-write-mode-route.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000002" as UserId;

describe("handleWorkWriteModeRequest", () => {
  it("keeps a Work in draft mode when pending changes lack explicit confirmation", async () => {
    const setWorkPushPolicy = vi.fn(async () => ({
      status: "confirmation_required" as const,
      unpushedCount: 2,
      reason: "Switching to Auto-apply will apply 2 pending changes.",
    }));

    await expect(
      handleWorkWriteModeRequest(
        {
          works: {
            findById: vi.fn(async () => ({
              id: WORK_ID,
              createdByUserId: USER_ID,
              aiWriteMode: "draft" as const,
            })),
          },
          branchPush: { setWorkPushPolicy },
        },
        {
          projectId: "project-1",
          workId: WORK_ID,
          userId: USER_ID,
          aiWriteMode: "direct",
        },
      ),
    ).resolves.toEqual({
      aiWriteMode: "draft",
      status: "confirmation_required",
      reason: "pending_branch_changes",
      pendingChangeCount: 2,
      message: "Switching to Auto-apply will apply 2 pending changes.",
    });
    expect(setWorkPushPolicy).toHaveBeenCalledWith({
      workId: WORK_ID,
      policy: "auto",
      confirmedPush: undefined,
      pushedByUserId: USER_ID,
    });
  });
});
