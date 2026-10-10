/**
 * Leasing a whole draft (contract §2.1, §14): every active branch of the draft, both kinds,
 * discovered outside any transaction and leased in the one ordered acquisition a reply's
 * save and a thread-core access also use. Closing a draft (Discard all, Apply all, purge)
 * runs its transaction inside.
 */
import type { DraftId } from "@meridian/contracts";
import type { BranchCriticalSections, BranchLockLease } from "./branch-critical-sections.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";

export type DraftBranchLeases = {
  withDraftBranches<T>(
    draftId: DraftId,
    run: (lease: BranchLockLease, branchIds: readonly string[]) => Promise<T>,
  ): Promise<T>;
};

export function createDraftBranchLeases(deps: {
  branches: Pick<ApplicationBranchStore, "listActiveDraftBranchIds">;
  criticalSections: BranchCriticalSections;
}): DraftBranchLeases {
  return {
    async withDraftBranches(draftId, run) {
      const branchIds = await deps.branches.listActiveDraftBranchIds(draftId);
      return deps.criticalSections.withBranches(branchIds, (lease) => run(lease, branchIds));
    },
  };
}
