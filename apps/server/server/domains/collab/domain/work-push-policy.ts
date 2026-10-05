/** Work-level auto/manual push policy and auto-push behavior. */
import type { UserId } from "@meridian/contracts/runtime";
import type { BranchStore } from "./branch-coordinator.js";
import type {
  PushToLiveResult,
  SetWorkPushPolicyInput,
  SetWorkPushPolicyResult,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import type { PendingWorkDraft, WorkDraftPending } from "./work-draft-pending.js";

type PushToLive = (input: {
  branchId: string;
  pushedByUserId?: UserId;
  resetPolicy?: "auto";
}) => Promise<PushToLiveResult>;

type ApplyPendingDraft = (input: {
  draft: PendingWorkDraft;
  pushedByUserId?: UserId;
}) => Promise<PushToLiveResult>;

export function createWorkPushPolicy(input: {
  branchStore: BranchStore;
  workPushPolicyStore: WorkPushPolicyStore;
  workDraftPending: WorkDraftPending;
  pushToLive: PushToLive;
  applyPendingDraft: ApplyPendingDraft;
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

    /**
     * Switching to auto-apply with pending changes needs the writer's choice
     * (D40): `apply` pushes every pending draft first, `keep` leaves them for
     * review. An archived Work's drafts are frozen (D30): `apply`'s first
     * push refuses under the Work lock.
     */
    async setWorkPushPolicy(policyInput: SetWorkPushPolicyInput): Promise<SetWorkPushPolicyResult> {
      if (policyInput.policy === "manual") {
        await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "manual");
        return { status: "updated", policy: "manual" };
      }
      const pendingDrafts = await input.workDraftPending.list(policyInput.workId);
      if (pendingDrafts.length > 0 && !policyInput.pending) {
        return {
          status: "confirmation_required",
          unpushedCount: pendingDrafts.length,
          reason: `Switching to Auto-apply needs a choice for ${pendingDrafts.length} pending changes: apply them now or keep them for review.`,
        };
      }
      if (pendingDrafts.length > 0 && policyInput.pending === "keep") {
        // Kept drafts stay `manual`: a late draft write (a reply granted
        // before the switch) must not auto-push the kept changes live.
        await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "auto", {
          keepDraftBranches: true,
        });
        return { status: "updated", policy: "auto" };
      }
      for (const draft of pendingDrafts) {
        await input.applyPendingDraft({
          draft,
          ...(policyInput.pushedByUserId ? { pushedByUserId: policyInput.pushedByUserId } : {}),
        });
      }
      await input.workPushPolicyStore.updateWorkDraftPushPolicy(policyInput.workId, "auto");
      return { status: "updated", policy: "auto" };
    },
  };
}
