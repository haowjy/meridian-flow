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
import type { LinkDestination } from "@/features/links";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { useChatNavigation } from "../routing/chat-navigation";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";
import { type AiDraftLaunchTarget, useOpenEditorReview } from "./editor-review-handoff";
import { commitDockDocument } from "./use-dock-placement";

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
      row.contextLocation &&
      openAiDraft({
        workId,
        documentId: row.documentId,
        itemKey: row.draft.itemKey,
        contextLocation: row.contextLocation,
        documentName: row.documentName ?? undefined,
        isNew: row.isNew,
        ...(focusOperationIds?.length ? { focusOperationIds } : {}),
      }),
    [openAiDraft],
  );

  return { openAiDraft, openReviewFile };
}

export function useDockReviewLauncher(projectId: string, document: DockDocument) {
  const { revealDock } = useChatNavigation();
  // Q1: every review control inside this container uses this one launch adapter.
  const launch = useCallback(
    (target: AiDraftLaunchTarget) => {
      const store = useDockDocumentStore.getState();
      const claim = store.claim();
      const tab = contextTabFromDraftGroup(target);
      if (tab)
        commitDockDocument(projectId, document.screen, tab, revealDock, claim, {
          workId: target.workId,
          itemKey: target.itemKey,
        });
    },
    [projectId, document.screen, revealDock],
  );
  return launch;
}

/**
 * A link destination that sends a document living only in a draft to that
 * Work's review (by item identity, as the review handoff does), and every
 * other document to the surface's own live opener.
 */
export function useReviewingLinkDestination(open: LinkDestination): LinkDestination {
  const { openAiDraft } = useAiDraftLauncher();
  return useCallback(
    (document, gesture) => {
      if (!document.review) return open(document, gesture);
      openAiDraft({ documentId: document.documentId, ...document.review });
      return Promise.resolve();
    },
    [open, openAiDraft],
  );
}
