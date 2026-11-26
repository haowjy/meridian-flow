import { newId } from "@meridian/project-tree";
import { useCallback } from "react";
import { useProjectContextSources } from "@/client/query/useContextSources";
import { sourceFor } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import { useOpenCreatedDocument } from "../review-launch";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "../routing/ProjectNavigationContext";

export function useNewDocument(
  projectId: string,
  open: OpenContextRoute | null,
): (() => void) | undefined {
  const captureNavigation = useCaptureProjectNavigation();
  const actions = useTreeActions({ kind: "project", projectId });
  const version = useTreeVersion();
  const openCreated = useOpenCreatedDocument();
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
    const { path } = made;
    if (!path) throw new Error("The new document is not in Unfiled");
    const document = {
      documentId,
      contextLocation: { scheme: "unfiled" as const, path },
    };
    await openCreated(document, async () => {
      const result = await open(
        { scheme: "unfiled", path: path.slice(1), documentId },
        {
          isCurrent,
          focus: true,
          document: { kind: "new", documentId, name: made.name },
        },
      );
      if (result.kind === "failed") throw result.error;
    });
  }, [actions, open, openCreated, captureNavigation, unfiledId, version]);
  return open && unfiledId && version.ended !== "deleted"
    ? () => void create().catch((error: unknown) => reportError(error))
    : undefined;
}
