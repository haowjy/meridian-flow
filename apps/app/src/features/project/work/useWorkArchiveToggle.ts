import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useCallback } from "react";
import { useWorkMutations } from "@/client/query/work-mutations";

export function useWorkArchiveToggle(projectId: string) {
  const { archive, unarchive } = useWorkMutations(projectId);
  return useCallback(
    (work: Work) => (isWorkArchived(work) ? unarchive : archive)({ workId: work.id }),
    [archive, unarchive],
  );
}
