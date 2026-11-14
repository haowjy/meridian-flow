/** Deletes tree entries: a `delete` record each, at once; a refusal by the server lands on the row. */

import { useCallback } from "react";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
} from "./account-feature-context";
import type { DragEntry } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { runDelete } from "./entry-drag/entry-failure";

/**
 * Deletes one gesture's entries at once: a row's Delete, a selection's, or a drop onto Trash.
 * `at`: where the gesture was made, where its notice with Undo shows (`EntryContext.notice`).
 */
export function useDeleteContextEntries(projectId: string, at: "tree" | "main" = "tree") {
  const actions = useEntryActions(projectId);
  const removal = useOptionalContextRemovalCoordinator();
  const { notices } = useDraftCommandOwner();
  return useCallback(
    (entries: readonly DragEntry[]) =>
      void runDelete(
        { actions, projectId, removal, notice: { notices, at } },
        entries.map(({ ref, name }) => ({ kind: ref.kind, id: ref.id, name })),
      ),
    [removal, projectId, actions, notices, at],
  );
}
