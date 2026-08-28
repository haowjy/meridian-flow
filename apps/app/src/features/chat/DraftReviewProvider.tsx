/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { projectContextTreeQueryOptions } from "@/client/query/useProjectContextTree";
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { useContextTabsStore } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useContextRemovalCoordinator } from "@/features/project/context/ContextRemovalAccountProvider";
import { findContextFileByDocumentId } from "@/features/project/context/context-tree";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  groups: ThreadDraftGroup[];
  drafts: ThreadDraftsStatus;
  groupForDocument: (documentId: string | null | undefined) => ThreadDraftGroup | null;
  reviewRoomNameForDraft: (documentId: string, draftId: string) => string | null;
  activeEditorDocumentId: string | null;
  setActiveEditorDocumentId: (documentId: string | null) => void;
};

const DraftReviewContext = createContext<DraftReviewContextValue | null>(null);

export type DraftReviewProviderProps = {
  projectId: string | null;
  workId: string | null;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
  children: ReactNode;
};

export function DraftReviewProvider({
  projectId,
  workId,
  threadId = null,
  children,
}: DraftReviewProviderProps) {
  const value = useDraftReviewScopeValue({ projectId, workId, threadId });
  return <DraftReviewBoundary value={value}>{children}</DraftReviewBoundary>;
}

export function DraftReviewBoundary({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

export function useDraftReviewScopeValue({
  projectId,
  workId,
  threadId = null,
}: Omit<DraftReviewProviderProps, "children">): DraftReviewContextValue {
  return useDraftReviewScopeOwner(projectId, workId, threadId);
}

function useDraftReviewScopeOwner(
  projectId: string | null,
  workId: string | null,
  threadId: string | null,
): DraftReviewContextValue {
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const effectiveProjectId = projectId ?? "";
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const groups = drafts.groups ?? [];
  const controller = useDraftReviewController(effectiveProjectId, effectiveWorkId, threadId);
  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorDocumentId, setActiveEditorDocumentId] = useState<string | null>(null);

  useEffect(() => {
    controller.exitReview();
  }, [effectiveProjectId, effectiveWorkId, controller.exitReview]);

  const groupForDocument = useCallback(
    (documentId: string | null | undefined) => {
      if (!documentId) return null;
      return groups.find((group) => group.documentId === documentId) ?? null;
    },
    [groups],
  );

  const reviewRoomNameForDraft = useCallback(
    (documentId: string, draftId: string) =>
      controller.inlineReview?.documentId === documentId &&
      controller.inlineReview.draftId === draftId
        ? controller.reviewRoomName
        : null,
    [controller.inlineReview, controller.reviewRoomName],
  );

  useEffect(() => {
    const activeSelection = controller.inlineReview;
    if (activeSelection == null) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    if (controller.isDisposing) return;
    const documentDrafts =
      groups.find((group) => group.documentId === activeSelection.documentId)?.drafts ?? [];
    if (documentDrafts.some((draft) => draft.draftId === activeSelection.draftId)) return;
    controller.exitReview();
    if (!projectId || !workId) return;
    const tabs = useContextTabsStore.getState();
    const tab = tabs.byProject[projectId]?.tabs.find(
      (candidate) => candidate.documentId === activeSelection.documentId,
    );
    if (tab?.kind !== "tracked" || !tab.draftOnly || tab.reviewWorkId !== workId) return;

    // The active-only list cannot say why a remote disposition removed the
    // draft. For draft-created documents, manifest membership is authoritative:
    // Apply materializes the document; Discard does not.
    const treeQuery = projectContextTreeQueryOptions(projectId, "manuscript", null);
    void queryClient
      .cancelQueries({ queryKey: treeQuery.queryKey })
      .then(() => queryClient.fetchQuery({ ...treeQuery, staleTime: 0 }))
      .then(({ tree }) => {
        const currentTabs = useContextTabsStore.getState();
        const currentTab = currentTabs.byProject[projectId]?.tabs.find(
          (candidate) => candidate.documentId === activeSelection.documentId,
        );
        if (
          currentTab?.kind !== "tracked" ||
          !currentTab.draftOnly ||
          currentTab.reviewWorkId !== workId
        )
          return;
        const currentDrafts =
          queryClient.getQueryData<ThreadDraftListItem[]>(
            projectQueryKeys.workDrafts(projectId, workId),
          ) ?? [];
        if (currentDrafts.some((draft) => draft.documentId === activeSelection.documentId)) return;
        if (findContextFileByDocumentId(tree, activeSelection.documentId)) {
          contextRemoval.applyDraftMetadata(projectId, workId, activeSelection.documentId);
        } else {
          void contextRemoval.discardDraft(projectId, workId, activeSelection.documentId);
        }
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
  }, [
    contextRemoval,
    controller.exitReview,
    controller.inlineReview,
    controller.isDisposing,
    drafts.status,
    effectiveProjectId,
    groups,
    projectId,
    queryClient,
    workId,
  ]);

  useEffect(() => {
    const inlineDocumentId = controller.inlineReview?.documentId;
    const inlineDraftId = controller.inlineReview?.draftId;
    const roomKey = controller.reviewRoomName;
    if (!projectId || !workId || !inlineDocumentId || !inlineDraftId || !roomKey) return;
    const registry = getDocumentSessionRegistry();
    if (!registry.has(roomKey)) return;
    const session = registry.getRoom(roomKey);
    let timer: number | null = null;
    const invalidateMountedDraft = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDrafts(projectId, workId),
        });
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            projectId,
            workId,
            inlineDocumentId,
            inlineDraftId,
          ),
        });
      }, 50);
    };
    session.document.on("update", invalidateMountedDraft);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      session.document.off("update", invalidateMountedDraft);
    };
  }, [
    controller.inlineReview?.documentId,
    controller.inlineReview?.draftId,
    controller.reviewRoomName,
    projectId,
    queryClient,
    workId,
  ]);

  useEffect(() => {
    if (!threadId || !activeEditorDocumentId) return;
    const registry = getDocumentSessionRegistry();
    const session = registry.get(activeEditorDocumentId);
    let timer: number | null = null;
    const invalidateLineage = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
      }, 200);
    };
    session.document.on("update", invalidateLineage);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      session.document.off("update", invalidateLineage);
    };
  }, [activeEditorDocumentId, queryClient, threadId]);

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      groups,
      drafts,
      groupForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [controller, groups, drafts, groupForDocument, reviewRoomNameForDraft, activeEditorDocumentId],
  );

  return value;
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewProvider");
  }
  return value;
}
