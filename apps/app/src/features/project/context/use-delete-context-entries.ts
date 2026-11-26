import { useCallback } from "react";
import type { TreeVersion } from "@/core/project-tree/tree-version";
import { useShellTreeVersion } from "../tree-version";
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
 * `version`: the tree the surface lists, which a list of live documents (Files, Recent) names;
 * the sidebar's is the shell's. An entry from a draft tab of the shell's Work is deleted in that
 * Work, whichever way the toggle stands.
 */
export function useDeleteContextEntries(
  projectId: string,
  at: "tree" | "main" = "tree",
  version?: TreeVersion,
) {
  const listed = useEntryActions(projectId, version);
  const shell = useShellTreeVersion();
  const drafted = useEntryActions(projectId, shell?.draftVersion ?? version);
  const removal = useOptionalContextRemovalCoordinator();
  const { notices } = useDraftCommandOwner();
  return useCallback(
    (entries: readonly DragEntry[]) =>
      void runDelete(
        { projectId, removal, notice: { notices, at } },
        entries.map(({ ref, name, view }) => ({
          kind: ref.kind,
          id: ref.id,
          name,
          actions:
            view.kind === "draft" && shell?.draftVersion && view.draft === shell.draftId
              ? drafted
              : listed,
        })),
      ),
    [removal, projectId, listed, drafted, shell, notices, at],
  );
}
