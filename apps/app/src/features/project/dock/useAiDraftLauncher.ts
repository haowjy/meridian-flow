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
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { useContextTabsActions } from "@/client/stores";
import type { LinkDestination } from "@/features/links";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { useProjectDocumentNavigationProjectId } from "../context/open-project-document";
import { useChatNavigation } from "../routing/chat-navigation";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";
import {
  type AiDraftLaunchTarget,
  useOpenEditorReview,
  useOptionalOpenEditorReview,
} from "./editor-review-handoff";
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
    (row: ReviewFileTarget, workId: string, focusGroupIds?: readonly string[]) =>
      row.contextLocation &&
      openAiDraft({
        workId,
        documentId: row.documentId,
        itemKey: row.draft.itemKey,
        contextLocation: row.contextLocation,
        documentName: row.documentName ?? undefined,
        isNew: row.isNew,
        ...(focusGroupIds?.length ? { focusGroupIds } : {}),
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
  const openEditorReview = useOptionalOpenEditorReview();
  const containerLaunch = useContext(ReviewLaunchContext);
  const projectId = useProjectDocumentNavigationProjectId();
  const { openTab } = useContextTabsActions();
  return useCallback(
    (document, gesture) => {
      const { review } = document;
      if (!review) return open(document, gesture);
      // A hidden target exists only in the draft: it is a draft-only review, never a live tab.
      const target: AiDraftLaunchTarget = {
        documentId: document.documentId,
        ...review,
        isNew: true,
      };
      if (gesture === "new-tab") {
        // The writer keeps their place: the review joins the tab strip without a route change.
        const tab = contextTabFromDraftGroup(target);
        if (projectId && tab) openTab(projectId, tab);
        return Promise.resolve();
      }
      if (containerLaunch) {
        containerLaunch(target);
        return Promise.resolve();
      }
      if (!openEditorReview)
        throw new Error("Opening a draft requires the project review handoff owner");
      return openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [open, openEditorReview, containerLaunch, projectId, openTab],
  );
}
