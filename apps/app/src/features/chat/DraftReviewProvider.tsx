/** DraftReviewProvider — one focused-thread draft review controller shared by chat and editor. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
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
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useThreadDrafts,
} from "@/client/query/useThreadDrafts";
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
  threadId: string | null;
  children: ReactNode;
};

export function DraftReviewProvider({ threadId, children }: DraftReviewProviderProps) {
  const effectiveThreadId = threadId ?? "";
  const drafts = useThreadDrafts(threadId);
  const nowMs = useThreadStore((state) => state.now);
  const controller = useDraftReviewController(effectiveThreadId);
  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorDocumentId, setActiveEditorDocumentId] = useState<string | null>(null);
  const groups = drafts.groups ?? [];

  useEffect(() => {
    controller.exitReview();
  }, [effectiveThreadId, controller.exitReview]);

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
