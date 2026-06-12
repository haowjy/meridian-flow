/** Workbench Home stats projection: folds enriched thread list rows and works into the Home destination counts. */
import type { ThreadListItem, Work, WorkbenchStatsResponse } from "@meridian/contracts/protocol";
import { summarizeThreadList } from "../domains/threads/domain/thread-list-projection.js";

export function computeWorkbenchStats(
  threads: ThreadListItem[],
  works: Pick<Work, "id">[],
): WorkbenchStatsResponse {
  return {
    ...summarizeThreadList(threads),
    works: works.length,
  };
}
