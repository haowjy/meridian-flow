/** Where a document stands in its project's list, as a hook: re-read whenever the list changes. */
import { useCallback, useSyncExternalStore } from "react";
import type { DocumentStanding } from "@/core/tree-list/standing";
import { useProjectStandings } from "./account-feature-context";

const WAITING: DocumentStanding = { kind: "waiting" };
const unwatched = () => undefined;

/** `waiting` for no document: a route that remembers none has nothing to ask. */
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
