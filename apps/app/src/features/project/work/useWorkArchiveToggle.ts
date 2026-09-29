/**
 * One Work command for toggling between its active and archived states. The
 * move shows at once; a rejected move returns the Work and leaves a failure on
 * it until the writer retries or dismisses it.
 */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useState } from "react";
import { useWorkMutations } from "@/client/query/useWorks";

export type WorkArchiveFailure = { workId: string; operation: "archive" | "unarchive" };

export type WorkArchiveToggle = ReturnType<typeof useWorkArchiveToggle>;

export function useWorkArchiveToggle(projectId: string) {
  const { archive, unarchive } = useWorkMutations(projectId);
  const [failure, setFailure] = useState<WorkArchiveFailure | null>(null);
  const run = useCallback(
    (
      workId: string,
      operation: WorkArchiveFailure["operation"],
      options?: { onError?: (error: Error) => void },
    ) => {
      setFailure((current) => (current?.workId === workId ? null : current));
      (operation === "archive" ? archive : unarchive).mutate(workId, {
        onError: (error) => {
          setFailure({ workId, operation });
          options?.onError?.(error);
        },
      });
    },
    [archive, unarchive],
  );
  const toggle = useCallback(
    (work: Work, options?: { onError?: (error: Error) => void }) =>
      run(work.id, work.status === "archived" ? "unarchive" : "archive", options),
    [run],
  );
  const retry = useCallback(
    (options?: { onError?: (error: Error) => void }) => {
      if (failure) run(failure.workId, failure.operation, options);
    },
    [failure, run],
  );
  const dismiss = useCallback(() => setFailure(null), []);
  return { toggle, failure, retry, dismiss };
}
