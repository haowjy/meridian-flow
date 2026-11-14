import { newId } from "@meridian/project-tree";
import { useCallback } from "react";
import { useProjectContextSources } from "@/client/query/useContextSources";
import { sourceFor, useTreeList } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "../routing/ProjectNavigationContext";
import { treeActionMessage } from "./tree-action-message";

/**
 * New document: an Untitled document in Unfiled, opened in main with the caret. The writer mints
 * the node's id and appends its `create` at once, so the document shows in the tree and opens
 * before the server has heard of it; its text room connects once the create is admitted.
 */
export function useNewDocument(
  projectId: string,
  open: OpenContextRoute | null,
): (() => void) | undefined {
  const captureNavigation = useCaptureProjectNavigation();
  const actions = useTreeActions({ kind: "project", projectId });
  const { session } = useTreeList({ kind: "project", projectId });
  const unfiled = useProjectContextSources(projectId);
  const unfiledId = unfiled ? sourceFor(unfiled, "unfiled", {})?.id : undefined;
  const create = useCallback(async () => {
    if (!open || !unfiledId) return;
    const isCurrent = captureNavigation?.();
    const documentId = newId();
    const made = actions.create({
      parentId: unfiledId,
      name: "Untitled",
      node: documentId,
      provisional: true,
      kind: "document",
    });
    if (!made.ok) throw new Error(treeActionMessage(made.reason, "file"));
    // The replay's name for the node, at the top of Unfiled: its address.
    const name = session?.replay().nodes.get(documentId)?.displayName ?? made.name;
    const result = await open(
      { scheme: "unfiled", path: name, documentId },
      {
        isCurrent,
        focus: true,
        document: { kind: "new", documentId, name: made.name },
      },
    );
    if (result.kind === "failed") throw result.error;
  }, [actions, open, captureNavigation, session, unfiledId]);
  return open && unfiledId
    ? () => void create().catch((error: unknown) => reportError(error))
    : undefined;
}
