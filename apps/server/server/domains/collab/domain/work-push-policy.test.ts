/** Contract tests for switching a Work's AI write mode (D40, D59). */

import type { DraftId } from "@meridian/contracts";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { WorkPushPolicyStore } from "./branch-push-contracts.js";
import type { ApplyResult, DraftPublication } from "./draft-publication.js";
import type { DraftReviewItem } from "./draft-review-items.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000002" as UserId;
const DRAFT_ID = "00000000-0000-4000-8000-000000000004" as DraftId;

function createHarness() {
  const events: string[] = [];
  const workPushPolicyStore: WorkPushPolicyStore = {
    setWorkWriteMode: vi.fn(async (_workId, policy) => {
      events.push(`policy:${policy}`);
    }),
  };
  const list = vi.fn(async (): Promise<DraftReviewItem[]> => []);
  const applyItems = vi.fn<DraftPublication["applyItems"]>(async (): Promise<ApplyResult> => {
    events.push("apply");
    return { status: "applied", draftId: DRAFT_ID, draftClosed: true, items: [] };
  });
  const policy = createWorkPushPolicy({
    workPushPolicyStore,
    reviewItems: { list },
    publication: { applyItems },
    drafts: {
      activeForWork: async (workId) => ({
        id: DRAFT_ID,
        projectId: "00000000-0000-4000-8000-000000000005" as ProjectId,
        status: "active",
        originWorkId: workId,
        originThreadId: null,
        createdBy: USER_ID,
        createdAt: new Date(0),
      }),
    },
  });

  return { applyItems, events, list, policy, workPushPolicyStore };
}

describe("work push policy", () => {
  it("applies the whole draft as one publication before enabling auto policy", async () => {
    const harness = createHarness();
    harness.list.mockResolvedValue(pendingItems(2));

    await expect(
      harness.policy.setWorkPushPolicy({
        workId: WORK_ID,
        policy: "auto",
        pending: "apply",
        pushedByUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "updated", policy: "auto" });
    expect(harness.events).toEqual(["apply", "policy:auto"]);
    expect(harness.applyItems).toHaveBeenCalledWith({
      workId: WORK_ID,
      draftId: DRAFT_ID,
      selection: { kind: "all_pending" },
      closeWhenEmpty: true,
      userId: USER_ID,
    });
  });

  it("does not enable auto policy when the confirmed Apply fails", async () => {
    const harness = createHarness();
    harness.list.mockResolvedValue(pendingItems(1));
    harness.applyItems.mockRejectedValue(new Error("apply failed"));

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "auto", pending: "apply" }),
    ).rejects.toThrow("apply failed");
    expect(harness.workPushPolicyStore.setWorkWriteMode).not.toHaveBeenCalled();
  });
});

function pendingItems(count: number): DraftReviewItem[] {
  return Array.from({ length: count }, (_, index) => {
    const documentId =
      `00000000-0000-4000-8000-00000000010${index}` as DraftReviewItem["documentId"];
    return {
      draftId: DRAFT_ID,
      itemKey: `${DRAFT_ID}:${documentId}`,
      documentId,
      draftBranchId: `branch-${index}`,
      origin: "edited",
      isNew: false,
      binary: false,
      documentName: null,
      path: null,
      livePath: null,
      conflict: null,
      deletedLive: false,
      tokens: { locationToken: "1", liveTextToken: null, branchGenerationToken: "1" },
      pendingRows: 1,
      lastActorTurnId: null,
      updatedAt: new Date(0),
    };
  });
}
