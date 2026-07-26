/** Work-level auto/manual push policy and auto-push behavior. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { BranchStore } from "./branch-coordinator.js";
import type { PushToLiveResult, WorkPushPolicyStore } from "./branch-push-contracts.js";
import type { WorkDraftPending } from "./work-draft-pending.js";

type PushToLive = (input: {
  branchId: string;
  pushedByUserId?: UserId;
  resetPolicy?: "auto";
}) => Promise<PushToLiveResult>;

export function createWorkPushPolicy(input: {
  branchStore: BranchStore;
  workPushPolicyStore: WorkPushPolicyStore;
  workDraftPending: WorkDraftPending;
  pushToLive: PushToLive;
}) {
  return {
    async pushAutoBranchAfterThreadPeerWrite(autoInput: {
      workDraftBranchId: string;
      pushedByUserId?: UserId;
    }) {
      const branch = await input.branchStore.getBranch(autoInput.workDraftBranchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active") {
        return { status: "skipped" as const, reason: "not_active_work_draft" as const };
      }
      if (branch.pushPolicy !== "auto") {
        return { status: "skipped" as const, reason: "manual_policy" as const };
      }
      return input.pushToLive({
        branchId: autoInput.workDraftBranchId,
        pushedByUserId: autoInput.pushedByUserId,
      });
    },

    async setWorkPushPolicy(policyInput: {
      workId: WorkId;
      policy: "manual" | "auto";
      confirmedPush?: boolean;
      pushedByUserId?: UserId;
    }) {
      if (policyInput.policy === "manual") {
        await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "manual");
        return { status: "updated" as const, policy: "manual" as const };
      }
      const pendingDrafts = await input.workDraftPending.list(policyInput.workId);
      if (pendingDrafts.length > 0 && !policyInput.confirmedPush) {
        return {
          status: "confirmation_required" as const,
          unpushedCount: pendingDrafts.length,
          reason: `Switching to Auto-apply will apply ${pendingDrafts.length} pending changes.`,
        };
      }
      if (pendingDrafts.length > 0) {
        for (const { branch } of pendingDrafts) {
          await input.pushToLive({
            branchId: branch.branchId,
            pushedByUserId: policyInput.pushedByUserId,
            resetPolicy: "auto",
          });
        }
      }
      await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated" as const, policy: "auto" as const };
    },
  };
}
