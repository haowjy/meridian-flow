import { newId, segmentOf } from "@meridian/project-tree";
import { useCallback } from "react";
import { useProjectContextSources } from "@/client/query/useContextSources";
import { sourceFor, useTreeList } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { useOpenCreatedDocument } from "../review-launch";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "../routing/ProjectNavigationContext";

/**
 * New document: an Untitled document in Unfiled, opened in main with the caret. The writer mints
 * the node's id and appends its `create` at once, so the document shows in the tree, and it opens
 * before the server has heard of it: on Live its text room, on Draft the Work's draft of it
 * (`useOpenCreatedDocument`), connects once the create is admitted.
 */
export function useNewDocument(
  projectId: string,
  open: OpenContextRoute | null,
): (() => void) | undefined {
  const captureNavigation = useCaptureProjectNavigation();
  const actions = useTreeActions({ kind: "project", projectId });
  const version = useTreeVersion();
  const openCreated = useOpenCreatedDocument();
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
    // The replay's segment for the node, at the top of Unfiled: its address.
    const shown = session?.replay(version.view, version.pendingText).nodes.get(documentId);
    const name = shown ? segmentOf(shown) : made.name;
    const document = {
      documentId,
      contextLocation: { scheme: "unfiled" as const, path: `/${name}` },
    };
    await openCreated(document, async () => {
      const result = await open(
        { scheme: "unfiled", path: name, documentId },
        {
          isCurrent,
          focus: true,
          document: { kind: "new", documentId, name: made.name },
        },
      );
      if (result.kind === "failed") throw result.error;
    });
  }, [actions, open, openCreated, captureNavigation, session, unfiledId, version]);
  return open && unfiledId && version.ended !== "deleted"
    ? () => void create().catch((error: unknown) => reportError(error))
    : undefined;
}
