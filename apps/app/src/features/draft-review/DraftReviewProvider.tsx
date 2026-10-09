/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { Work } from "@meridian/contracts/works";
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
import { contextCatalogScope, projectCatalogView } from "@/client/query/useContextCatalog";
import { type ThreadDraftsStatus, useWorkDrafts } from "@/client/query/useWorkDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { type ContextTab, getContextTabs } from "@/client/stores";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  useContextRemovalCoordinator,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import {
  type DraftReviewController,
  type DraftReviewStateOwner,
  useDraftReviewController,
} from "./useDraftReviewController";
import { useReconcileReviewFocus } from "./useReconcileReviewFocus";
import { useCachedProposal } from "./useReviewGeneration";
import { useReviewRefresh } from "./useReviewRefresh";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
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
 * Chat's boundary; reading the ambient controller there showed a review that
 * was never open.
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
}: {
  projectId: string | null;
  /** The Work whose drafts this scope reviews; its archived state freezes them (D30). */
  work: Work | null;
  stateOwner?: DraftReviewStateOwner;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
}): DraftReviewContextValue {
  const workId = work?.id ?? null;
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const contextRemoval = useContextRemovalCoordinator();
  const effectiveProjectId = projectId ?? "";
  // Empty keys belong only to disabled queries; every ready Editor uses its Work row id.
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const files = drafts.files ?? [];
  const controller = useDraftReviewController({
    projectId: effectiveProjectId,
    work,
    threadId,
    stateOwner,
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

  useEffect(() => {
    controller.exitReview();
  }, [effectiveProjectId, effectiveWorkId, controller.exitReview]);

  const fileForDocument = drafts.fileForDocument;

  const reviewRoomNameForDraft = useCallback(
    (documentId: string, draftId: string) =>
      controller.inlineReview?.documentId === documentId &&
      controller.inlineReview.draftId === draftId
        ? controller.reviewRoomName
        : null,
    [controller.inlineReview, controller.reviewRoomName],
  );

  // The reviewed draft left the active list (applied or discarded elsewhere).
  // The list and the preview are separate reads and either can lag the other, so
  // the list's silence is not decided here: the reducer weighs it against the
  // generation the review shows and the newest preview (row X). A preview that
  // lists changes says the draft is alive; it is read again, and the next read
  // either confirms it or ends the review.
  const reviewedDocumentId = controller.inlineReview?.documentId ?? "";
  const reviewedDraftId = controller.inlineReview?.draftId ?? "";
  // The writer handled the last change: the draft leaving the list is the
  // result they just caused, and the review stays open to say so.
  const reviewHandled = controller.inlineReview?.completion !== undefined;
  const cachedProposal = useCachedProposal({
    projectId: effectiveProjectId,
    workId: effectiveWorkId,
    documentId: reviewedDocumentId,
    draftId: reviewedDraftId,
  });
  useEffect(() => {
    if (!reviewedDraftId || reviewHandled || controller.isDisposing) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const stillActive = (drafts.drafts ?? []).some(
      (draft) => draft.documentId === reviewedDocumentId && draft.draftId === reviewedDraftId,
    );
    if (stillActive) return;
    controller.reviewDraftAbsentFromList(reviewedDocumentId, reviewedDraftId, cachedProposal);
    if (cachedProposal?.proposal) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          effectiveProjectId,
          effectiveWorkId,
          reviewedDocumentId,
          reviewedDraftId,
        ),
      });
    }
  }, [
    controller.reviewDraftAbsentFromList,
    reviewedDocumentId,
    reviewedDraftId,
    reviewHandled,
    controller.isDisposing,
    drafts.drafts,
    drafts.status,
    cachedProposal,
    effectiveProjectId,
    effectiveWorkId,
    queryClient,
  ]);

  // A draft-only tab whose draft left the active list was disposed of
  // elsewhere. The list cannot say how, so the catalog decides: a document
  // that now exists was applied, otherwise the draft was discarded.
  useEffect(() => {
    if (!resources || !projectId || !workId || controller.isDisposing) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (tab: ContextTab, activeDrafts: readonly ThreadDraftListItem[]) =>
      tab.kind === "tracked" &&
      tab.draftOnly &&
      tab.reviewWorkId === workId &&
      !activeDrafts.some((draft) => draft.draftId === tab.reviewDraftId);
    const activeDrafts = drafts.drafts ?? [];
    if (!getContextTabs(projectId).tabs.some((tab) => isOrphan(tab, activeDrafts))) return;

    const scope = contextCatalogScope(projectId, "manuscript", null) ?? {
      kind: "project" as const,
      projectId,
    };
    const attempt = new AbortController();
    // A catalog observation that starts now: joining an older in-flight one
    // could report the pre-Apply tree and misread a remote Apply as a Discard.
    void resources
      .acquireCatalogAfter(projectId, scope)
      .then((view) => {
        if (attempt.signal.aborted) return;
        queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, scope), view);
        const catalog = projectCatalogView(projectId, "manuscript", view);
        const currentDrafts =
          queryClient.getQueryData<ThreadDraftListItem[]>(
            projectQueryKeys.workDrafts(projectId, workId),
          ) ?? [];
        for (const tab of getContextTabs(projectId).tabs) {
          if (tab.kind !== "tracked" || !isOrphan(tab, currentDrafts)) continue;
          if (catalog.findDocument(tab.documentId)) {
            void contextRemoval.promoteAppliedDraft(projectId, tab);
            continue;
          }
          const draftId = tab.reviewDraftId;
          if (!draftId) continue;
          if (
            controller.inlineReview?.documentId === tab.documentId &&
            controller.inlineReview.draftId === draftId
          )
            controller.exitReview();
          contextRemoval.discardDraft(projectId, workId, tab.documentId, draftId);
        }
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
    return () => attempt.abort();
  }, [
    contextRemoval,
    controller.exitReview,
    controller.inlineReview,
    controller.isDisposing,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  useReviewRefresh({
    projectId,
    workId,
    review: controller.inlineReview,
    roomName: controller.reviewRoomName,
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
      files,
      drafts,
      fileForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [controller, files, drafts, fileForDocument, reviewRoomNameForDraft, activeEditorDocumentId],
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
