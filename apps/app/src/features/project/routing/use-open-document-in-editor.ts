/** The shared Editor open path for a document locator or an already-resolved view. */
import { parseDraftOwnerKey } from "@meridian/contracts/branches";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { type ContextTab, isEditorContextTab } from "@/client/stores";
import type { ReviewAddress } from "../presented-document";
import { type OpenContextRoute, useOpenContextRoute } from "./ProjectNavigationContext";

type EditorDocument =
  | ({ scheme: ProjectContextTreeScheme; path: string } & ContextOwner)
  | ContextTab;

/** The Work a review opens the Editor in: its owner when a Work; a lineage has none. */
function reviewWorkId(review: ReviewAddress | null | undefined): string | undefined {
  const owner = review ? parseDraftOwnerKey(review.ownerKey) : null;
  return owner?.kind === "work" ? owner.id : undefined;
}

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
      workId: reviewWorkId(review) ?? target.workId ?? undefined,
      ...(tab ? { documentId: tab.documentId } : {}),
      ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
    },
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
