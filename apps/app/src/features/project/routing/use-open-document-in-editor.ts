/** The shared Editor open path for a document locator or an already-resolved view. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { type ContextTab, isEditorContextTab } from "@/client/stores";
import { type OpenContextRoute, useOpenContextRoute } from "./ProjectNavigationContext";

type EditorDocument =
  | ({ scheme: ProjectContextTreeScheme; path: string } & ContextOwner)
  | ContextTab;

export function openDocumentInEditor(
  open: OpenContextRoute,
  target: EditorDocument,
  onAccepted?: () => void,
) {
  const tab = "kind" in target && isEditorContextTab(target) ? target : undefined;
  if ("kind" in target && target.kind === "new")
    return open(
      { scheme: "unfiled", path: "", documentId: target.documentId },
      { replace: false, tab, onAccepted },
    );
  return open(
    {
      scheme: target.scheme,
      path: target.path,
      workId: target.workId ?? undefined,
      ...(tab ? { documentId: tab.documentId } : {}),
      ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
    },
    { replace: false, onAccepted, ...(tab ? { tab } : {}) },
  );
}

export function useOpenDocumentInEditor() {
  const open = useOpenContextRoute();
  return useCallback(
    (target: EditorDocument, onAccepted?: () => void) => {
      if (open) void openDocumentInEditor(open, target, onAccepted);
    },
    [open],
  );
}
