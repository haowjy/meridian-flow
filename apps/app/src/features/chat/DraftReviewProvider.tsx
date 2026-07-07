/** DraftReviewProvider — one focused-thread draft review controller shared by chat and editor. */

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
import { isDraftUndoable } from "@/client/query/draft-undoable";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { useThreadStore } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

export type ReviewableDrafts = {
  visible: ThreadDraftListItem[];
  active: ThreadDraftListItem[];
};

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  groups: ThreadDraftGroup[];
  drafts: ThreadDraftsStatus;
  groupForDocument: (documentId: string | null | undefined) => ThreadDraftGroup | null;
  reviewableDraftsForDocument: (documentId: string | null | undefined) => ReviewableDrafts;
  reviewableDraftsForGroup: (group: ThreadDraftGroup | null | undefined) => ReviewableDrafts;
  reviewRoomNameForDraft: (documentId: string, draftId: string) => string | null;
  nowMs: number;
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
  const queryClient = useQueryClient();
  const effectiveProjectId = projectId ?? "";
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const nowMs = useThreadStore((state) => state.now);
  const controller = useDraftReviewController(effectiveProjectId, effectiveWorkId, threadId);
  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorDocumentId, setActiveEditorDocumentId] = useState<string | null>(null);
  const groups = drafts.groups ?? [];

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

  const reviewableDraftsForGroup = useCallback(
    (group: ThreadDraftGroup | null | undefined): ReviewableDrafts =>
      reviewableDraftsFromGroup(group, nowMs),
    [nowMs],
  );

  const reviewableDraftsForDocument = useCallback(
    (documentId: string | null | undefined) =>
      reviewableDraftsForGroup(groupForDocument(documentId)),
    [groupForDocument, reviewableDraftsForGroup],
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
    const stillReviewable = groups.some((group) =>
      group.drafts.some((draft) => draft.draftId === activeSelection.draftId),
    );
    if (stillReviewable) return;
    controller.exitReview();
  }, [controller.inlineReview, drafts.status, groups, controller.exitReview]);

  useEffect(() => {
    const inline = controller.inlineReview;
    if (!projectId || !workId || !inline) return;
    const registry = getDocumentSessionRegistry();
    const roomKey = controller.reviewRoomName;
    if (!roomKey || !registry.has(roomKey)) return;
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
            inline.documentId,
            inline.draftId,
          ),
        });
      }, 50);
    };
    session.document.on("update", invalidateMountedDraft);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      session.document.off("update", invalidateMountedDraft);
    };
  }, [controller.inlineReview, projectId, queryClient, workId]);

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

  useEffect(() => {
    const inline = controller.inlineReview;
    if (!projectId || !workId || !inline) return;
    const draft = groups
      .flatMap((group) => group.drafts)
      .find((candidate) => candidate.draftId === inline.draftId);
    if (draft?.status !== "active") return;
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDraftPreview(
        projectId,
        workId,
        inline.documentId,
        inline.draftId,
      ),
    });
  }, [controller.inlineReview, groups, projectId, queryClient, workId]);

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      groups,
      drafts,
      groupForDocument,
      reviewableDraftsForDocument,
      reviewableDraftsForGroup,
      reviewRoomNameForDraft,
      nowMs,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [
      controller,
      groups,
      drafts,
      groupForDocument,
      reviewableDraftsForDocument,
      reviewableDraftsForGroup,
      reviewRoomNameForDraft,
      nowMs,
      activeEditorDocumentId,
    ],
  );

  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

export function reviewableDraftsFromGroup(
  group: ThreadDraftGroup | null | undefined,
  nowMs: number,
): ReviewableDrafts {
  const activeDrafts = group?.drafts.filter((draft) => draft.status === "active") ?? [];
  const newestActiveUpdatedAt = activeDrafts.reduce(
    (newest, draft) => Math.max(newest, Date.parse(draft.updatedAt) || 0),
    0,
  );
  const visible =
    group?.drafts.filter((draft) => {
      if (draft.status === "active") return true;
      if (!isDraftUndoable(draft, nowMs)) return false;
      const terminalUpdatedAt = Date.parse(draft.updatedAt) || 0;
      return newestActiveUpdatedAt === 0 || terminalUpdatedAt > newestActiveUpdatedAt;
    }) ?? [];
  return {
    visible,
    active: visible.filter((draft) => draft.status === "active"),
  };
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewProvider");
  }
  return value;
}
