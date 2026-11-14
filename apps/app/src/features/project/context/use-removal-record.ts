/** React subscription to what the project's list says about one document's removal. */
import { useCallback, useSyncExternalStore } from "react";
import { useOptionalProjectStandings } from "./account-feature-context";
import { type RemovalAnswer, removalAnswer } from "./removal-answer";

const unwatched = () => undefined;

/**
 * Whether and how a document was removed: undefined until the list is read, or when no document
 * is asked about.
 */
export function useRemovalRecord(
  projectId: string,
  documentId: string | null,
): RemovalAnswer | undefined {
  const standings = useOptionalProjectStandings();
  const subscribe = useCallback(
    (listener: () => void) =>
      standings && projectId && documentId ? standings.watch(projectId, listener) : unwatched,
    [standings, projectId, documentId],
  );
  const read = useCallback(() => {
    if (!standings || !projectId || !documentId) return undefined;
    return removalAnswer(standings.standing(projectId, documentId));
  }, [standings, projectId, documentId]);
  return useSyncExternalStore(subscribe, read, () => undefined);
}
