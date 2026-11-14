/** The locks a card reversal takes before its documents' (`TurnReversalServiceDeps.lockOwners`). */

import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { lockWorkThreadTrees } from "../../../shared/thread-work-lock.js";
import { lockProjectTreeList } from "../../../shared/tree-list-lock.js";
import type { TurnReversalServiceDeps } from "../domain/turn-reversal-service.js";

export function createDrizzleReversalLocks(db: Database): TurnReversalServiceDeps["lockOwners"] {
  return async ({ owners, threadId, treeListProjectId }) => {
    const { changed } = await lockWorkThreadTrees(db, owners.workIds as WorkId[], {
      extraThreadIds: [threadId],
      lineageRootIds: owners.lineageRootIds,
    });
    // After the Works and lineages, before any document key: where a Work's delete takes it.
    if (treeListProjectId) await lockProjectTreeList(db, treeListProjectId);
    return { changed };
  };
}
