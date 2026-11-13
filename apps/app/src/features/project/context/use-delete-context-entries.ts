/** Deletes tree entries through the replica; a failure to admit one toasts, a refusal lands on the row. */

import { useCallback } from "react";
import {
  useAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
} from "./account-feature-context";
import type { DragEntry } from "./entry-drag/entry";
import { runDelete } from "./entry-drag/entry-failure";

/** Deletes one gesture's entries at once: a row's Delete, a selection's, or a drop onto Trash. */
export function useDeleteContextEntries(projectId: string) {
  const resources = useAccountResourceReplica();
  const removal = useOptionalContextRemovalCoordinator();
  return useCallback(
    (entries: readonly DragEntry[]) =>
      void runDelete(
        { resources, projectId, removal },
        entries.map(({ ref, name }) => ({ kind: ref.kind, id: ref.id, name })),
      ),
    [removal, projectId, resources],
  );
}
