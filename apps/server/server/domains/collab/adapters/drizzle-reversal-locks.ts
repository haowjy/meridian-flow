import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { lockWorkThreadTrees } from "../../../shared/thread-work-lock.js";
import { lockProjectTreeList } from "../../../shared/tree-list-lock.js";
import type { TurnReversalServiceDeps } from "../domain/turn-reversal-service.js";

export function createDrizzleReversalLocks(db: Database): TurnReversalServiceDeps["lockOwners"] {
  return async ({ owners, receiptWorkIds, threadId, treeListProjectId }) => {
    const { changed } = await lockWorkThreadTrees(db, owners.workIds as WorkId[], {
      threadWorkIds: receiptWorkIds,
      includeMarked: true,
      runtimeThreadLock: true,
      extraThreadIds: [threadId],
      lineageRootIds: owners.lineageRootIds,
    });
    if (treeListProjectId) await lockProjectTreeList(db, treeListProjectId);
    return { changed };
  };
}
