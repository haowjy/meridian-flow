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
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { useThreadStore } from "@/client/stores";
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
  nowMs: number;
  activeEditorDocumentId: string | null;
  setActiveEditorDocumentId: (documentId: string | null) => void;
};

const DraftReviewContext = createContext<DraftReviewContextValue | null>(null);

export type DraftReviewProviderProps = {
  projectId: string | null;
  workId: string | null;
  children: ReactNode;
};

export function DraftReviewProvider({ projectId, workId, children }: DraftReviewProviderProps) {
  const queryClient = useQueryClient();
  const effectiveProjectId = projectId ?? "";
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const nowMs = useThreadStore((state) => state.now);
  const controller = useDraftReviewController(effectiveProjectId, effectiveWorkId);
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
    (group: ThreadDraftGroup | null | undefined): ReviewableDrafts => {
      const visible =
        group?.drafts.filter(
          (draft) => draft.status === "active" || isDraftUndoable(draft, nowMs),
        ) ?? [];
      return {
        visible,
        active: visible.filter((draft) => draft.status === "active"),
      };
    },
    [nowMs],
  );

  const reviewableDraftsForDocument = useCallback(
    (documentId: string | null | undefined) =>
      reviewableDraftsForGroup(groupForDocument(documentId)),
    [groupForDocument, reviewableDraftsForGroup],
  );

  const selectedDraft = controller.selectedDraft;
  useEffect(() => {
    const activeSelection = controller.inlineReview ?? selectedDraft;
    if (activeSelection == null) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const stillReviewable = groups.some((group) =>
      group.drafts.some((draft) => draft.draftId === activeSelection.draftId),
    );
    if (stillReviewable) return;
    controller.exitReview();
  }, [selectedDraft, controller.inlineReview, drafts.status, groups, controller.exitReview]);

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
        "inline",
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
      nowMs,
      activeEditorDocumentId,
    ],
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
