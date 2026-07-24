/** Work-level auto/manual push policy and auto-push behavior. */
import type { UserId, WorkId } from "@meridian/contracts/runtime";
import type { BranchStore } from "./branch-coordinator.js";
import type { PushToLiveResult, WorkPushPolicyStore } from "./branch-push-contracts.js";

type PushToLive = (input: {
  branchId: string;
  pushedByUserId?: UserId;
  overlapPolicy?: "refuse" | "apply_and_trail";
  resetPolicy?: "auto";
}) => Promise<PushToLiveResult>;

export function createWorkPushPolicy(input: {
  branchStore: BranchStore;
  workPushPolicyStore: WorkPushPolicyStore;
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
        overlapPolicy: "apply_and_trail",
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
      const unpushedCount = await input.workPushPolicyStore.countUnpushedRowsForWork(
        policyInput.workId,
      );
      if (unpushedCount > 0 && !policyInput.confirmedPush) {
        return {
          status: "confirmation_required" as const,
          unpushedCount,
          reason: `Switching to Auto-apply will apply ${unpushedCount} pending changes.`,
        };
      }
      if (unpushedCount > 0) {
        for (const branchId of await input.workPushPolicyStore.listActiveWorkDraftBranchIdsForWork(
          policyInput.workId,
        )) {
          await input.pushToLive({
            branchId,
            pushedByUserId: policyInput.pushedByUserId,
            resetPolicy: "auto",
            overlapPolicy: "apply_and_trail",
          });
        }
      }
      await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated" as const, policy: "auto" as const };
    },
  };
}
