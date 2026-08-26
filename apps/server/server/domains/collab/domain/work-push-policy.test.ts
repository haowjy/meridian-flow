/** Contract tests for work-draft auto/manual push policy transitions. */

import type { UserId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import type { BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import type { WorkPushPolicyStore } from "./branch-push-contracts.js";
import type { WorkDraftPending } from "./work-draft-pending.js";
import { createWorkPushPolicy } from "./work-push-policy.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000002" as UserId;

function workDraft(
  pushPolicy: "manual" | "auto",
  status: "active" | "closed" = "active",
): BranchSnapshot {
  return {
    branchId: "work-draft",
    documentId: "00000000-0000-4000-8000-000000000003",
    kind: "work_draft",
    upstreamBranchId: null,
    workId: WORK_ID,
    threadId: null,
    pushPolicy,
    status,
    generation: 1,
    state: new Uint8Array(),
    stateVector: new Uint8Array(),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  } as BranchSnapshot;
}

function createHarness(branch: BranchSnapshot | null = workDraft("manual")) {
  const events: string[] = [];
  const branchStore: BranchStore = {
    getBranch: vi.fn(async () => branch),
    updateBranchSnapshot: vi.fn(),
    deferUntilCommit: vi.fn(() => false),
  };
  const workPushPolicyStore: WorkPushPolicyStore = {
    updateWorkDraftPushPolicy: vi.fn(async (_workId, policy) => {
      events.push(`policy:${policy}`);
    }),
  };
  const workDraftPending: WorkDraftPending = {
    list: vi.fn(async () => []),
    countPendingByWorkIds: vi.fn(async () => new Map()),
  };
  const pushToLive = vi.fn(async ({ branchId }: { branchId: string }) => {
    events.push(`push:${branchId}`);
    return {
      status: "noop" as const,
      branchId,
      documentId: "00000000-0000-4000-8000-000000000003" as BranchSnapshot["documentId"],
      branchGeneration: 1,
      reason: "no_active_rows" as const,
    };
  });
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
    branchStore,
    workPushPolicyStore,
    workDraftPending,
    pushToLive,
    applyPendingDraft,
  });

  return {
    applyPendingDraft,
    branchStore,
    events,
    policy,
    pushToLive,
    workDraftPending,
    workPushPolicyStore,
  };
}

describe("work push policy", () => {
  it.each([
    { branch: null, reason: "not_active_work_draft" },
    {
      branch: { ...workDraft("auto"), kind: "thread_peer" as const },
      reason: "not_active_work_draft",
    },
    { branch: workDraft("auto", "closed"), reason: "not_active_work_draft" },
    { branch: workDraft("manual"), reason: "manual_policy" },
  ] as const)("does not auto-push $reason branches", async ({ branch, reason }) => {
    const harness = createHarness(branch);

    await expect(
      harness.policy.pushAutoBranchAfterThreadPeerWrite({
        workDraftBranchId: "work-draft",
        pushedByUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "skipped", reason });
    expect(harness.pushToLive).not.toHaveBeenCalled();
  });

  it("auto-pushes an active auto work draft with writer lineage", async () => {
    const harness = createHarness(workDraft("auto"));

    await expect(
      harness.policy.pushAutoBranchAfterThreadPeerWrite({
        workDraftBranchId: "work-draft",
        pushedByUserId: USER_ID,
      }),
    ).resolves.toMatchObject({ status: "noop" });
    expect(harness.pushToLive).toHaveBeenCalledWith({
      branchId: "work-draft",
      pushedByUserId: USER_ID,
    });
  });

  it("switches to manual without inspecting or pushing pending work", async () => {
    const harness = createHarness();

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "manual" }),
    ).resolves.toEqual({ status: "updated", policy: "manual" });
    expect(harness.workDraftPending.list).not.toHaveBeenCalled();
    expect(harness.pushToLive).not.toHaveBeenCalled();
    expect(harness.events).toEqual(["policy:manual"]);
  });

  it("requires confirmation before applying pending work", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(
      pendingDrafts("branch-a", "branch-b"),
    );

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "auto" }),
    ).resolves.toMatchObject({ status: "confirmation_required", unpushedCount: 2 });
    expect(harness.pushToLive).not.toHaveBeenCalled();
    expect(harness.workPushPolicyStore.updateWorkDraftPushPolicy).not.toHaveBeenCalled();
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
        confirmedPush: true,
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

  it("does not enable auto policy when a confirmed push fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.workDraftPending.list).mockResolvedValue(pendingDrafts("branch-a"));
    harness.applyPendingDraft.mockRejectedValue(new Error("push failed"));

    await expect(
      harness.policy.setWorkPushPolicy({ workId: WORK_ID, policy: "auto", confirmedPush: true }),
    ).rejects.toThrow("push failed");
    expect(harness.workPushPolicyStore.updateWorkDraftPushPolicy).not.toHaveBeenCalled();
  });
});

function pendingDrafts(...branchIds: string[]) {
  return branchIds.map((branchId) => ({
    branch: {
      branchId,
      documentId: workDraft("manual").documentId,
      workId: WORK_ID,
      generation: 1,
    },
    rows: [],
  }));
}
