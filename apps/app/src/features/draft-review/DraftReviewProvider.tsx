/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type OwnerDraftListStatus, useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { DocumentSession } from "@/core/editor/document-session";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { EMPTY_DRAFT_REVIEW_STATE } from "./draft-review-session";
import {
  type DraftReviewController,
  useDraftReviewController,
  useDraftReviewStateOwner,
} from "./useDraftReviewController";
import { useReviewRefresh } from "./useReviewRefresh";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  files: ReviewFileTarget[];
  drafts: OwnerDraftListStatus;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  activeEditorDocumentId: string | null;
  /** Returns the host's document to Live: its view, not the review, decides what paints. */
  showLive: () => void;
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

export function useDraftReviewScopeValue({
  projectId,
  work,
  ownerKey,
  threadId = null,
  marks,
  showLive,
}: {
  projectId: string | null;
  /** The Work whose archived state freezes these drafts. */
  work: Work | null;
  /** Whose drafts this scope reviews: `work:<id>` or `lineage:<root>`; "" scopes nothing. */
  ownerKey: string;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
  /** The host document's Show changes. */
  marks: { visible: boolean; set: (visible: boolean) => void };
  showLive: () => void;
}): DraftReviewContextValue {
  const queryClient = useQueryClient();
  const effectiveProjectId = projectId ?? "";
  const drafts = useOwnerDrafts(projectId, ownerKey || null);
  const files = drafts.files ?? [];
  const reviewState = useDraftReviewStateOwner();
  const scope = useRef({ projectId: effectiveProjectId, ownerKey, queryClient });
  const scopeChanged =
    scope.current.projectId !== effectiveProjectId ||
    scope.current.ownerKey !== ownerKey ||
    scope.current.queryClient !== queryClient;
  const controller = useDraftReviewController({
    projectId: effectiveProjectId,
    work,
    ownerKey,
    threadId,
    stateOwner: scopeChanged ? { ...reviewState, state: EMPTY_DRAFT_REVIEW_STATE } : reviewState,
    marks,
  });
  // A draft a press has in flight leaves the review.
  const commands = useDraftCommandOwner();
  const reviewItemKey = controller.inlineReview?.itemKey ?? "";
  const leaves = () => commands.state(reviewItemKey).hidden;
  const leaving = useSyncExternalStore(commands.subscribe, leaves, leaves);
  const { dispatch } = reviewState;
  useLayoutEffect(() => {
    if (reviewItemKey && leaving) dispatch({ type: "exitInline" });
  }, [leaving, reviewItemKey, dispatch]);

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

  // Only a real change of scope ends the review. A run with the same scope (a mount, React's
  // development re-run) would end a review admission entered since, and admission doesn't retry.
  useLayoutEffect(() => {
    const previous = scope.current;
    scope.current = { projectId: effectiveProjectId, ownerKey, queryClient };
    if (
      previous.projectId !== effectiveProjectId ||
      previous.ownerKey !== ownerKey ||
      previous.queryClient !== queryClient
    )
      controller.exitReview();
  }, [effectiveProjectId, ownerKey, queryClient, controller.exitReview]);

  const fileForDocument = drafts.fileForDocument;

  useReviewRefresh({
    projectId,
    ownerKey: ownerKey || null,
    review: controller.inlineReview,
    liveSession:
      !activeEditorProjection?.inReview &&
      activeEditorProjection?.documentId === controller.inlineReview?.documentId
        ? (activeEditorProjection?.session ?? null)
        : null,
  });

  const value = useMemo<DraftReviewContextValue>(
    () => ({
      controller,
      files,
      drafts,
      fileForDocument,
      activeEditorDocumentId,
      showLive,
      setActiveEditorDocumentId,
    }),
    [
      showLive,
      controller,
      files,
      drafts,
      fileForDocument,
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
