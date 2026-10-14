/** Pull-service dependencies for tests: the real rebase over the fixture's journal and coordinator. */

import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createLiveCutReader } from "../adapters/drizzle-live-cut.js";
import type { BranchCoordinator } from "../domain/branch-coordinator.js";
import type { createBranchPullService } from "../domain/branch-pulls.js";
import { createDraftRebase } from "../domain/draft-rebase.js";
import type { ApplicationBranchStore } from "../domain/ports/application-branch-store.js";

export function draftRebaseDeps(input: {
  journal: Pick<UpdateJournal, "read">;
  branchCoordinator: BranchCoordinator;
  branches: Pick<ApplicationBranchStore, "blockingApplySettlement">;
}): Pick<Parameters<typeof createBranchPullService>[0], "draftRebase"> {
  return {
    draftRebase: createDraftRebase({
      branchCoordinator: input.branchCoordinator,
      liveCut: createLiveCutReader(input.journal),
      blockingApplySettlement: input.branches.blockingApplySettlement,
    }),
  };
}
