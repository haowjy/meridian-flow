import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";

export function useDocumentFreeze(projectId: string, tab: OpenDocument | null): Work | null {
  const { works, deleted } = useWorks(projectId);
  const workId =
    tab && tab.kind !== "new" && tab.workId && isWorkScopedScheme(tab.scheme) ? tab.workId : null;
  const work = workId
    ? [...(works ?? []), ...deleted].find((candidate) => candidate.id === workId)
    : undefined;
  return work && workLifecycleState(work) !== "active" ? work : null;
}
