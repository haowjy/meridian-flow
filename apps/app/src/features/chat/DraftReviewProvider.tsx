/** Draft-review scope ownership and the boundary that exposes one scope to consumers. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
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
import {
  contextCatalogQueryOptions,
  contextCatalogScope,
  projectCatalogView,
} from "@/client/query/useContextCatalog";
import {
  type ThreadDraftGroup,
  type ThreadDraftsStatus,
  useWorkDrafts,
} from "@/client/query/useWorkDrafts";
import { getContextTabs } from "@/client/stores";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
import {
  usePostApplyAccountId,
  usePostApplyDispositionOwner,
  usePostApplySnapshot,
} from "@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider";
import { projectPostApplyDraftGroups } from "@/features/project/draft-apply-recovery/draft-group-projections";
import {
  type DraftReviewController,
  type DraftReviewStateOwner,
  useDraftReviewController,
} from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  serverActiveGroups: ThreadDraftGroup[];
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

export type DraftReviewProviderProps = {
  projectId: string | null;
  workId: string | null;
  owningWorkLabel?: string | null;
  stateOwner?: DraftReviewStateOwner;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
  children: ReactNode;
};

export function DraftReviewProvider({
  projectId,
  workId,
  owningWorkLabel = null,
  stateOwner,
  threadId = null,
  children,
}: DraftReviewProviderProps) {
  const value = useDraftReviewScopeValue({
    projectId,
    workId,
    owningWorkLabel,
    stateOwner,
    threadId,
  });
  return <DraftReviewBoundary value={value}>{children}</DraftReviewBoundary>;
}

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
  workId,
  owningWorkLabel = null,
  stateOwner,
  threadId = null,
}: Omit<DraftReviewProviderProps, "children">): DraftReviewContextValue {
  return useDraftReviewScopeOwner(projectId, workId, owningWorkLabel ?? null, threadId, stateOwner);
}

function useDraftReviewScopeOwner(
  projectId: string | null,
  workId: string | null,
  owningWorkLabel: string | null,
  threadId: string | null,
  stateOwner?: DraftReviewStateOwner,
): DraftReviewContextValue {
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const dispositionOwner = usePostApplyDispositionOwner();
  const dispositionSnapshot = usePostApplySnapshot();
  const accountId = usePostApplyAccountId();
  const registry = useLiveDocumentSessionRegistry();
  const reviewProjectionOwner = useRef(
    `draft-review-projection:${++reviewProjectionOwnerSequence}`,
  );
  const effectiveProjectId = projectId ?? "";
  const effectiveWorkId = workId ?? "";
  const drafts = useWorkDrafts(projectId, workId);
  const rawGroups = drafts.groups ?? [];
  const projections = useMemo(
    () =>
      projectPostApplyDraftGroups(
        rawGroups,
        dispositionSnapshot,
        accountId,
        projectId ?? "",
        workId ?? "",
      ),
    [accountId, dispositionSnapshot, projectId, rawGroups, workId],
  );
  const serverActiveGroups = projections.serverActiveGroups ?? [];
  const groups = projections.commandEligibleGroups ?? [];
  const controller = useDraftReviewController(
    effectiveProjectId,
    effectiveWorkId,
    threadId,
    owningWorkLabel,
    stateOwner,
  );

  useEffect(() => {
    if (!projectId || !workId || (drafts.status !== "ready" && drafts.status !== "empty")) return;
    const tabs = getContextTabs(projectId).tabs;
    dispositionOwner.reconcileForcedDraftList({
      accountId,
      projectId,
      workId,
      activeDrafts: (drafts.drafts ?? []).map((draft) => {
        const tab = tabs.find((candidate) => candidate.documentId === draft.documentId);
        return {
          identity: {
            accountId,
            projectId,
            workId,
            documentId: draft.documentId,
            draftId: draft.draftId,
          },
          presentation: {
            documentName: draft.documentName,
            contextPath: draft.contextPath,
            owningWorkLabel,
          },
          obligations: {
            draftTab:
              draft.isNewDocument &&
              tab?.kind === "tracked" &&
              tab.draftOnly &&
              tab.reviewWorkId === workId &&
              tab.reviewDraftId === draft.draftId &&
              tab.tabInstanceToken
                ? {
                    kind: "draft-only" as const,
                    reviewWorkId: workId,
                    reviewDraftId: draft.draftId,
                    tabInstanceToken: tab.tabInstanceToken,
                  }
                : { kind: "none" as const },
            branch:
              controller.inlineReview?.draftId === draft.draftId && controller.reviewRoomName
                ? {
                    kind: "generation-qualified" as const,
                    reviewRoomName: controller.reviewRoomName,
                  }
                : { kind: "none" as const },
          },
        };
      }),
    });
  }, [
    accountId,
    controller.inlineReview?.draftId,
    controller.reviewRoomName,
    dispositionOwner,
    drafts.drafts,
    drafts.status,
    projectId,
    owningWorkLabel,
    workId,
  ]);
  // Editor-host concern: this only tells the chat overlay whether the active
  // editor already renders the docked bar for a document. Review-mode truth
  // itself lives in the controller state machine.
  const [activeEditorProjection, setActiveEditorProjection] = useState<{
    documentId: string;
    session: DocumentSession;
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
        if (documentId && session) return { documentId, session, inReview, owner };
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

  useEffect(() => {
    const activeSelection = controller.inlineReview;
    if (!activeSelection || (drafts.status !== "ready" && drafts.status !== "empty")) return;
    const matchingIdentity = (identity: {
      accountId: string;
      projectId: string;
      workId: string;
      documentId: string;
      draftId: string;
    }) =>
      identity.accountId === accountId &&
      identity.projectId === projectId &&
      identity.workId === workId &&
      identity.documentId === activeSelection.documentId &&
      identity.draftId === activeSelection.draftId;
    if (
      dispositionSnapshot.reservations.some((item) => matchingIdentity(item.identity)) ||
      dispositionSnapshot.items.some((item) => matchingIdentity(item.identity))
    )
      return;
    if (
      dispositionSnapshot.appliedSuppressions.some(
        (item) => matchingIdentity(item.identity) && item.terminalDisposition,
      )
    ) {
      controller.exitReview();
      return;
    }
    const activeDrafts = drafts.drafts ?? rawGroups.flatMap((group) => group.drafts);
    if (
      activeDrafts.some(
        (draft) =>
          draft.documentId === activeSelection.documentId &&
          draft.draftId === activeSelection.draftId,
      )
    )
      return;
    if (!projectId || !workId) {
      controller.exitReview();
      return;
    }
    const tab = getContextTabs(projectId).tabs.find(
      (candidate) => candidate.documentId === activeSelection.documentId,
    );
    if (
      tab?.kind !== "tracked" ||
      !tab.draftOnly ||
      tab.reviewWorkId !== workId ||
      tab.reviewDraftId !== activeSelection.draftId ||
      !tab.tabInstanceToken
    )
      controller.exitReview();
  }, [
    accountId,
    controller.exitReview,
    controller.inlineReview,
    dispositionSnapshot.appliedSuppressions,
    dispositionSnapshot.items,
    dispositionSnapshot.reservations,
    drafts.drafts,
    drafts.status,
    projectId,
    rawGroups,
    workId,
  ]);

  useEffect(() => {
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    if (controller.isDisposing) return;
    if (!projectId || !workId) {
      return;
    }
    const tabs = getContextTabs(projectId).tabs;
    const activeDrafts = drafts.drafts ?? rawGroups.flatMap((group) => group.drafts);
    const candidates = dispositionSnapshot.remoteDraftWitnesses.flatMap((witness) => {
      if (
        witness.identity.accountId !== accountId ||
        witness.identity.projectId !== projectId ||
        witness.identity.workId !== workId ||
        activeDrafts.some(
          (draft) =>
            draft.documentId === witness.identity.documentId &&
            draft.draftId === witness.identity.draftId,
        )
      )
        return [];
      const tab = tabs.find((candidate) => candidate.documentId === witness.identity.documentId);
      if (
        tab?.kind !== "tracked" ||
        !tab.draftOnly ||
        tab.reviewWorkId !== workId ||
        tab.reviewDraftId !== witness.identity.draftId ||
        !tab.tabInstanceToken
      )
        return [];
      return [{ witness, tab }];
    });
    if (candidates.length === 0) return;

    // The active-only list cannot say why a remote disposition removed the
    // draft. The account witness survives provider replacement, so every
    // returned scope classifies its exact absent draft-created rows rather than
    // tying recovery to whichever row happens to be selected inline.
    const treeQuery = contextCatalogQueryOptions(
      queryClient,
      projectId,
      contextCatalogScope(projectId, "manuscript", null),
    );
    const attempt = new AbortController();
    void queryClient
      .cancelQueries({ queryKey: treeQuery.queryKey })
      .then(() => queryClient.fetchQuery({ ...treeQuery, staleTime: 0 }))
      .then((view) => {
        if (attempt.signal.aborted) return;
        const catalog = projectCatalogView(projectId, "manuscript", view);
        const currentTabs = getContextTabs(projectId).tabs;
        const currentDrafts =
          queryClient.getQueryData<ThreadDraftListItem[]>(
            projectQueryKeys.workDrafts(projectId, workId),
          ) ?? [];
        for (const { witness } of candidates) {
          if (
            currentDrafts.some(
              (draft) =>
                draft.documentId === witness.identity.documentId &&
                draft.draftId === witness.identity.draftId,
            )
          )
            continue;
          const currentTab = currentTabs.find(
            (candidate) => candidate.documentId === witness.identity.documentId,
          );
          if (
            currentTab?.kind !== "tracked" ||
            !currentTab.draftOnly ||
            currentTab.reviewWorkId !== workId ||
            currentTab.reviewDraftId !== witness.identity.draftId ||
            !currentTab.tabInstanceToken
          )
            continue;
          const witnessRef = {
            identity: witness.identity,
            witnessVersion: witness.witnessVersion,
          };
          if (catalog.findDocument(witness.identity.documentId)) {
            dispositionOwner.recordServerApplied({
              kind: "remote-new-document-manifest",
              witness: witnessRef,
              confirmedAbsent: true,
              manifestDocumentId: witness.identity.documentId,
              currentDraftTab: {
                kind: "draft-only",
                reviewWorkId: workId,
                reviewDraftId: currentTab.reviewDraftId,
                tabInstanceToken: currentTab.tabInstanceToken,
              },
            });
            continue;
          }
          if (
            dispositionOwner.discardRemoteDraftWitness({
              witness: witnessRef,
              evidence: "manifest-proven-discard",
            })
          ) {
            if (
              controller.inlineReview?.documentId === witness.identity.documentId &&
              controller.inlineReview.draftId === witness.identity.draftId
            )
              controller.exitReview();
            void contextRemoval.discardDraft(projectId, workId, witness.identity.documentId);
          }
        }
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
    return () => attempt.abort();
  }, [
    contextRemoval,
    dispositionOwner,
    dispositionSnapshot.remoteDraftWitnesses,
    controller.exitReview,
    controller.inlineReview,
    controller.isDisposing,
    drafts.status,
    accountId,
    drafts.drafts,
    projectId,
    queryClient,
    rawGroups,
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
      serverActiveGroups,
      groups,
      drafts,
      groupForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
      setActiveEditorDocumentId,
    }),
    [
      controller,
      serverActiveGroups,
      groups,
      drafts,
      groupForDocument,
      reviewRoomNameForDraft,
      activeEditorDocumentId,
    ],
  );

  return value;
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewProvider");
  }
  return value;
}
