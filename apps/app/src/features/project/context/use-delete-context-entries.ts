import { useCallback } from "react";
import {
  useDraftCommandOwner,
  useOptionalContextRemovalCoordinator,
} from "@/client/account/account-composition";
import type { TreeVersion } from "@/core/project-tree/tree-version";
import { useShellTreeVersion } from "../tree-version";
import type { DragEntry } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { runDelete } from "./entry-drag/entry-failure";

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
