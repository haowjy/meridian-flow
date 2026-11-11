import { useCallback, useSyncExternalStore } from "react";
import { useOptionalDraftOnlyPresentations } from "./account-feature-context";

const subscribeNothing = () => () => undefined;

/** Whether a document is draft-only now (`DraftOnlyPresentations`); re-renders when that changes. */
export function useIsDraftOnly(projectId: string): (documentId: string) => boolean {
  const registry = useOptionalDraftOnlyPresentations();
  const version = useSyncExternalStore(
    registry?.subscribe ?? subscribeNothing,
    () => registry?.version ?? 0,
    () => 0,
  );
  return useCallback(
    (documentId: string) => registry?.isDraftOnly(projectId, documentId) ?? false,
    [registry, projectId, version],
  );
}
