/** Deletes a tree entry through the replica; a failure to admit it toasts, a refusal lands on the row. */

import { useCallback, useMemo } from "react";
import {
  useAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
} from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";
import type { DragEntry } from "./entry-drag/entry";
import { runDelete } from "./entry-drag/entry-failure";

export function useDeleteContextEntry(projectId: string) {
  const resources = useAccountResourceReplica();
  const removal = useOptionalContextRemovalCoordinator();
  const requestDelete = useCallback(
    (target: DeleteTarget) =>
      void runDelete({ resources, projectId, removal }, [
        target.kind === "file"
          ? { kind: "file", id: target.documentId, name: target.name }
          : { kind: "folder", id: target.entryId, name: target.name },
      ]),
    [removal, projectId, resources],
  );
  /** Deletes dragged rows at once: a drop onto Trash. */
  const deleteEntries = useCallback(
    (entries: readonly DragEntry[]) =>
      void runDelete(
        { resources, projectId, removal },
        entries.map(({ ref, name }) => ({ kind: ref.kind, id: ref.id, name })),
      ),
    [removal, projectId, resources],
  );
  return useMemo(() => ({ requestDelete, deleteEntries }), [requestDelete, deleteEntries]);
}
