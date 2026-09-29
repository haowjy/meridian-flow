/** Submit a Work rename through its canonical query-cache mutation. */
import type { Work } from "@meridian/contracts/works";
import { useWorkMutations } from "@/client/query/useWorks";

export function useWorkRename(projectId: string, work: Work) {
  const update = useWorkMutations(projectId).update;
  return {
    // Per-call `mutate` callbacks reach only an observer's latest call; this
    // call's own promise reports its own failure.
    rename: (name: string, onError: () => void) => {
      update.mutateAsync({ workId: work.id, data: { name } }).catch(onError);
    },
  };
}
