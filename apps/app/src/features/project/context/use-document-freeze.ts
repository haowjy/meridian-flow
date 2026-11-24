import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";

/**
 * The archived or deleted Work whose own file `tab` is, which keeps it read-only until the Work
 * is unarchived or restored; null otherwise. A Work's draft of a document is never frozen: archive
 * stops only new AI writes.
 */
export function useDocumentFreeze(projectId: string, tab: OpenDocument | null): Work | null {
  const { works, deleted } = useWorks(projectId);
  const workId =
    tab && tab.kind !== "new" && tab.workId && isWorkScopedScheme(tab.scheme) ? tab.workId : null;
  const work = workId
    ? [...(works ?? []), ...deleted].find((candidate) => candidate.id === workId)
    : undefined;
  return work && workLifecycleState(work) !== "active" ? work : null;
}
