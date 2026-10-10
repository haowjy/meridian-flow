/** The shared Editor open path for a document locator or an already-resolved view. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { type ContextTab, isEditorContextTab } from "@/client/stores";
import type { ReviewAddress } from "../presented-document";
import { type OpenContextRoute, useOpenContextRoute } from "./ProjectNavigationContext";

type EditorDocument =
  | ({ scheme: ProjectContextTreeScheme; path: string } & ContextOwner)
  | ContextTab;

export function openDocumentInEditor(
  open: OpenContextRoute,
  target: EditorDocument,
  options: { afterCommit?: () => void; review?: ReviewAddress | null } = {},
) {
  const { review, ...routeOptions } = options;
  const tab = "kind" in target && isEditorContextTab(target) ? target : undefined;
  if ("kind" in target && target.kind === "new")
    return open(
      { scheme: "unfiled", path: "", documentId: target.documentId },
      { replace: false, tab, ...routeOptions },
    );
  return open(
    {
      scheme: target.scheme,
      path: target.path,
      workId: review?.workId ?? target.workId ?? undefined,
      ...(tab ? { documentId: tab.documentId } : {}),
      ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
    },
    {
      replace: false,
      ...routeOptions,
      ...(tab ? { tab } : {}),
      ...(review ? { draftId: review.draftId } : {}),
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
