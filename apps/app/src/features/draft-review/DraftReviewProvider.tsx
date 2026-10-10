/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { type ThreadDraftsStatus, useWorkDrafts } from "@/client/query/useWorkDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { DocumentSession } from "@/core/editor/document-session";
import type { PresentedDocument } from "@/features/project/presented-document";
import { EMPTY_DRAFT_REVIEW_STATE } from "./draft-review-session";
import {
  type DraftReviewController,
  type DraftReviewStateOwner,
  useDraftReviewController,
  useDraftReviewStateOwner,
} from "./useDraftReviewController";
import { useReconcileReviewFocus } from "./useReconcileReviewFocus";
import { useReviewRefresh } from "./useReviewRefresh";
import { type ReviewRoomOwner, useReviewRoomOwner } from "./useReviewRoomOwner";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  roomOwner: ReviewRoomOwner;
  files: ReviewFileTarget[];
  drafts: ThreadDraftsStatus;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  reviewRoomNameForDraft: (documentId: string, draftId: string) => string | null;
  activeEditorDocumentId: string | null;
  setActiveEditorDocumentId: (
    documentId: string | null,
    session?: DocumentSession | null,
    inReview?: boolean,
    owner?: object,
  ) => void;
};

const DraftReviewContext = createContext<DraftReviewContextValue | null>(null);

export function DraftReviewBoundary({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

/**
 * The presented document's review, shared across Editor and dock hosts.
 * Surfaces outside the presenting host's boundary read this value for focus
 * and presentation. Work-bound commands remain independent of this review.
 */
const PresentedReviewContext = createContext<DraftReviewContextValue | null>(null);

export function PresentedReviewScope({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return (
    <PresentedReviewContext.Provider value={value}>{children}</PresentedReviewContext.Provider>
  );
}

/**
 * The presented document's review; falls back to the ambient draft-review
 * scope when no presented scope is offered.
 */
export function usePresentedDraftReview(): DraftReviewContextValue {
  const presented = useContext(PresentedReviewContext);
  const ambient = useContext(DraftReviewContext);
  const value = presented ?? ambient;
  if (!value) {
    throw new Error(
      "usePresentedDraftReview must be used within a presented or draft review scope",
    );
  }
  return value;
}

export function useDraftReviewScopeValue({
  projectId,
  work,
  stateOwner,
  threadId = null,
  presented,
}: {
  projectId: string | null;
  /** The Work whose drafts this scope reviews; its archived state freezes them (D30). */
  work: Work | null;
  stateOwner?: DraftReviewStateOwner;
  presented?: PresentedDocument | null;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
}): DraftReviewContextValue {
  const workId = work?.id ?? null;
  const queryClient = useQueryClient();
  const effectiveProjectId = projectId ?? "";
  // Empty keys belong only to disabled queries; every ready Editor uses its Work row id.
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const files = drafts.files ?? [];
  const localStateOwner = useDraftReviewStateOwner();
  const reviewState = stateOwner ?? localStateOwner;
  const scope = useRef({ projectId: effectiveProjectId, workId: effectiveWorkId, queryClient });
  const scopeChanged =
    scope.current.projectId !== effectiveProjectId ||
    scope.current.workId !== effectiveWorkId ||
    scope.current.queryClient !== queryClient;
  const controller = useDraftReviewController({
    projectId: effectiveProjectId,
    work,
    threadId,
    stateOwner: scopeChanged ? { ...reviewState, state: EMPTY_DRAFT_REVIEW_STATE } : reviewState,
  });
  const roomOwner = useReviewRoomOwner({
    projectId: effectiveProjectId,
    workId: effectiveWorkId,
    review: controller.inlineReview,
    dispatch: reviewState.dispatch,
    disposing: controller.isDisposing,
    presented,
  });
  useReconcileReviewFocus(controller);

  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorProjection, setActiveEditorProjection] = useState<{
    documentId: string;
    session: DocumentSession | null;
    inReview: boolean;
    owner: object | null;
  } | null>(null);
  const activeEditorDocumentId = activeEditorProjection?.documentId ?? null;
  const setActiveEditorDocumentId = useCallback(
    (
      documentId: string | null,
      session: DocumentSession | null = null,
      inReview = false,
      owner: object | null = null,
    ) => {
      setActiveEditorProjection((current) => {
        if (documentId) return { documentId, session, inReview, owner };
        return owner && current?.owner !== owner ? current : null;
      });
    },
    [],
  );

  useLayoutEffect(() => {
    scope.current = { projectId: effectiveProjectId, workId: effectiveWorkId, queryClient };
    controller.exitReview();
  }, [effectiveProjectId, effectiveWorkId, queryClient, controller.exitReview]);

  const fileForDocument = drafts.fileForDocument;

  const reviewRoomNameForDraft = useCallback(
    (documentId: string, draftId: string) =>
      controller.inlineReview?.documentId === documentId &&
      controller.inlineReview.draftId === draftId
        ? controller.reviewRoomName
        : null,
    [controller.inlineReview, controller.reviewRoomName],
  );

  useReviewRefresh({
    projectId,
    workId,
    review: controller.inlineReview,
    session: roomOwner.session,
    liveSession:
      activeEditorProjection?.documentId === controller.inlineReview?.documentId
        ? (activeEditorProjection?.session ?? null)
        : null,
  });

  useEffect(() => {
    if (!threadId || !activeEditorProjection || activeEditorProjection.inReview) return;
    const session = activeEditorProjection.session;
    if (!session) return;
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
  }, [activeEditorProjection, queryClient, threadId]);

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      roomOwner,
      files,
      drafts,
      fileForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [
      controller,
      roomOwner,
      files,
      drafts,
      fileForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
    ],
  );

  return value;
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewBoundary");
  }
  return value;
}
