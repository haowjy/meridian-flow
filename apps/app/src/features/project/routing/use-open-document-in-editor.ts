/** The shared Editor open path for a document locator or an already-resolved view. */

import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { type DraftPin, readDocumentView } from "@/client/project-shell/document-views";
import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import { useAccountId } from "../context/account-feature-context";
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
  return open(
    // The owner is a Scratch note's alone; a draft's owner travels as `reviewOwner`.
    contextRouteRequest({ ...target, documentId: tab?.documentId }),
    {
      replace: false,
      ...routeOptions,
      ...(tab ? { document: tab } : {}),
      ...reviewRouteOptions(review),
    },
  );
}

/** The route options that open a document on its view's draft; none for Live. */
export function reviewRouteOptions(review: DraftPin | null | undefined) {
  return review
    ? { itemKey: review.itemKey, reviewOwner: review.ownerKey, changeId: review.changeId }
    : {};
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

/** Opens a document in main on what its view paints: the draft it shows travels with it. */
export function useOpenInMain(
  projectId: string,
  open: OpenContextRoute,
): (tab: OpenDocument, options?: { replace?: boolean }) => Promise<NavigationSettlement> {
  const accountId = useAccountId();
  return useCallback(
    (tab, options) =>
      openDocumentInEditor(open, tab, {
        review: readDocumentView(accountId, projectId, tab.documentId).pin,
        ...options,
      }),
    [open, accountId, projectId],
  );
}
