/** Project Home stats projection: folds enriched thread list rows and works into the Home destination counts. */
import type { ProjectStatsResponse, ThreadListItem, Work } from "@meridian/contracts/protocol";
import { summarizeThreadList } from "../domains/threads/domain/thread-list-projection.js";

export function computeProjectStats(
  threads: ThreadListItem[],
  works: Pick<Work, "id">[],
): ProjectStatsResponse {
  return {
    ...summarizeThreadList(threads),
    works: works.length,
  };
}
