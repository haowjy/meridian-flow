/**
 * Switching a Work's AI write mode (D40, D59). The mode decides only where new
 * AI writes go; a draft write never pushes itself live, so a reply that saves
 * into the draft after a switch to auto-apply waits there like a kept change.
 */
import type {
  SetWorkPushPolicyInput,
  SetWorkPushPolicyResult,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import type { DraftPublication } from "./draft-publication.js";
import type { DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";

export function createWorkPushPolicy(input: {
  workPushPolicyStore: WorkPushPolicyStore;
  drafts: Pick<Drafts, "activeForWork">;
  reviewItems: Pick<DraftReviewItems, "list">;
  publication: Pick<DraftPublication, "applyItems">;
}) {
  return {
    /**
     * Switching to auto-apply with pending changes needs the writer's choice
     * (D40): `apply` applies the whole draft as one publication first, closing it
     * when nothing stays (a held item stays in the draft as a kept change); `keep`
     * leaves it for review. An archived Work's draft is frozen (D30): the Apply
     * refuses under the Work lock.
     */
    async setWorkPushPolicy(policyInput: SetWorkPushPolicyInput): Promise<SetWorkPushPolicyResult> {
      if (policyInput.policy === "auto") {
        // A Work with no active draft has nothing pending; the switch never makes one.
        const draft = await input.drafts.activeForWork(policyInput.workId);
        const pending = draft
          ? await input.reviewItems.list(draft.id, { liveTextTokens: false })
          : [];
        if (pending.length > 0 && !policyInput.pending) {
          return {
            status: "confirmation_required",
            unpushedCount: pending.length,
            reason: `Switching to Auto-apply needs a choice for ${pending.length} pending changes: apply them now or keep them for review.`,
          };
        }
        if (draft && pending.length > 0 && policyInput.pending !== "keep") {
          await input.publication.applyItems({
            workId: policyInput.workId,
            draftId: draft.id,
            selection: { kind: "all_pending" },
            closeWhenEmpty: true,
            ...(policyInput.pushedByUserId ? { userId: policyInput.pushedByUserId } : {}),
          });
        }
      }
      await input.workPushPolicyStore.setWorkWriteMode(policyInput.workId, policyInput.policy);
      return { status: "updated", policy: policyInput.policy };
    },
  };
}
