/** Submit a Work rename through its canonical query-cache mutation. */
import type { Work } from "@meridian/contracts/works";
import { useWorkMutations } from "@/client/query/work-commands";

export function useWorkRename(projectId: string, work: Work) {
  const update = useWorkMutations(projectId).update;
  return {
    // This call's own promise reports its own failure.
    rename: (name: string, onError: () => void) => {
      void update({ workId: work.id, data: { name } }).then((error) => {
        if (error) onError();
      });
    },
  };
}
