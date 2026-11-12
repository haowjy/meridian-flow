/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import { draftOwnerKey, parseDraftItemKey } from "@meridian/contracts";
import type { DraftOwnerKey } from "@meridian/contracts/branches";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { contextOwner } from "@meridian/contracts/protocol";
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
import {
  getProjectContextAvailability,
  getProjectDocumentAddress,
} from "@/client/api/projects-api";
import { type DraftPin, endPin } from "@/client/project-shell/document-views";
import type { ContextOwner } from "@/client/query/context-request-options";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata, useDraftMetadata } from "@/client/query/useDraftMetadata";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { projectWorkBranchFiles } from "@/client/query/work-branch-files";
import { isEditorScheme, type OpenDocument } from "@/client/stores";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import { parseContextUri } from "@/lib/context-uri";
import { originalBrowserSearch } from "@/router-search";
import {
  useAccountResourceProjection,
  useContextRemovalCoordinator,
  useDraftCommandOwner,
  useOptionalDraftOnlyPresentations,
  useOptionalPresentedDocuments,
  usePresentedDocuments,
  useProjectContextAvailabilityCoordinator,
} from "../context/account-feature-context";
import { routeTargetForTab } from "../context/context-removal-planner";
import { routeSelectionDocumentId, selectionAtRoute } from "../context/context-removal-protocol";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useRemovalRecord } from "../context/use-removal-record";
import { ProjectView } from "../ProjectView";
import { useWorkScopeState } from "../use-work-scope";
import { ChatNavigationProvider, useProjectChatNavigation } from "./chat-navigation";
import { applyContextRemovalSearchUpdate } from "./context-removal-route-repair";
import {
  addressReviewOwner,
  addressRouteBinding,
  bindDocumentAddressReview,
  documentAddressQueryOptions,
  reviewBoundAddressResult,
} from "./document-address-review";
import { createEditorDocumentCommand, prepareEditorDestination } from "./editor-document-command";
import {
  canonicalDocumentPath,
  gateLiveView,
  holdsBoundDocument,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
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
import { localDocumentsOf, resolveLocalDocumentSelection } from "./project-local-selection";
import {
  createProjectNavigation,
  type DisplayedProjectSelection,
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

type ReadableProjectRouteProps = {
  project: Project;
  entryHydration: WorkingSetHydrationPlan;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
};
export function ReadableProjectRoute({ project, entryHydration, user }: ReadableProjectRouteProps) {
  const projectId = project.id;
  const contextRemoval = useContextRemovalCoordinator();
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
          : null,
    go: (next, options) => go(toDestination(next), options),
  });
  // The Work scope is stored, never read from the address: a Work-scoped page lens, not a place.
  const editorScope = useWorkScopeState(projectId);
  const workId = editorScope.workId;
  const presentedDocuments = usePresentedDocuments(projectId);
  const presented = useOptionalPresentedDocuments();
  const draftOnlyDocuments = useOptionalDraftOnlyPresentations();
  const resources = useAccountResourceProjection(projectId);
  const localDocumentOf = useMemo(
    () =>
      resources.snapshot
        ? localDocumentsOf({ records: resources.records, placement: resources.placement })
        : null,
    [resources.snapshot, resources.records, resources.placement],
  );
  // A history entry's pointer names an untitled document by its handle, and the replica says
  // which document that is.
  const localDocument = resolveLocalDocumentSelection({
    pointer:
      destination.kind === "editor" || destination.kind === "document"
        ? "meridianProjectSelection" in location.state
          ? location.state.meridianProjectSelection
          : undefined
        : undefined,
    accountId: user.userId,
    projectId,
    documentOf: localDocumentOf,
  });
  const localDocumentId = localDocument.kind === "resolved" ? localDocument.documentId : undefined;
  const localResourceHandle =
    localDocument.kind === "resolved" ? localDocument.document.resourceHandle : undefined;
  const localPointer =
    localDocumentId && localResourceHandle
      ? { accountId: user.userId, projectId, resourceHandle: localResourceHandle }
      : undefined;
  const localDocumentTab = localDocument.kind === "resolved" ? localDocument.document : null;
  const shown = useRef<DisplayedProjectSelection>({});
  shown.current = { local: localPointer };
  useBlocker({
    shouldBlockFn: async () => (navigation ? !(await navigation.allowDeparture()) : false),
    enableBeforeUnload: () => navigation?.hasUnsavedChanges() ?? false,
  });
  useLayoutEffect(() => {
    const coordinator = createProjectNavigation(
      {
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
      },
      () => shown.current,
    );
    setNavigation(coordinator);
    return () => coordinator.dispose();
  }, [router]);
  useEffect(() => {
    if (!navigation || parsed.kind !== "valid") return;
    const ticket = navigation.captureForEntry(location.state.__TSR_key ?? "");
    if (!ticket) return;
    navigation.repairAddress(ticket);
  }, [navigation, location]);

  // Cached live locations, read only to place a review launch's document (never fetched for it).
  const launchCatalogs = useContextCatalogViews(projectId, CONTEXT_URI_SCHEMES, {
    workId,
    enabled: false,
  });
  const documentCatalog = useMemo(
    () => ({
      findDocument: (id: string) =>
        CONTEXT_URI_SCHEMES.map((scheme) => launchCatalogs[scheme].catalog?.findDocument(id)).find(
          (file) => file != null,
        ) ?? null,
    }),
    [launchCatalogs],
  );
  const latest = useRef({
    address,
    location,
    navigation,
    editorWorkId: workId,
    documentCatalog,
  });
  latest.current = {
    address,
    location,
    navigation,
    editorWorkId: workId,
    documentCatalog,
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
  const addressCatalogs = useContextCatalogViews(projectId, addressSchemes, {
    ...addressOwner,
    enabled: !!documentDestination,
  });
  const {
    catalog: addressCatalog,
    isComplete: addressCatalogComplete,
    isFetching: addressCatalogFetching,
    isError: addressCatalogError,
    refetch: refetchAddressCatalog,
  } = documentDestination
    ? addressCatalogs[documentDestination.scheme]
    : {
        catalog: null,
        isComplete: false,
        isFetching: false,
        isError: false,
        refetch: () => undefined,
      };
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
  const availability = useProjectContextAvailabilityCoordinator();
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
  const { selection } = useContextRemovalProject(projectId);
  // A review's binding is the address's only while the address carries its item: the same path
  // after Back names no document, and this render must not admit the bound one there.
  const reviewBindingEnded =
    selection.status === "bound" && selection.by === "review" && !address.itemKey;
  const boundDocumentId =
    documentDestination && !reviewBindingEnded
      ? routeSelectionDocumentId(
          selection,
          contextRouteRequest({
            scheme: documentDestination.scheme,
            path: documentDestination.path,
            ...locatorOwner,
          }),
        )
      : null;
  const localDocumentAddress = useMemo(
    () =>
      documentDestination && addressBinding.kind === "plain"
        ? resolveLocalDocumentAddress(
            projectId,
            documentDestination,
            addressOwner.workId ?? null,
            addressCatalog,
            boundDocumentId,
            addressOwner.rootThreadId ?? null,
          )
        : undefined,
    [
      addressCatalog,
      addressBinding.kind,
      documentDestination,
      addressOwner.workId,
      addressOwner.rootThreadId,
      projectId,
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
        lookup: (documentId) =>
          getProjectContextAvailability(projectId, [documentId]).then(
            (result) => result.resolutions[0] ?? { kind: "failed" as const },
            () => ({ kind: "failed" as const }),
          ),
        isDraftOnly: (documentId) =>
          draftOnlyDocuments?.isDraftOnly(projectId, documentId) ?? false,
        admitDraftReview: (installed) => contextRemoval.admitDraftReview(projectId, installed),
        enterRoute: (locator, documentId, by) =>
          contextRemoval.enterRoute(projectId, locator, documentId, by),
      }),
    [contextRemoval, draftOnlyDocuments, presented, projectId, user.userId],
  );
  const remoteAnswer = reviewBoundAddressResult(addressBinding, documentLookup.data);
  const holdsBound =
    addressBinding.kind === "plain" &&
    holdsBoundDocument(boundDocumentId, addressCatalog, remoteAnswer);
  // The hold asks the server once where the bound document is now. Found, the route goes there;
  // anything else (moved out of sight, removed, a failed lookup) ends the binding and the
  // address answer decides.
  const catalogSettled =
    addressCatalog !== null && addressCatalogComplete && !addressCatalogFetching;
  const heldAttempt =
    holdsBound && catalogSettled && documentDestination
      ? `${boundDocumentId}|${documentDestination.scheme}|${documentDestination.path}`
      : null;
  useEffect(() => {
    if (!heldAttempt || !boundDocumentId || !documentDestination) return;
    // A plain ticket: a delayed repair must not retire the writer's pending navigation.
    const navigation = latest.current.navigation;
    const ticket = navigation?.capture();
    const current = () => !!ticket && !!navigation?.isCurrent(ticket);
    const unbind = () =>
      contextRemoval.unbindRoute(
        projectId,
        boundDocumentId,
        contextRouteRequest({
          scheme: documentDestination.scheme,
          path: documentDestination.path,
          ...locatorOwner,
        }),
      );
    void availability.resolveForOpen(projectId, boundDocumentId).then((answer) => {
      const located = answer.kind === "available" ? parseContextUri(answer.entry.uri) : null;
      if (!located) return unbind();
      if (!current()) return;
      if (
        located.scheme === documentDestination.scheme &&
        canonicalDocumentPath(located.path) === canonicalDocumentPath(documentDestination.path)
      )
        // The server places the document here: the answer that named another is stale.
        return void documentLookup.refetch();
      void openContext(
        contextRouteRequest({
          scheme: located.scheme,
          path: located.path,
          // A moved document may live in another Work's Scratch.
          ...(located.scheme === "scratch" &&
          answer.kind === "available" &&
          answer.authority.kind === "work"
            ? { workId: answer.authority.workId }
            : locatorOwner),
          documentId: boundDocumentId,
        }),
        { replace: true, isCurrent: current },
      );
    }, unbind);
  }, [heldAttempt]);
  const reconciledDocumentAddress = reconcileDocumentAddress(
    localDocumentAddress,
    holdsBound ? undefined : remoteAnswer,
    addressBinding.kind === "plain" ? "live" : "review",
  );
  const gated = gateLiveView(
    reconciledDocumentAddress.result,
    {
      catalog: addressCatalog,
      isComplete: addressCatalogComplete,
      isFetching: addressCatalogFetching,
      isError: addressCatalogError,
    },
    editorDrafts,
    (documentId) =>
      presentedDocuments.some((tab) => tab.documentId === documentId) &&
      !draftOnlyDocuments?.isDraftOnly(projectId, documentId),
    reconciledDocumentAddress.view,
  );
  const documentResult = gated.result;
  const draftOnly = gated.outcome === "ready" ? gated.draftOnly : undefined;
  const routeBinding = addressRouteBinding(
    addressBinding,
    documentResult,
    selection,
    documentDestination,
    locatorOwner,
    reviewOwner,
  );
  useLayoutEffect(() => {
    if (!routeBinding) return;
    contextRemoval.bindRouteSelection(
      projectId,
      routeBinding.revision,
      { kind: "server", documentId: routeBinding.documentId },
      routeBinding.by,
    );
  }, [contextRemoval, projectId, routeBinding?.revision, routeBinding?.documentId]);
  const reviewItemKey = address.itemKey ?? draftOnly?.draft.itemKey;
  const addressedNow = addressedDocument(
    address,
    documentResult,
    reconciledDocumentAddress.localFile,
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
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : !documentResult
      ? // A prerequisite that failed ends the wait: the address stays, with a way to retry.
        documentLookup.isError || gated.outcome === "failed" || (holdsBound && addressCatalogError)
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
  // The server not having a path rejects a route candidate only when this device holds no
  // document there either: a document the server never accepted is listed here and opens.
  // An item that names no draft (or a draft that has ended) is not the document missing: the
  // address names the document, so only the review goes (below) and the selection stays.
  useLayoutEffect(() => {
    if (
      documentLookup.data?.kind !== "unavailable" ||
      reviewGone ||
      localDocumentAddress ||
      destination.kind !== "document" ||
      selection.status !== "candidate" ||
      !selectionAtRoute(
        selection,
        contextRouteRequest({
          scheme: destination.scheme,
          path: destination.path,
          ...locatorOwner,
        }),
      )
    )
      return;
    contextRemoval.rejectRouteCandidate(projectId, selection.revision);
  }, [
    locatorOwner.workId,
    locatorOwner.rootThreadId,
    contextRemoval,
    destination,
    documentLookup.data,
    reviewGone,
    localDocumentAddress,
    projectId,
    selection,
  ]);
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
    refetchAddressCatalog();
    editorDrafts.refetch();
    editorScope.retry();
  }, [documentLookup.refetch, refetchAddressCatalog, editorDrafts.refetch, editorScope.retry]);
  const editorIssue = resourceDestination
    ? "resource-viewing"
    : ((localDocument.kind === "loading" || localDocument.kind === "unavailable"
        ? localDocument.kind
        : undefined) ??
      (editorScope.status === "ready" ? undefined : editorScope.status) ??
      // A locally created document wins over the server address lookup.
      (localDocumentId
        ? undefined
        : (documentIssue ??
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
              : undefined))));

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
  const contextDestination = useCallback(
    (target: ContextRouteRequest, preparedTab?: OpenDocument, itemKey?: string) =>
      prepareEditorDestination(
        {
          projectId,
          accountId: user.userId,
          address: latest.current.address,
          scope: workId,
          presented: presented?.documents(projectId) ?? [],
        },
        target,
        preparedTab,
        itemKey,
      ),
    [presented, projectId, user.userId, workId],
  );
  // A document the server never accepted keeps its stable local identity when its placement is
  // refused, and the route bound to it follows that identity back to Unfiled. Its host already
  // shows it there; the path it was filed at no longer names it.
  const departedLocalTab =
    boundDocumentId && documentDestination
      ? presentedDocuments.find(
          (tab) =>
            tab.documentId === boundDocumentId &&
            (tab.kind === "new" ||
              (tab.kind === "tracked" &&
                tab.origin === "local-resource" &&
                tab.scheme === "unfiled")),
        )
      : undefined;
  useEffect(() => {
    if (!departedLocalTab || !workId) return;
    void openContext(
      { ...routeTargetForTab(departedLocalTab), documentId: departedLocalTab.documentId },
      { replace: true },
    );
  }, [departedLocalTab?.documentId, workId, openContext]);
  const setEditorReviewItemKey = useCallback(
    (review: DraftPin | null) => {
      const current = latest.current;
      if (!current.navigation) return;
      const ticket = current.navigation.capture();
      const { address } = current;
      if (!review) contextRemoval.adoptReviewBinding(projectId);
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
    },
    [contextRemoval, projectId],
  );
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
        contextRemoval.adoptReviewBinding(projectId);
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
          ? {
              address: {
                ...current.address,
                destination: { kind: "editor" as const },
              },
              state: undefined,
            }
          : contextDestination(target);
      return current.navigation.transition(
        next.address,
        { replace: true, state: next.state },
        prepared,
      );
    },
    [contextDestination],
  );

  const goLegacy = async (next: ProjectAddress, options: NavigationOptions) => {
    const result = await go(next, options);
    if (result.kind === "failed") throw result.error;
  };
  const routeCommands: ProjectRouteCommands = {
    // Already on the chooser is a no-op. A local draft is also `/editor`; its history pointer
    // names it. Navigation clears that pointer. Departure freezes it, so Back returns to the
    // draft.
    showEditorRecents: (options) => {
      const onChooser =
        destination.kind === "editor" &&
        (!("meridianProjectSelection" in location.state) ||
          location.state.meridianProjectSelection == null);
      return onChooser ? Promise.resolve() : goLegacy(toDestination({ kind: "editor" }), options);
    },
  };
  // A resource pointer holds identity, not an Untitled address. Once placement
  // exists, publish its real locator so the removal host does not repair it
  // back into this same pointer-bearing destination on every render.
  const localTarget = localDocument.kind === "resolved" ? localDocument.target : null;
  const search: ProjectSearch = {
    work: locatorOwner.workId,
    chat: locatorOwner.rootThreadId,
    scheme: localDocumentId
      ? (localTarget?.scheme ?? "unfiled")
      : destination.kind === "document"
        ? destination.scheme
        : undefined,
    path: localDocumentId
      ? (localTarget?.path ?? "")
      : documentDestination
        ? `/${documentDestination.path}`
        : undefined,
  };
  const editorDocument = {
    editorWorkId: workId,
    localDocumentId,
    activeContextScheme: search.scheme ?? null,
    activeContextPath: search.path ?? null,
    activeContextChat: search.chat ?? null,
  };
  return (
    <ProjectNavigationProvider
      openContextRoute={openContext}
      captureNavigation={captureNavigation}
      trash={trash}
    >
      <ChatNavigationProvider value={chat}>
        <ProjectDocumentNavigationProvider
          projectId={projectId}
          captureNavigation={captureNavigation}
        >
          {documentDestination && !localDocumentId ? (
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
              readSearch: () => search,
              updateSearch: (_id, update, relocated) =>
                applyContextRemovalSearchUpdate({
                  search,
                  update,
                  relocated,
                  openContext,
                }),
            }}
            activeLocalDocumentId={editorDocument.localDocumentId}
            activeLocalDocument={localDocumentTab ?? undefined}
            addressedDocument={addressed ?? undefined}
            activeContextScheme={editorDocument.activeContextScheme}
            activeContextWork={locatorOwner.workId ?? null}
            activeContextPath={editorDocument.activeContextPath}
            activeContextChat={editorDocument.activeContextChat}
            reviewItemKey={address.itemKey}
            reviewOwner={reviewOwner}
            reviewAddressOwner={address.owner}
            reviewDocumentId={closingDocumentId ?? undefined}
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
