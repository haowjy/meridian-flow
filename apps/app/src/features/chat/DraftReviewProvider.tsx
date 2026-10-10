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
  useRef,
  useState,
} from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { contextCatalogScope, projectCatalogView } from "@/client/query/useContextCatalog";
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { type ContextTab, getContextTabs } from "@/client/stores";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import {
  type DraftReviewController,
  type DraftReviewStateOwner,
  useDraftReviewController,
} from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  groups: ThreadDraftGroup[];
  drafts: ThreadDraftsStatus;
  groupForDocument: (documentId: string | null | undefined) => ThreadDraftGroup | null;
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
let reviewProjectionOwnerSequence = 0;

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
  const registry = useLiveDocumentSessionRegistry();
  const reviewProjectionOwner = useRef(
    `draft-review-projection:${++reviewProjectionOwnerSequence}`,
  );
  const effectiveProjectId = projectId ?? "";
  // Empty keys belong only to disabled queries; every ready Editor uses its Work row id.
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const groups = drafts.groups ?? [];
  const controller = useDraftReviewController({
    projectId: effectiveProjectId,
    work,
    threadId,
    stateOwner,
  });

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

  // The reviewed draft left the active list (applied or discarded elsewhere):
  // there is nothing left to review. A local disposition ends review itself.
  useEffect(() => {
    const selection = controller.inlineReview;
    if (!selection || controller.isDisposing) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const stillActive = (drafts.drafts ?? groups.map((group) => group.draft)).some(
      (draft) => draft.documentId === selection.documentId && draft.draftId === selection.draftId,
    );
    if (!stillActive) controller.exitReview();
  }, [
    controller.exitReview,
    controller.inlineReview,
    controller.isDisposing,
    drafts.drafts,
    drafts.status,
    groups,
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
    const activeDrafts = drafts.drafts ?? groups.map((group) => group.draft);
    if (!getContextTabs(projectId).tabs.some((tab) => isOrphan(tab, activeDrafts))) return;

    const scope = contextCatalogScope(projectId, "manuscript", { workId: null }) ?? {
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
    groups,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  useEffect(() => {
    const inlineDocumentId = controller.inlineReview?.documentId;
    const inlineDraftId = controller.inlineReview?.draftId;
    const roomKey = controller.reviewRoomName;
    if (!projectId || !workId || !inlineDocumentId || !inlineDraftId || !roomKey) return;
    registry.retainBranchRooms(reviewProjectionOwner.current, [roomKey]);
    let session: DocumentSession;
    try {
      session = registry.getBranchRoom(roomKey);
    } catch (error) {
      registry.releaseBranchRooms(reviewProjectionOwner.current);
      throw error;
    }
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
      registry.releaseBranchRooms(reviewProjectionOwner.current);
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
    throw new Error("useDraftReview must be used within DraftReviewBoundary");
  }
  return value;
}
