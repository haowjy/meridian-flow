/** DraftReviewProvider — one focused-thread draft review controller shared by chat and editor. */

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
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
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
  return (
    <DraftReviewScope
      key={`${projectId ?? ""}\0${workId ?? ""}`}
      projectId={projectId}
      workId={workId}
      threadId={threadId}
    >
      {children}
    </DraftReviewScope>
  );
}

function DraftReviewScope({
  projectId,
  workId,
  threadId = null,
  children,
}: DraftReviewProviderProps) {
  const queryClient = useQueryClient();
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
  }, [
    controller.exitReview,
    controller.inlineReview,
    controller.isDisposing,
    drafts.status,
    effectiveProjectId,
    groups,
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

  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewProvider");
  }
  return value;
}
