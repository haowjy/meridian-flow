/** The shared Editor open path for a document locator or an already-resolved view. */

import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import type { DraftPin } from "@/client/project-shell/document-views";
import { type ContextTab, isEditorContextTab } from "@/client/stores";
import { type OpenContextRoute, useOpenContextRoute } from "./ProjectNavigationContext";
import { contextRouteRequest } from "./project-route";

type EditorDocument =
  | ({ scheme: ProjectContextTreeScheme; path: string } & ContextOwner)
  | ContextTab;

export function openDocumentInEditor(
  open: OpenContextRoute,
  target: EditorDocument,
  options: { afterCommit?: () => void; review?: DraftPin | null } = {},
) {
  const { review, ...routeOptions } = options;
  const tab = "kind" in target && isEditorContextTab(target) ? target : undefined;
  if ("kind" in target && target.kind === "new")
    return open(
      { scheme: "unfiled", path: "", documentId: target.documentId },
      { replace: false, tab, ...routeOptions },
    );
  return open(
    // The owner is a Scratch note's alone; a draft's owner travels as `reviewOwner`.
    contextRouteRequest({ ...target, documentId: tab?.documentId }),
    {
      replace: false,
      ...routeOptions,
      ...(tab ? { tab } : {}),
      ...(review
        ? { itemKey: review.itemKey, reviewOwner: review.ownerKey, changeId: review.changeId }
        : {}),
    },
  );
}

export function useOpenDocumentInEditor() {
  const open = useOpenContextRoute();
  return useCallback(
    (target: EditorDocument, options?: { afterCommit?: () => void }) => {
      if (open) void openDocumentInEditor(open, target, options);
    },
    [open],
  );
}
