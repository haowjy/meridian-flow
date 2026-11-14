/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import { draftOwnerKey, parseDraftItemKey } from "@meridian/contracts";
import type { DraftOwnerKey } from "@meridian/contracts/branches";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useRouter, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getProjectDocumentAddress } from "@/client/api/projects-api";
import { type DraftPin, endPin } from "@/client/project-shell/document-views";
import type { ContextOwner } from "@/client/query/context-request-options";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { fetchCurrentDraftMetadata, useDraftMetadata } from "@/client/query/useDraftMetadata";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { type TreeViewResult, useProjectTreeViews } from "@/client/query/useProjectTree";
import { projectWorkBranchFiles } from "@/client/query/work-branch-files";
import { isEditorScheme } from "@/client/stores";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import { parseContextUri } from "@/lib/context-uri";
import { originalBrowserSearch } from "@/router-search";
import {
  useDraftCommandOwner,
  useOptionalDraftOnlyPresentations,
  useOptionalPresentedDocuments,
} from "../context/account-feature-context";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { useRemovalRecord } from "../context/use-removal-record";
import { ProjectView } from "../ProjectView";
import { useWorkScopeState } from "../use-work-scope";
import { ChatNavigationProvider, useProjectChatNavigation } from "./chat-navigation";
import {
  addressReviewOwner,
  bindDocumentAddressReview,
  documentAddressQueryOptions,
  reviewBoundAddressResult,
} from "./document-address-review";
import { createEditorDocumentCommand, prepareEditorDestination } from "./editor-document-command";
import {
  canonicalDocumentPath,
  draftOnlyTarget,
  resolveReplayAddress,
} from "./local-document-address";
import {
  type AddressAdmission,
  addressedDocument,
  ProjectAddressDocument,
} from "./ProjectAddressDocument";
import { ProjectNavigationProvider, type TrashNavigation } from "./ProjectNavigationContext";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import {
  addressLineage,
  addressScratchWorkId,
  type ProjectAddress,
  type ProjectDestination,
  parseProjectAddress,
  withoutReview,
} from "./project-address";
import {
  createProjectNavigation,
  type NavigationSettlement,
  type PreparedWorkspaceNavigation,
} from "./project-navigation";
import {
  type ContextRouteRequest,
  contextRouteRequest,
  type NavigationOptions,
  type ProjectRouteCommands,
  type ProjectSearch,
} from "./project-route";
import { routePlaceKey, useRouteDocument } from "./use-route-document";

type ReadableProjectRouteProps = {
  project: Project;
  entryHydration: WorkingSetHydrationPlan;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
};
const NO_TREE: TreeViewResult = { tree: null, isComplete: false, isError: false };

export function ReadableProjectRoute({ project, entryHydration, user }: ReadableProjectRouteProps) {
  const projectId = project.id;
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const parsed = parseProjectAddress(location.pathname, originalBrowserSearch(location.search));
  const address: ProjectAddress =
    parsed.kind === "valid"
      ? parsed.address
      : {
          projectId: project.id,
          destination: { kind: "new-chat" },
        };
  const destination = address.destination;
  const [navigation, setNavigation] = useState<ReturnType<typeof createProjectNavigation> | null>(
    null,
  );
  const chat = useProjectChatNavigation({
    accountId: user.userId,
    projectId,
    mainChat:
      destination.kind === "chat"
        ? { kind: "thread", threadId: destination.chatId }
        : destination.kind === "new-chat"
          ? { kind: "new" }
          : destination.kind === "chat-recents"
            ? { kind: "chat-recents" }
            : null,
    go: (next, options) => go(toDestination(next), options),
  });
  // The Work scope is stored, never read from the address: a Work-scoped page lens, not a place.
  const editorScope = useWorkScopeState(projectId);
  const workId = editorScope.workId;
  const presented = useOptionalPresentedDocuments();
  const draftOnlyDocuments = useOptionalDraftOnlyPresentations();
  useBlocker({
    shouldBlockFn: async () => (navigation ? !(await navigation.allowDeparture()) : false),
    enableBeforeUnload: () => navigation?.hasUnsavedChanges() ?? false,
  });
  useLayoutEffect(() => {
    const coordinator = createProjectNavigation({
      read: () => ({
        href: router.history.location.href,
        key: router.history.location.state.__TSR_key ?? "",
        state: { ...router.history.location.state },
      }),
      subscribe: (listener) => router.history.subscribe(listener),
      flush: () => router.history.flush(),
      settlePendingTraversal: () => router.history.settlePendingTraversal(),
      replaceEntry: (href, state) => {
        // Same-entry repairs must not restore the pre-jump scroll over an editor-owned destination.
        void router.navigate({
          href,
          state,
          replace: true,
          resetScroll: false,
          ignoreBlocker: true,
        });
      },
      navigate: (href, options) =>
        router.navigate({
          href,
          replace: options.replace,
          state: options.state,
          ignoreBlocker: true,
        }),
    });
    setNavigation(coordinator);
    return () => coordinator.dispose();
  }, [router]);
  useEffect(() => {
    if (!navigation || parsed.kind !== "valid") return;
    const ticket = navigation.captureForEntry(location.state.__TSR_key ?? "");
    if (!ticket) return;
    navigation.repairAddress(ticket);
  }, [navigation, location]);

  // Where a document is now, in any source: places a review launch's document and follows a moved one.
  const launchTrees = useProjectTreeViews(projectId, CONTEXT_URI_SCHEMES, { workId });
  const documentTree = useMemo(
    () => ({
      findDocument: (id: string) =>
        CONTEXT_URI_SCHEMES.map((scheme) => launchTrees[scheme].tree?.findDocument(id)).find(
          (file) => file != null,
        ) ?? null,
    }),
    [launchTrees],
  );
  const latest = useRef({
    address,
    location,
    navigation,
    editorWorkId: workId,
    documentTree,
  });
  latest.current = {
    address,
    location,
    navigation,
    editorWorkId: workId,
    documentTree,
  };
  // The document the address resolved to: a review of it stays on this address
  // through a rename, whatever path the launcher read.
  const addressDocumentIdRef = useRef<string | undefined>(undefined);
  const captureNavigation = useCallback(() => {
    const current = latest.current.navigation;
    const ticket = current?.beginIntent();
    return () => !!ticket && !!current?.isCurrent(ticket);
  }, []);

  // A scheme the Editor never opens (Uploads) shows in its resource view.
  const resourceDestination =
    destination.kind === "document" && !isEditorScheme(destination.scheme);
  const documentDestination =
    destination.kind === "document" && !resourceDestination ? destination : null;
  // A Scratch address names its own owner, whatever the scope: a chat's lineage, else a Work.
  const lineage = addressLineage(address);
  // The owner a locator carries is a Scratch note's alone; the scope never is one.
  const scratchWork = addressScratchWorkId(address);
  const locatorOwner: { workId?: string; rootThreadId?: string } =
    documentDestination?.scheme === "scratch"
      ? lineage
        ? { rootThreadId: lineage }
        : scratchWork
          ? { workId: scratchWork }
          : {}
      : {};
  const addressOwner: ContextOwner =
    documentDestination?.scheme !== "scratch"
      ? { workId: null }
      : contextOwner(scratchWork ?? null, lineage);
  const addressSchemes = useMemo(
    () => (documentDestination ? [documentDestination.scheme] : []),
    [documentDestination?.scheme],
  );
  const addressTrees = useProjectTreeViews(projectId, addressSchemes, {
    workId: addressOwner.workId,
    rootThreadId: addressOwner.rootThreadId,
    enabled: !!documentDestination,
  });
  const addressTree: TreeViewResult = documentDestination
    ? addressTrees[documentDestination.scheme]
    : NO_TREE;
  const reviewOwner = addressReviewOwner(address, workId);
  const addressBinding = bindDocumentAddressReview(address.itemKey, reviewOwner);
  const [admission, setAdmission] = useState<AddressAdmission | null>(null);
  const documentLookup = useQuery(
    documentAddressQueryOptions(
      {
        projectId,
        destination: documentDestination,
        owner: addressOwner,
        binding: addressBinding,
      },
      getProjectDocumentAddress,
    ),
  );
  // Keep the authoritative draft read above address admission: catalog invalidation can
  // unmount the editor before its terminal room frame arrives.
  const closingDocumentId = address.itemKey ? parseDraftItemKey(address.itemKey)?.documentId : null;
  const closingRef =
    closingDocumentId && address.itemKey && reviewOwner
      ? {
          projectId,
          ownerKey: reviewOwner,
          documentId: closingDocumentId,
          itemKey: address.itemKey,
        }
      : null;
  const closeMetadata = useDraftMetadata(closingRef ? [closingRef] : [])[0];
  const draftCommands = useDraftCommandOwner();
  const closeSnapshot = () => {
    const state = draftCommands.state(address.itemKey ?? "");
    return JSON.stringify([state.closed, state.removed, state.checkingClose, state.liveUri]);
  };
  useSyncExternalStore(draftCommands.subscribe, closeSnapshot, closeSnapshot);
  const closeState = draftCommands.state(address.itemKey ?? "");
  useLayoutEffect(() => {
    if (closingRef && closeMetadata?.data?.status === "gone")
      void draftCommands.metadataGone(closingRef);
  }, [draftCommands, closingRef?.itemKey, closeMetadata?.dataUpdatedAt]);
  useEffect(() => {
    if (closingRef && documentLookup.data?.kind === "unavailable") void closeMetadata?.refetch();
  }, [closingRef?.itemKey, documentLookup.dataUpdatedAt]);
  // A review's item names its document; a plain address is the document it last resolved.
  const routePlace = routePlaceKey(documentDestination, locatorOwner);
  const routeDocument = useRouteDocument(routePlace);
  const boundDocumentId = address.itemKey ? (closingDocumentId ?? null) : routeDocument.documentId;
  // A plain address is resolved by the replay alone; the server answers a review's.
  const replayAddress = useMemo(
    () =>
      documentDestination && addressBinding.kind === "plain"
        ? resolveReplayAddress({
            projectId,
            accountId: user.userId,
            destination: documentDestination,
            workId: addressOwner.workId ?? null,
            rootThreadId: addressOwner.rootThreadId ?? null,
            tree: addressTree,
            boundDocumentId,
          })
        : undefined,
    [
      addressTree,
      addressBinding.kind,
      documentDestination,
      addressOwner.workId,
      addressOwner.rootThreadId,
      projectId,
      user.userId,
      boundDocumentId,
    ],
  );
  // Discarding a draft's move leaves the review address cached at the destination it named;
  // the server answers the live path once the metadata shows the move is gone. Review answers
  // are dropped with their key (`documentAddressQueryOptions`), so only the visible one is stale.
  const queryClient = useQueryClient();
  const addressedHadTree = useRef(false);
  const addressedTree =
    closeMetadata?.data && "item" in closeMetadata.data ? closeMetadata.data.item.tree : undefined;
  useEffect(() => {
    if (addressedTree === undefined) return;
    if (addressedTree) addressedHadTree.current = true;
    else if (addressedHadTree.current) {
      addressedHadTree.current = false;
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.documentAddresses(projectId),
      });
    }
  }, [addressedTree, projectId, queryClient]);
  const listedDrafts = useOwnerDrafts(
    projectId,
    documentDestination
      ? (reviewOwner ?? (workId ? draftOwnerKey({ kind: "work", workId }) : null))
      : null,
  );
  // The list omits an active draft with no effect; the addressed item's own metadata still
  // says whether live holds its document, so a held no-effect draft keeps its draft-only host.
  const addressedItem = closeMetadata?.data?.status === "active" ? closeMetadata.data.item : null;
  const editorDrafts = useMemo(
    () =>
      !addressedItem ||
      (listedDrafts.status !== "ready" && listedDrafts.status !== "empty") ||
      listedDrafts.files?.some((file) => file.draft.itemKey === addressedItem.itemKey)
        ? listedDrafts
        : {
            ...listedDrafts,
            files: [
              ...(listedDrafts.files ?? []),
              ...projectWorkBranchFiles([addressedItem], null),
            ],
          },
    [listedDrafts, addressedItem],
  );
  const openContext = useMemo(
    () =>
      createEditorDocumentCommand({
        projectId,
        accountId: user.userId,
        read: () => ({ ...latest.current, addressDocumentId: addressDocumentIdRef.current }),
        presented: () => presented?.documents(projectId) ?? [],
        isDraftOnly: (documentId) =>
          draftOnlyDocuments?.isDraftOnly(projectId, documentId) ?? false,
        leaveRoute: routeDocument.forget,
      }),
    [draftOnlyDocuments, presented, projectId, user.userId, routeDocument.forget],
  );
  const holdsBound = replayAddress?.kind === "held";
  // The route is bound to a document this source's tree lacks. Once the list has synced the
  // replay says where it is now: found in another source (a move between two lists leaves it in
  // neither for a moment), the route goes there. Until then the route holds; removal is the
  // observer's (main opens the Trash view), and the writer pointing the route elsewhere ends it.
  const movedTo =
    holdsBound && addressTree.isComplete && boundDocumentId
      ? documentTree.findDocument(boundDocumentId)
      : null;
  const heldAttempt =
    holdsBound && addressTree.isComplete && documentDestination
      ? `${boundDocumentId}|${documentDestination.scheme}|${documentDestination.path}|${movedTo?.uri ?? ""}`
      : null;
  useEffect(() => {
    if (!heldAttempt || !boundDocumentId || !documentDestination) return;
    // A plain ticket: a delayed repair must not retire the writer's pending navigation.
    const navigation = latest.current.navigation;
    const ticket = navigation?.capture();
    const current = () => !!ticket && !!navigation?.isCurrent(ticket);
    const located = movedTo ? parseContextUri(movedTo.uri) : null;
    if (!located) return;
    void openContext(
      contextRouteRequest({
        scheme: located.scheme,
        path: located.path,
        ...(located.scheme === "scratch" ? locatorOwner : {}),
        documentId: boundDocumentId,
      }),
      { replace: true, isCurrent: current },
    );
  }, [heldAttempt]);
  const remoteAnswer = reviewBoundAddressResult(addressBinding, documentLookup.data);
  const documentResult: DocumentAddressResult | undefined =
    addressBinding.kind !== "plain"
      ? remoteAnswer
      : replayAddress?.kind === "found"
        ? replayAddress.result
        : replayAddress?.kind === "absent"
          ? { kind: "unavailable" }
          : undefined;
  const addressView = addressBinding.kind === "plain" ? "live" : "review";
  const draftOnly = draftOnlyTarget(documentResult, addressView, editorDrafts);
  const reviewItemKey = address.itemKey ?? draftOnly?.draft.itemKey;
  const addressedNow = addressedDocument(
    address,
    documentResult,
    replayAddress?.kind === "found" ? replayAddress.file : undefined,
    draftOnly,
  );
  // Rebuilt from JSON snapshots each render: only its serialized meaning is a change.
  const addressedKey = JSON.stringify(addressedNow);
  const addressed = useMemo(() => addressedNow, [addressedKey]);
  const addressDocumentId =
    documentResult && documentResult.kind !== "unavailable"
      ? documentResult.document.documentId
      : undefined;
  addressDocumentIdRef.current = addressDocumentId;
  useLayoutEffect(() => {
    if (routePlace && addressDocumentId) routeDocument.remember(routePlace, addressDocumentId);
  }, [routePlace, addressDocumentId, routeDocument.remember]);
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : !documentResult
      ? // A prerequisite that failed ends the wait: the address stays, with a way to retry.
        documentLookup.isError || (addressBinding.kind === "plain" && addressTree.isError)
        ? "error"
        : "loading"
      : documentResult.kind === "unavailable"
        ? closingRef &&
          !closeState.removed &&
          (closeMetadata?.isFetching ||
            (!closeMetadata?.isError &&
              (closeMetadata?.dataUpdatedAt ?? 0) <= documentLookup.dataUpdatedAt) ||
            closeState.checkingClose ||
            closeState.closed)
          ? "loading"
          : "unavailable"
        : undefined;
  // A review address names its document: when it is unavailable because the
  // document was removed, it says so instead. A plain path names no document
  // once nothing lives there, so it stays "unavailable".
  const removedDocumentId =
    documentIssue === "unavailable" && address.itemKey ? (closingDocumentId ?? null) : null;
  const removedDestination = useRemovalRecord(projectId, removedDocumentId);
  const reviewGone =
    documentLookup.data?.kind === "unavailable" &&
    !!address.itemKey &&
    (closingDocumentId == null || removedDestination?.kind === "available");
  useLayoutEffect(() => {
    if (!reviewGone || !navigation) return;
    const ticket = navigation.captureForEntry(location.state.__TSR_key ?? "");
    // `reviewEnded` lets the document say once that the link's draft has ended.
    if (ticket)
      void navigation.replaceIfCurrent(ticket, withoutReview(address), { reviewEnded: true });
  }, [reviewGone, navigation, location, address]);
  const removedTitle = documentDestination?.path.split("/").filter(Boolean).at(-1) ?? null;
  const mainIssue = parsed.kind === "invalid" ? "unavailable" : undefined;
  // The failed reads are what the address waits on; retrying them is the destination's recovery.
  const retryEditorAddress = useCallback(() => {
    void documentLookup.refetch();
    editorDrafts.refetch();
    editorScope.retry();
  }, [documentLookup.refetch, editorDrafts.refetch, editorScope.retry]);
  const editorIssue = resourceDestination
    ? "resource-viewing"
    : ((editorScope.status === "ready" ? undefined : editorScope.status) ??
      documentIssue ??
      (reviewItemKey
        ? // Until the address carries the item, it is still being repaired.
          address.itemKey === reviewItemKey && addressDocumentId
          ? undefined
          : "loading"
        : documentDestination
          ? admission?.href === location.href &&
            admission.key === (location.state.__TSR_key ?? "") &&
            documentResult?.kind !== "unavailable" &&
            admission.documentId === documentResult?.document.documentId
            ? admission.issue
            : "loading"
          : undefined));

  async function go(
    next: ProjectAddress,
    options: NavigationOptions,
  ): Promise<NavigationSettlement> {
    if (!navigation) return { kind: "superseded" };
    return navigation.navigate(next, options);
  }
  function toDestination(next: ProjectDestination): ProjectAddress {
    return {
      ...address,
      destination: next,
      itemKey: undefined,
      changeId: undefined,
      owner: undefined,
    };
  }
  const setEditorReviewItemKey = useCallback((review: DraftPin | null) => {
    const current = latest.current;
    if (!current.navigation) return;
    const ticket = current.navigation.capture();
    const { address } = current;
    // A draft's owner is part of its link: the pin's owner.
    const next = review
      ? {
          ...address,
          owner: review.ownerKey as DraftOwnerKey,
          itemKey: review.itemKey,
          changeId: review.changeId,
        }
      : withoutReview(address);
    void current.navigation.replaceIfCurrent(ticket, next);
  }, []);
  // Stable, so the document opener built on it outlives a change of what main shows.
  const openTrashed = useCallback<TrashNavigation["open"]>(async (documentId, options) => {
    const { navigation, address } = latest.current;
    if (!navigation) return { kind: "superseded" };
    return navigation.navigate(
      {
        projectId: address.projectId,
        destination: { kind: "trashed", documentId },
        ...(address.settings ? { settings: address.settings } : {}),
      },
      { replace: options?.replace ?? false },
    );
  }, []);
  const shownTrashed = destination.kind === "trashed" ? destination.documentId : undefined;
  const trash = useMemo<TrashNavigation>(
    () => ({ shown: shownTrashed, open: openTrashed }),
    [shownTrashed, openTrashed],
  );
  useEffect(() => {
    if (!closingRef || !closeState.closed || closeState.removed) return;
    const itemKey = closingRef.itemKey;
    let current = true;
    // The address names the item; a newer draft of it may have replaced the closed one.
    void draftCommands
      .reconcileClosed(closingRef, () => fetchCurrentDraftMetadata(queryClient, closingRef))
      .then((open) => {
        const now = latest.current;
        if (!current || open || !now.navigation || now.address.itemKey !== itemKey) return;
        const closed = draftCommands.state(itemKey);
        const live = closed.liveUri ? parseContextUri(closed.liveUri) : null;
        // The view owns the pin: the replace below only rewrites the address to follow it.
        endPin(user.userId, projectId, closingRef);
        void now.navigation.replaceIfCurrent(now.navigation.capture(), {
          ...now.address,
          ...(live
            ? {
                destination: {
                  kind: "document",
                  scheme: live.scheme,
                  path: live.path.replace(/^\/+/, ""),
                },
              }
            : {}),
          itemKey: undefined,
          changeId: undefined,
        });
      });
    return () => {
      current = false;
    };
  }, [address.itemKey, closeState.closed, closeState.removed, closeState.liveUri]);
  const closeDestination = useCallback(
    (target: ContextRouteRequest | { kind: "clear" }, prepared: PreparedWorkspaceNavigation) => {
      const current = latest.current;
      if (!current.navigation) return Promise.resolve({ kind: "superseded" as const });
      const next =
        "kind" in target
          ? { ...current.address, destination: { kind: "editor" as const } }
          : prepareEditorDestination({ address: current.address, scope: workId }, target);
      return current.navigation.transition(next, { replace: true }, prepared);
    },
    [workId],
  );

  const routeCommands: ProjectRouteCommands = {
    // Already on the chooser is a no-op. A local draft is also `/editor`; its history pointer
    // names it. Navigation clears that pointer. Departure freezes it, so Back returns to the
    // draft.
    showEditorRecents: (options) => {
      const onChooser =
        destination.kind === "editor" &&
        (!("meridianProjectSelection" in location.state) ||
          location.state.meridianProjectSelection == null);
      return onChooser
        ? Promise.resolve({ kind: "applied" } as const)
        : go(toDestination({ kind: "editor" }), options);
    },
  };
  const search: ProjectSearch = {
    work: locatorOwner.workId,
    chat: locatorOwner.rootThreadId,
    scheme: destination.kind === "document" ? destination.scheme : undefined,
    path: documentDestination ? `/${documentDestination.path}` : undefined,
  };
  const editorDocument = {
    activeContextScheme: search.scheme ?? null,
    activeContextPath: search.path ?? null,
    activeContextChat: search.chat ?? null,
  };
  return (
    <ProjectNavigationProvider
      openContextRoute={openContext}
      captureNavigation={captureNavigation}
      trash={trash}
      routeCommands={routeCommands}
    >
      <ChatNavigationProvider value={chat}>
        <ProjectDocumentNavigationProvider
          projectId={projectId}
          captureNavigation={captureNavigation}
        >
          {documentDestination ? (
            <ProjectAddressDocument
              href={location.href}
              entryKey={location.state.__TSR_key ?? ""}
              address={address}
              // Cached paths can have been renamed or reused; only a settled lookup may repair the URL.
              result={documentResult}
              reviewItemKey={reviewItemKey}
              workId={workId}
              navigation={navigation}
              onAdmission={setAdmission}
            />
          ) : null}
          <ProjectView
            project={project}
            projectId={projectId}
            chatDisplay={chat.display}
            entryHydration={entryHydration}
            routeLocationKey={location.state.__TSR_key ?? location.href}
            routeIssues={{
              main: mainIssue,
              // Loading until the removal lookup answers, so the destination
              // never says "unavailable", then who removed it.
              editor:
                removedDocumentId !== null && removedDestination === undefined
                  ? "loading"
                  : editorIssue,
              removed:
                removedDestination?.kind === "removed"
                  ? { title: removedTitle, record: removedDestination.record }
                  : undefined,
            }}
            onRetryEditorRoute={retryEditorAddress}
            routeCommands={routeCommands}
            contextRemovalRoute={{
              transition: (_id, target, prepared) => closeDestination(target, prepared),
            }}
            routeDocumentId={boundDocumentId}
            addressedDocument={addressed ?? undefined}
            activeContextScheme={editorDocument.activeContextScheme}
            activeContextWork={locatorOwner.workId ?? null}
            activeContextPath={editorDocument.activeContextPath}
            activeContextChat={editorDocument.activeContextChat}
            reviewItemKey={address.itemKey}
            reviewOwner={reviewOwner}
            reviewAddressOwner={address.owner}
            reviewChangeId={address.changeId}
            reviewAddressDocumentId={addressDocumentId}
            reviewAddressAdmission={
              documentIssue === "error"
                ? "failed"
                : documentIssue === "unavailable"
                  ? "unavailable"
                  : addressDocumentId
                    ? "admitted"
                    : "pending"
            }
            onOpenContextTarget={openContext}
            onSetEditorReviewItemKey={setEditorReviewItemKey}
          />
        </ProjectDocumentNavigationProvider>
      </ChatNavigationProvider>
    </ProjectNavigationProvider>
  );
}
