/** One Work command for toggling between its active and archived states. */
import type { Work } from "@meridian/contracts/works";
import { useCallback } from "react";
import { useWorkMutations } from "@/client/query/useWorks";

export function useWorkArchiveToggle(projectId: string) {
  const mutations = useWorkMutations(projectId);
  const { archive, unarchive } = mutations;
  const toggle = useCallback(
    (work: Work, options?: { onError?: (error: Error) => void }) => {
      const mutation = work.status === "archived" ? unarchive : archive;
      mutation.mutate(work.id, options);
    },
    [archive, unarchive],
  );
  return { isPending: mutations.isPending, toggle };
}
