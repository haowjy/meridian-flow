/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point supplies the draft's owning Work. The route-owned
 * handoff stages that identity, navigates to its manuscript in Editor, and lets
 * the matching Editor scope claim it after the route and document commit. The
 * dock supplies its own placement adapter for controls inside its document.
 * Review entry preserves the writer's collapsed/open dock and selected view.
 * A failed launch is held on the draft's command record (by the handoff), where
 * each surface's row shows it; this hook only logs it for diagnostics.
 */

import { createContext, useCallback, useContext } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";

import { type AiDraftLaunchTarget, useOpenEditorReview } from "./editor-review-handoff";

/** Containers choose launch placement once; list launches outside the dock remain Editor commands. */
export const ReviewLaunchContext = createContext<((target: AiDraftLaunchTarget) => void) | null>(
  null,
);

export function useAiDraftLauncher() {
  const openEditorReview = useOpenEditorReview();
  const containerLaunch = useContext(ReviewLaunchContext);

  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      if (containerLaunch) return containerLaunch(target);
      void openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [openEditorReview, containerLaunch],
  );

  /** Opens a listed draft in review. A draft with no address yet (still being written) has nothing to open. */
  const openReviewFile = useCallback(
    (row: ReviewFileTarget, workId: string, focusOperationIds?: readonly string[]) =>
      row.contextPath &&
      openAiDraft({
        workId,
        documentId: row.documentId,
        draftId: row.draft.draftId,
        contextPath: row.contextPath,
        documentName: row.documentName ?? undefined,
        isNewDocument: row.isNewDocument,
        ...(focusOperationIds?.length ? { focusOperationIds } : {}),
      }),
    [openAiDraft],
  );

  return { openAiDraft, openReviewFile };
}
