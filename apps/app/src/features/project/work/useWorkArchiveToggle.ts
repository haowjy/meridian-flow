/**
 * Archive or Unarchive one Work. The move shows at once; a rejected move
 * returns the Work and leaves its failure on the Work's command record.
 */
import type { Work } from "@meridian/contracts/works";
import { useCallback } from "react";
import { useWorkMutations } from "@/client/query/work-command-store";

/** Resolves to the command's failure, or `null`. */
export function useWorkArchiveToggle(projectId: string) {
  const { archive, unarchive } = useWorkMutations(projectId);
  return useCallback(
    (work: Work) => (work.archivedAt !== null ? unarchive : archive)({ workId: work.id }),
    [archive, unarchive],
  );
}
