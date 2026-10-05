/**
 * Switching a Work's AI write mode (D40, D59). The mode decides only where new
 * AI writes go; a draft write never pushes itself live, so a reply that saves
 * into the draft after a switch to auto-apply waits there like a kept change.
 */
import type { UserId } from "@meridian/contracts/runtime";
import type {
  PushToLiveResult,
  SetWorkPushPolicyInput,
  SetWorkPushPolicyResult,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import type { PendingWorkDraft, WorkDraftPending } from "./work-draft-pending.js";

type ApplyPendingDraft = (input: {
  draft: PendingWorkDraft;
  pushedByUserId?: UserId;
}) => Promise<PushToLiveResult>;

export function createWorkPushPolicy(input: {
  workPushPolicyStore: WorkPushPolicyStore;
  workDraftPending: WorkDraftPending;
  applyPendingDraft: ApplyPendingDraft;
}) {
  return {
    /**
     * Switching to auto-apply with pending changes needs the writer's choice
     * (D40): `apply` pushes every pending draft once, first; `keep` leaves them
     * for review. An archived Work's drafts are frozen (D30): `apply`'s first
     * push refuses under the Work lock.
     */
    async setWorkPushPolicy(policyInput: SetWorkPushPolicyInput): Promise<SetWorkPushPolicyResult> {
      if (policyInput.policy === "auto") {
        const pendingDrafts = await input.workDraftPending.list(policyInput.workId);
        if (pendingDrafts.length > 0 && !policyInput.pending) {
          return {
            status: "confirmation_required",
            unpushedCount: pendingDrafts.length,
            reason: `Switching to Auto-apply needs a choice for ${pendingDrafts.length} pending changes: apply them now or keep them for review.`,
          };
        }
        if (policyInput.pending !== "keep") {
          for (const draft of pendingDrafts) {
            await input.applyPendingDraft({
              draft,
              ...(policyInput.pushedByUserId ? { pushedByUserId: policyInput.pushedByUserId } : {}),
            });
          }
        }
      }
      await input.workPushPolicyStore.setWorkWriteMode(policyInput.workId, policyInput.policy);
      return { status: "updated", policy: policyInput.policy };
    },
  };
}
