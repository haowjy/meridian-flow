/**
 * Archive and Unarchive for one Work. The move shows at once. A rejected move
 * returns the Work and leaves a failure on it, read from the mutation cache so
 * the Work list and the Work band show the same one, until the writer retries,
 * dismisses it, or runs another command on that Work.
 */
import type { Work } from "@meridian/contracts/works";
import { useCallback } from "react";
import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-commands";

export type WorkArchiveOperation = "archive" | "unarchive";

export type WorkArchiveFailure = {
  operation: WorkArchiveOperation;
  /** Resolves `false` when the command fails again. */
  retry: () => Promise<boolean>;
  dismiss: () => void;
};

export type WorkArchiveToggle = ReturnType<typeof useWorkArchiveToggle>;

const ARCHIVE_OPERATIONS: readonly WorkArchiveOperation[] = ["archive", "unarchive"];

export function useWorkArchiveToggle(projectId: string) {
  const { archive, unarchive } = useWorkMutations(projectId);
  const failures = useWorkCommandFailures(projectId, ARCHIVE_OPERATIONS);
  const run = useCallback(
    (workId: string, operation: WorkArchiveOperation): Promise<boolean> =>
      (operation === "archive" ? archive : unarchive)({ workId }).then((error) => !error),
    [archive, unarchive],
  );
  /** Resolves `false` when the command fails. */
  const toggle = useCallback(
    (work: Work) => run(work.id, work.status === "archived" ? "unarchive" : "archive"),
    [run],
  );
  const failureFor = useCallback(
    (workId: string): WorkArchiveFailure | null => {
      const failure = failures.get(workId);
      if (!failure) return null;
      return {
        operation: failure.operation,
        retry: () => run(workId, failure.operation),
        dismiss: failure.dismiss,
      };
    },
    [failures, run],
  );
  return { toggle, failureFor };
}
