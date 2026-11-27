import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import type { DraftPin } from "@/client/project-shell/document-views";
import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import { useOptionalChatOnScreen } from "../side/SideView";
import { useShownDraft } from "../views";
import { type OpenContextRoute, useOpenContextRoute } from "./ProjectNavigationContext";
import type { NavigationSettlement } from "./project-navigation";
import { contextRouteRequest } from "./project-route";

type EditorDocument =
  | ({ scheme: ProjectContextTreeScheme; path: string } & ContextOwner)
  | OpenDocument;

export function openDocumentInEditor(
  open: OpenContextRoute,
  target: EditorDocument,
  options: { afterCommit?: () => void; review?: DraftPin | null; replace?: boolean } = {},
) {
  const { review, ...routeOptions } = options;
  const tab = "kind" in target && isEditorOpenDocument(target) ? target : undefined;
  if ("kind" in target && target.kind === "new")
    return open(
      { scheme: "unfiled", path: "", documentId: target.documentId },
      { replace: false, document: tab, ...routeOptions },
    );
  return open(contextRouteRequest({ ...target, documentId: tab?.documentId }), {
    replace: false,
    ...routeOptions,
    ...(tab ? { document: tab } : {}),
    ...reviewRouteOptions(review),
  });
}

export function reviewRouteOptions(review: DraftPin | null | undefined) {
  return review ? { itemKey: review.itemKey } : {};
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

export function useOpenInMain(
  projectId: string,
  open: OpenContextRoute,
): (tab: OpenDocument, options?: { replace?: boolean }) => Promise<NavigationSettlement> {
  const shownOf = useShownDraft(projectId, useOptionalChatOnScreen());
  return useCallback(
    (tab, options) =>
      openDocumentInEditor(open, tab, { review: shownOf(tab.documentId), ...options }),
    [open, shownOf],
  );
}
