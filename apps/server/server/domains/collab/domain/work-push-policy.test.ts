/** Contract tests for switching a Work's AI write mode (D40, D59). */

import type { UserId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { WorkPushPolicyStore } from "./branch-push-contracts.js";
import type { WorkDraftPending } from "./work-draft-pending.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000002" as UserId;

function createHarness() {
  const events: string[] = [];
  const workPushPolicyStore: WorkPushPolicyStore = {
    setWorkWriteMode: vi.fn(async (_workId, policy) => {
      events.push(`policy:${policy}`);
    }),
  };
  const workDraftPending: WorkDraftPending = {
    list: vi.fn(async () => []),
    countPendingByWorkIds: vi.fn(async () => new Map()),
  };
  const applyPendingDraft = vi.fn(
    async ({ draft }: { draft: Awaited<ReturnType<WorkDraftPending["list"]>>[number] }) => {
      events.push(`push:${draft.branch.branchId}`);
      return {
        status: "noop" as const,
        branchId: draft.branch.branchId,
        documentId: draft.branch.documentId,
        branchGeneration: draft.branch.generation,
        reason: "no_active_rows" as const,
      };
    },
  );
  const policy = createWorkPushPolicy({
    workPushPolicyStore,
    workDraftPending,
    applyPendingDraft,
  });

  return {
    applyPendingDraft,
    events,
    policy,
    workDraftPending,
    workPushPolicyStore,
  };
}

describe("work push policy", () => {
  it("switches to manual without inspecting or pushing pending work", async () => {
    const harness = createHarness();

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "manual" }),
    ).resolves.toEqual({ status: "updated", policy: "manual" });
    expect(harness.workDraftPending.list).not.toHaveBeenCalled();
    expect(harness.applyPendingDraft).not.toHaveBeenCalled();
    expect(harness.events).toEqual(["policy:manual"]);
  });

  it("asks what to do with pending work before switching to auto", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(
      pendingDrafts("branch-a", "branch-b"),
    );

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "auto" }),
    ).resolves.toMatchObject({ status: "confirmation_required", unpushedCount: 2 });
    expect(harness.applyPendingDraft).not.toHaveBeenCalled();
    expect(harness.workPushPolicyStore.setWorkWriteMode).not.toHaveBeenCalled();
  });

  it("pushes every active draft before enabling auto policy", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(
      pendingDrafts("branch-a", "branch-b"),
    );

    await expect(
      harness.policy.setWorkPushPolicy({
        workId: WORK_ID,
        policy: "auto",
        pending: "apply",
        pushedByUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "updated", policy: "auto" });
    expect(harness.events).toEqual(["push:branch-a", "push:branch-b", "policy:auto"]);
    expect(harness.applyPendingDraft).toHaveBeenCalledWith({
      draft: expect.objectContaining({
        branch: expect.objectContaining({ branchId: "branch-a" }),
      }),
      pushedByUserId: USER_ID,
    });
  });

  it("keeps pending work for review and switches only the Work's mode", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(
      pendingDrafts("branch-a", "branch-b"),
    );

    await expect(
      harness.policy.setWorkPushPolicy({
        workId: WORK_ID,
        policy: "auto",
        pending: "keep",
      }),
    ).resolves.toEqual({ status: "updated", policy: "auto" });
    expect(harness.applyPendingDraft).not.toHaveBeenCalled();
    expect(harness.workPushPolicyStore.setWorkWriteMode).toHaveBeenCalledWith(WORK_ID, "auto");
  });

  it("does not enable auto policy when a confirmed push fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(pendingDrafts("branch-a"));
    harness.applyPendingDraft.mockRejectedValue(new Error("push failed"));

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "auto", pending: "apply" }),
    ).rejects.toThrow("push failed");
    expect(harness.workPushPolicyStore.setWorkWriteMode).not.toHaveBeenCalled();
  });
});

function pendingDrafts(...branchIds: string[]) {
  return branchIds.map((branchId) => ({
    branch: {
      branchId,
      documentId: "00000000-0000-4000-8000-000000000003",
      workId: WORK_ID,
      generation: 1,
    },
    rows: [],
  }));
}
