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
 * The Editor scope's review, offered to surfaces that live outside the Editor's
 * boundary. A review runs in the Editor's scope (its controller owns the open
 * draft and its commands), but the dock that lists its changes sits in the
 * Chat's boundary; the shared Editor value supplies focus and presentation only.
 * Work-bound commands are independent of this review.
 */
const EditorReviewContext = createContext<DraftReviewContextValue | null>(null);

export function EditorReviewScope({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return <EditorReviewContext.Provider value={value}>{children}</EditorReviewContext.Provider>;
}

/**
 * The review of the Editor the writer is working in; falls back to the ambient
 * scope when no Editor scope is offered. The Work page has no ambient scope of
 * its own, so the Editor's is read first and the ambient one only when it is absent.
 */
export function useEditorDraftReview(): DraftReviewContextValue {
  const editor = useContext(EditorReviewContext);
  const ambient = useContext(DraftReviewContext);
  const value = editor ?? ambient;
  if (!value) {
    throw new Error("useEditorDraftReview must be used within an Editor or draft review scope");
  }
  return value;
}

export function useDraftReviewScopeValue({
  projectId,
  work,
  stateOwner,
  threadId = null,
  draftOnly = false,
}: {
  projectId: string | null;
  /** The Work whose drafts this scope reviews; its archived state freezes them (D30). */
  work: Work | null;
  stateOwner?: DraftReviewStateOwner;
  draftOnly?: boolean;
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
    draftOnly,
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
