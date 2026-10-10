/**
 * useAiDraftLauncher — one-stop "open the AI draft in inline review" flow.
 *
 * Every Review entry point supplies the draft's owning Work. The route-owned
 * handoff stages that identity, navigates to its manuscript in Editor, and lets
 * the matching Editor scope claim it after the route and document commit. The
 * launcher never commands an ambient review controller or changes dock state.
 * Review entry preserves the writer's collapsed/open dock and selected view.
 * A failed launch is held on the draft's command record (by the handoff), where
 * each surface's row shows it; this hook only logs it for diagnostics.
 */

import { useCallback } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";

import { type AiDraftLaunchTarget, useOpenEditorReview } from "./editor-review-handoff";

export function useAiDraftLauncher() {
  const openEditorReview = useOpenEditorReview();

  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      void openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [openEditorReview],
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
