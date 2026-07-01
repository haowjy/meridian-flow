/** DraftReviewProvider — one focused-thread draft review controller shared by chat and editor. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useThreadDrafts,
} from "@/client/query/useThreadDrafts";

import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  groups: ThreadDraftGroup[];
  drafts: ThreadDraftsStatus;
  groupForDocument: (documentId: string | null | undefined) => ThreadDraftGroup | null;
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
  const controller = useDraftReviewController(effectiveThreadId);
  const [activeEditorDocumentId, setActiveEditorDocumentId] = useState<string | null>(null);
  const groups = drafts.groups ?? [];

  useEffect(() => {
    controller.closeReview();
  }, [effectiveThreadId, controller.closeReview]);

  const groupForDocument = useCallback(
    (documentId: string | null | undefined) => {
      if (!documentId) return null;
      return groups.find((group) => group.documentId === documentId) ?? null;
    },
    [groups],
  );

  const selectedDraft = controller.selectedDraft;
  useEffect(() => {
    if (selectedDraft == null) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const stillReviewable = groups.some((group) =>
      group.drafts.some((draft) => draft.draftId === selectedDraft.draftId),
    );
    if (!stillReviewable) controller.closeReview();
  }, [selectedDraft, drafts.status, groups, controller.closeReview]);

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      groups,
      drafts,
      groupForDocument,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [controller, groups, drafts, groupForDocument, activeEditorDocumentId],
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

export function useRegisterDraftReviewEditor(documentId: string | null) {
  const { setActiveEditorDocumentId } = useDraftReview();
  useEffect(() => {
    setActiveEditorDocumentId(documentId);
    return () => setActiveEditorDocumentId(null);
  }, [documentId, setActiveEditorDocumentId]);
}
