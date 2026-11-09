/** Deletes a tree entry through the replica; a failure to admit it toasts, a refusal lands on the row. */

import { useCallback, useMemo } from "react";
import { useAccountResourceReplica, useOptionalRemovedNotices } from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";
import type { DragEntry } from "./entry-drag/entry";
import { runDelete } from "./entry-drag/entry-failure";

export function useDeleteContextEntry(projectId: string) {
  const resources = useAccountResourceReplica();
  const notices = useOptionalRemovedNotices();
  const requestDelete = useCallback(
    (target: DeleteTarget) =>
      void runDelete(
        { resources, projectId, notices },
        target.kind === "file"
          ? { kind: "file", id: target.documentId, name: target.name }
          : { kind: "folder", id: target.entryId, name: target.name },
      ),
    [notices, projectId, resources],
  );
  /** Deletes dragged rows at once: a drop onto Trash. */
  const deleteEntries = useCallback(
    (entries: readonly DragEntry[]) => {
      for (const { ref, name } of entries)
        void runDelete({ resources, projectId, notices }, { kind: ref.kind, id: ref.id, name });
    },
    [notices, projectId, resources],
  );
  return useMemo(() => ({ requestDelete, deleteEntries }), [requestDelete, deleteEntries]);
}
