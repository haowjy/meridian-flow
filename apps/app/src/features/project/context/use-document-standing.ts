import { useCallback, useSyncExternalStore } from "react";
import { useProjectStandings } from "@/client/account/account-context";
import type { DocumentStanding } from "@/core/tree-list/standing";

const WAITING: DocumentStanding = { kind: "waiting" };
const unwatched = () => undefined;

export function useDocumentStanding(
  projectId: string,
  documentId: string | null,
): DocumentStanding {
  const standings = useProjectStandings();
  const subscribe = useCallback(
    (listener: () => void) => (documentId ? standings.watch(projectId, listener) : unwatched),
    [standings, projectId, documentId],
  );
  const read = useCallback(
    () => (documentId ? standings.standing(projectId, documentId) : WAITING),
    [standings, projectId, documentId],
  );
  return useSyncExternalStore(subscribe, read, () => WAITING);
}
