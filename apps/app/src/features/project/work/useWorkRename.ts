/** Submit a Work rename through its canonical query-cache mutation. */
import type { Work } from "@meridian/contracts/works";
import { useWorkMutations } from "@/client/query/useWorks";

export function useWorkRename(projectId: string, work: Work) {
  const update = useWorkMutations(projectId).update;
  return {
    rename: (name: string, onError: () => void) => {
      update.mutate({ workId: work.id, data: { name } }, { onError });
    },
  };
}
