/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import { parseDraftItemKey } from "@meridian/contracts";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
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
import type { ContextOwner } from "@/client/query/context-request-options";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata, useDraftMetadata } from "@/client/query/useDraftMetadata";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import { projectWorkBranchFiles } from "@/client/query/work-branch-files";
import {
  type ContextTab,
  getContextTabs,
  isDraftOnly,
  isEditorScheme,
  matchesReviewItem,
  useContextTabs,
  useContextTabsStore,
} from "@/client/stores";
import { readRecentRoutes, type WorkingSetHydrationPlan } from "@/client/working-set";
import { parseContextUri } from "@/lib/context-uri";
import { originalBrowserSearch } from "@/router-search";
import {
  useContextRemovalCoordinator,
  useDraftCommandOwner,
} from "../context/account-feature-context";
import { routeTargetForTab } from "../context/context-removal-planner";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useRemovalRecord } from "../context/use-removal-record";
import { ProjectView } from "../ProjectView";
import type { ScreenKey } from "../shell/screens";
import {
  ChatNavigationProvider,
  chatSurfaceThreadId,
  useProjectChatNavigation,
} from "./chat-navigation";
import { applyContextRemovalSearchUpdate } from "./context-removal-route-repair";
import {
  bindDocumentAddressReview,
  documentAddressQueryOptions,
  reviewAddressRouteBinding,
  reviewBoundAddressResult,
} from "./document-address-review";
import {
  DocumentSwitchFailureProvider,
  destinationFailure,
  useDocumentSwitchFailures,
  useRailScreenSwitch,
} from "./document-switch-failure";
import { editorDefaultWorkPending } from "./editor-default-work";
import { createEditorDocumentCommand, prepareEditorDestination } from "./editor-document-command";
import {
  gateLiveView,
  projectAddressMatchesContextTarget,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
  routeContinuityDocumentId,
} from "./local-document-address";
import { type AddressAdmission, ProjectAddressDocument } from "./ProjectAddressDocument";
import { ProjectNavigationProvider } from "./ProjectNavigationContext";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import {
  type AddressSelection,
  browseDestination,
  browsedFolder,
  type ProjectAddress,
  type ProjectDestination,
  parseProjectAddress,
  projectAddressHref,
  workDetailAddress,
} from "./project-address";
import { addressWorkSelection, workSelectionFor } from "./project-address-resolution";
import {
  resolveLocalDocumentSelection,
  selectEditorEntryTab,
  useEditorContainerAddress,
} from "./project-local-selection";
import {
  createProjectNavigation,
  type DisplayedProjectSelection,
  type NavigationSettlement,
  type PreparedWorkspaceNavigation,
} from "./project-navigation";
import {
  type ContextRouteRequest,
  type ContextRouteTarget,
  type NavigationOptions,
  type ProjectRouteCommands,
  type ProjectSearch,
  type RouteWorkResolution,
  routeWorkIssue,
  type WorkDetailTarget,
} from "./project-route";
import { resolveRouteWork, useWorkRoute } from "./work-route";

const NONE: AddressSelection = { kind: "none" };
function screen(destination: ProjectDestination): ScreenKey {
  if (
    destination.kind === "work" ||
    destination.kind === "works" ||
    destination.kind === "works-new"
  )
    return "work";
  if (destination.kind === "chat" || destination.kind === "chat-index") return "chat";
  return "context";
}

type ReadableProjectRouteProps = {
  project: Project;
  entryHydration: WorkingSetHydrationPlan;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
};
export function ReadableProjectRoute(props: ReadableProjectRouteProps) {
  const entryKey = useRouterState({ select: (state) => state.location.state.__TSR_key ?? "" });
  return (
    <DocumentSwitchFailureProvider entryKey={entryKey}>
      <ReadableProjectDestination {...props} />
    </DocumentSwitchFailureProvider>
  );
}
function ReadableProjectDestination({
  project,
  entryHydration,
  user,
}: {
  project: Project;
  entryHydration: WorkingSetHydrationPlan;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
}) {
  const projectId = project.id;
  const contextRemoval = useContextRemovalCoordinator();
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const parsed = parseProjectAddress(
    location.pathname,
    originalBrowserSearch(location.search),
    location.state,
  );
  const address: ProjectAddress =
    parsed.kind === "valid"
      ? parsed.address
      : {
          projectId: project.id,
          destination: { kind: "chat-index" },
          work: NONE,
        };
  const destination = address.destination;
  const activeScreen = screen(destination);
  const [navigation, setNavigation] = useState<ReturnType<typeof createProjectNavigation> | null>(
    null,
  );
  const { routeWork, workCatalog, rememberedWork, openRemembered } = useWorkRoute({
    projectId,
    address,
    navigation,
  });
  const noWorkId = workCatalog.noWork?.id ?? null;
  const threads = useProjectThreads(projectId);
  const chat = useProjectChatNavigation({
    accountId: user.userId,
    projectId,
    activeScreen,
    urlChatId: destination.kind === "chat" ? destination.chatId : null,
    go: (next, options) => go(toDestination(next), options),
  });
  const chatThreadId = chatSurfaceThreadId(chat.display);
  const displayedChat = threads.threads?.find((thread) => thread.id === chatThreadId) ?? null;
  const rememberedEditor = useRef<string | undefined>(undefined);
  const requestedWork = addressWorkSelection(address);
  const editorSeed = rememberedEditor.current ?? displayedChat?.workId;
  // Chat may seed a genuinely absent Editor context once, never rebind it after navigation.
  const editorSelection: Exclude<AddressSelection, { kind: "absent" }> =
    activeScreen === "context" && requestedWork.kind !== "absent"
      ? requestedWork
      : editorSeed
        ? workSelectionFor({ kind: "editor" }, editorSeed, noWorkId)
        : { kind: "none" };
  const editorDefaultPending =
    rememberedEditor.current === undefined &&
    !(activeScreen === "context" && requestedWork.kind !== "absent") &&
    editorDefaultWorkPending({
      workCatalogReady: workCatalog.status === "ready",
      chatThreadId,
      displayedChatFound: displayedChat !== null,
      threadsFailed: threads.isError,
      threadsUnloaded: threads.threads === null,
    });
  const editorWork: Exclude<RouteWorkResolution, { status: "new" | "absent" }> =
    editorDefaultPending
      ? {
          status: "unresolved",
          reason: workCatalog.status === "error" || threads.isError ? "error" : "loading",
          workId: null,
        }
      : resolveRouteWork(editorSelection, workCatalog);
  const workId = editorWork.status === "present" ? editorWork.workId : null;
  const { tabs: workspaceTabs } = useContextTabs(projectId);
  const workspaceHydrated = useContextTabsStore((state) => state._workspaceHydrated);
  const localDocument = resolveLocalDocumentSelection({
    pointer:
      destination.kind === "editor" || destination.kind === "document"
        ? "meridianProjectSelection" in location.state
          ? location.state.meridianProjectSelection
          : undefined
        : undefined,
    accountId: user.userId,
    projectId,
    workId,
    hydrated: workspaceHydrated,
    tabs: workspaceTabs,
  });
  const localDocumentId = localDocument.kind === "resolved" ? localDocument.documentId : undefined;
  const localResourceHandle =
    localDocument.kind === "resolved" ? localDocument.owner.tab.resourceHandle : undefined;
  const localPointer =
    localDocumentId && localResourceHandle
      ? { accountId: user.userId, projectId, resourceHandle: localResourceHandle }
      : undefined;
  useLayoutEffect(() => {
    if (localDocumentId && workId)
      void useContextTabsStore.getState().selectTab(projectId, workId, localDocumentId);
  }, [projectId, workId, localDocumentId]);
  const shown = useRef<DisplayedProjectSelection>({ work: { kind: "none" } });
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
    // A cached miss while a catalog refresh is pending is not confirmed unavailability.
    navigation.repairAddress(ticket, {
      work: workCatalog.isFetching ? { status: "loading" } : workCatalog,
    });
  }, [navigation, location, workCatalog.entries, workCatalog.status, workCatalog.isFetching]);

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
    noWorkId,
    documentCatalog,
  });
  latest.current = {
    address,
    location,
    navigation,
    editorWorkId: workId,
    noWorkId,
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
  const isCurrentContextRoute = useCallback((target: ContextRouteTarget) => {
    return projectAddressMatchesContextTarget(
      latest.current.address,
      target,
      latest.current.noWorkId,
      undefined,
      latest.current.editorWorkId,
    );
  }, []);
  const reportSelection = useCallback(
    ({ editorWorkId: workId }: { editorWorkId: ParsedRequestId | null }) => {
      shown.current = {
        work: workSelectionFor(address.destination, workId ?? undefined, noWorkId),
        local: localPointer,
      };
      if (activeScreen === "context" && workId && !routeWorkIssue(editorWork))
        rememberedEditor.current = workId;
    },
    [activeScreen, editorWork.status, address.destination, localPointer, noWorkId],
  );

  // A scheme the Editor never opens (Uploads) shows in its resource view.
  const resourceDestination =
    (destination.kind === "document" || destination.kind === "browse") &&
    destination.scheme !== null &&
    !isEditorScheme(destination.scheme);
  const documentDestination =
    destination.kind === "document" && !resourceDestination ? destination : null;
  const addressWorkId = workId;
  // A Scratch address names its own owner: a chat's lineage, else the Work the Editor shows.
  const addressOwner: ContextOwner =
    documentDestination?.scheme !== "scratch"
      ? { workId: null }
      : contextOwner(addressWorkId, address.lineage);
  const addressSchemes = useMemo(
    () => (documentDestination ? [documentDestination.scheme] : []),
    [documentDestination?.scheme],
  );
  const addressCatalogs = useContextCatalogViews(projectId, addressSchemes, {
    ...addressOwner,
    enabled: !!documentDestination && editorWork.status === "present",
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
  const addressBinding = bindDocumentAddressReview(address.itemKey, addressWorkId);
  const [admission, setAdmission] = useState<AddressAdmission | null>(null);
  const documentLookup = useQuery(
    documentAddressQueryOptions(
      {
        projectId,
        destination: documentDestination,
        owner: addressOwner,
        binding: addressBinding,
        workResolved: editorWork.status === "present",
        catalogGeneration: addressCatalog?.normalized.generation,
        catalogRevision: addressCatalog?.normalized.appliedRevision,
      },
      getProjectDocumentAddress,
    ),
  );
  // Keep the authoritative draft read above address admission: catalog invalidation can
  // unmount the editor before its terminal room frame arrives.
  const closingDocumentId = address.itemKey ? parseDraftItemKey(address.itemKey)?.documentId : null;
  const closingRef =
    closingDocumentId && address.itemKey && addressWorkId
      ? {
          projectId,
          workId: addressWorkId,
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
  const { selection } = useContextRemovalProject(projectId);
  const boundDocumentId = routeContinuityDocumentId({
    selection,
    admittedDocumentId: admission?.documentId ?? null,
    destination: documentDestination,
    editorWorkId: workId,
    rootThreadId: address.lineage,
  });
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
  const listedDrafts = useWorkBranchDrafts(projectId, documentDestination ? workId : null);
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
  const reconciledDocumentAddress = reconcileDocumentAddress(
    localDocumentAddress,
    reviewBoundAddressResult(addressBinding, documentLookup.data),
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
    (documentId) => workspaceTabs.some((tab) => !isDraftOnly(tab) && tab.documentId === documentId),
    reconciledDocumentAddress.view,
  );
  const documentResult = gated.result;
  const reviewRouteBinding = reviewAddressRouteBinding(
    addressBinding,
    documentResult,
    selection,
    documentDestination,
    workId,
  );
  useLayoutEffect(() => {
    if (!reviewRouteBinding) return;
    contextRemoval.bindRouteSelection(projectId, reviewRouteBinding.revision, {
      kind: "server",
      documentId: reviewRouteBinding.documentId,
    });
  }, [contextRemoval, projectId, reviewRouteBinding?.revision, reviewRouteBinding?.documentId]);
  const draftOnly = gated.outcome === "ready" ? gated.draftOnly : undefined;
  const reviewItemKey = address.itemKey ?? draftOnly?.draft.itemKey;
  const addressDocumentId =
    documentResult && documentResult.kind !== "unavailable"
      ? documentResult.document.documentId
      : undefined;
  addressDocumentIdRef.current = addressDocumentId;
  const editorContainerAddress = useEditorContainerAddress({
    active: activeScreen === "context",
    accountId: user.userId,
    address,
    documentId: addressDocumentId ?? null,
    workId,
  });
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : (routeWorkIssue(routeWork) ??
      (!documentResult
        ? // A prerequisite that failed ends the wait: the address stays, with a way to retry.
          documentLookup.isError || gated.outcome === "failed"
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
          : undefined));
  // A review address names its document: when it is unavailable because the
  // document was removed, it says so instead. A plain path names no document
  // once nothing lives there, so it stays "unavailable".
  const removedDocumentId =
    documentIssue === "unavailable" && address.itemKey
      ? (parseDraftItemKey(address.itemKey)?.documentId ?? null)
      : null;
  const removedDestination = useRemovalRecord(projectId, removedDocumentId);
  const removedTitle = documentDestination?.path.split("/").filter(Boolean).at(-1) ?? null;
  const switchFailure = useDocumentSwitchFailures();
  const failedDestination = destinationFailure(
    switchFailure.failures,
    location.href,
    location.state.__TSR_key ?? "",
  );
  const mainIssue =
    parsed.kind === "invalid"
      ? "unavailable"
      : destination.kind === "work" && routeWork.status === "unresolved"
        ? routeWork.reason
        : undefined;
  // The failed reads are what the address waits on; retrying them is the destination's recovery.
  const retryEditorAddress = useCallback(() => {
    switchFailure.clear();
    void documentLookup.refetch();
    refetchAddressCatalog();
    editorDrafts.refetch();
  }, [documentLookup.refetch, refetchAddressCatalog, editorDrafts.refetch]);
  const editorIssue = resourceDestination
    ? "resource-viewing"
    : ((localDocument.kind === "loading" || localDocument.kind === "unavailable"
        ? localDocument.kind
        : undefined) ??
      routeWorkIssue(editorWork) ??
      // A locally created document wins over the server address lookup.
      (localDocumentId
        ? undefined
        : (documentIssue ??
          (reviewItemKey
            ? // Review installs the tab; until it has, the address is still being repaired.
              address.itemKey === reviewItemKey &&
              workspaceTabs.some(
                (tab) =>
                  (address.itemKey && !isDraftOnly(tab) && tab.documentId === addressDocumentId) ||
                  matchesReviewItem(tab, {
                    reviewWorkId: workId ?? "",
                    reviewItemKey,
                  }),
              )
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
      workView: undefined,
      worksView: undefined,
    };
  }
  // A Work opens on its chats unless the target names Files: one address, so
  // one transition and one history entry, whatever screen it leaves.
  function workAddress(target: WorkDetailTarget): ProjectAddress {
    return workDetailAddress(address, target);
  }
  const contextDestination = useCallback(
    (target: ContextRouteRequest, preparedTab?: ContextTab, itemKey?: string) =>
      prepareEditorDestination(
        {
          projectId,
          accountId: user.userId,
          address: latest.current.address,
          noWorkId: latest.current.noWorkId,
        },
        target,
        preparedTab,
        itemKey,
      ),
    [projectId, user.userId],
  );
  const openContext = useMemo(
    () =>
      createEditorDocumentCommand({
        projectId,
        accountId: user.userId,
        read: () => ({ ...latest.current, addressDocumentId: addressDocumentIdRef.current }),
        lookup: (documentId) =>
          getProjectContextAvailability(projectId, [documentId]).then(
            (result) => result.resolutions[0] ?? { kind: "failed" as const },
            () => ({ kind: "failed" as const }),
          ),
        admitDraftReview: (installed, reviewWorkId) =>
          contextRemoval.admitDraftReview(projectId, installed, reviewWorkId),
      }),
    [contextRemoval, projectId, user.userId],
  );
  const setEditorReviewItemKey = useCallback((itemKey: string | null, changeId?: string) => {
    const current = latest.current;
    if (!current.navigation) return;
    const ticket = current.navigation.capture();
    const { address } = current;
    // A review names its Work: an address that left it implicit states the Editor's own now.
    const work =
      itemKey && address.work.kind === "absent" && current.editorWorkId
        ? workSelectionFor(address.destination, current.editorWorkId, current.noWorkId)
        : address.work;
    void current.navigation.replaceIfCurrent(ticket, {
      ...address,
      work,
      itemKey: itemKey ?? undefined,
      changeId: itemKey ? changeId : undefined,
    });
  }, []);
  const queryClient = useQueryClient();
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
    (target: ContextRouteTarget | { kind: "clear" }, prepared: PreparedWorkspaceNavigation) => {
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
    openWork: (target, options) => goLegacy(workAddress(target), options),
    workHref: (target) => projectAddressHref(workAddress(target)),
    workView: address.workView ?? "chats",
    setWorkView: (view) =>
      goLegacy({ ...address, workView: view === "files" ? "files" : undefined }, { replace: true }),
    worksView: address.worksView ?? "active",
    setWorksView: (view) =>
      goLegacy({ ...address, worksView: view === "active" ? undefined : view }, { replace: true }),
    closeWork: (options) => goLegacy(toDestination({ kind: "works" }), options),
    // Selecting no document keeps every open tab. Already on the chooser is a
    // no-op. A local draft is also `/editor`; its history pointer is the
    // selection. Navigation clears that pointer. Departure freezes it, so Back
    // returns to the draft.
    showEditorRecents: (options) => {
      const onChooser =
        destination.kind === "editor" &&
        (!("meridianProjectSelection" in location.state) ||
          location.state.meridianProjectSelection == null);
      return onChooser ? Promise.resolve() : goLegacy(toDestination({ kind: "editor" }), options);
    },
    openWorkContext: (target, options) =>
      target.path !== undefined
        ? openContext(
            { scheme: target.scheme, path: target.path, workId: target.workId },
            options,
          ).then((result) => {
            if (result.kind === "failed") throw result.error;
          })
        : goLegacy(
            {
              ...toDestination(browseDestination(target.scheme, target.folder ?? "")),
              work: workSelectionFor(
                browseDestination(target.scheme, target.folder ?? ""),
                target.workId,
                noWorkId,
              ),
            },
            options,
          ),
  };
  // A resource pointer holds identity, not an Untitled address. Once placement
  // exists, publish its real locator so the removal host does not repair it
  // back into this same pointer-bearing destination on every render.
  const localTarget =
    localDocument.kind === "resolved" && localDocument.owner.kind === "materialized-local"
      ? localDocument.owner.target
      : null;
  const search: ProjectSearch = {
    screen: activeScreen,
    work: workId ?? undefined,
    chat: documentDestination?.scheme === "scratch" ? address.lineage : undefined,
    scheme: localDocumentId
      ? (localTarget?.scheme ?? "unfiled")
      : destination.kind === "document" || destination.kind === "browse"
        ? (destination.scheme ?? undefined)
        : undefined,
    path: localDocumentId
      ? (localTarget?.path ?? "")
      : documentDestination
        ? `/${documentDestination.path}`
        : undefined,
    folder: browsedFolder(destination) ?? undefined,
    view: address.workView ?? address.worksView,
  };
  const editorDocument = {
    editorWorkId: workId,
    localDocumentId,
    activeContextScheme: search.scheme ?? null,
    activeContextPath: search.path ?? null,
    activeContextChat: search.chat ?? null,
  };
  const showScreenDestination = (
    next: "work" | "context",
    options?: { afterCommit?: () => void },
  ) => {
    // Work reopens the last opened Work while it still exists; else the collection.
    if (next === "work" && rememberedWork) return openRemembered();
    if (next === "context" && workId && contextRemoval.getProjectSnapshot(projectId).live) {
      const workspace = getContextTabs(projectId);
      const tab = selectEditorEntryTab({
        tabs: workspace.tabs,
        selectedDocumentId: workspace.selectedTabIdByWork[workId],
        recentRoutes: readRecentRoutes(projectId),
        workId,
      });
      if (tab)
        return openContext(
          { ...routeTargetForTab(tab, workId), documentId: tab.documentId },
          {
            ...options,
            ...(editorContainerAddress?.documentId === tab.documentId &&
            editorContainerAddress.workId === workId
              ? { itemKey: editorContainerAddress.address.itemKey }
              : {}),
          },
        );
    }
    return go(
      {
        ...toDestination({ kind: next === "work" ? "works" : "editor" }),
        work: workSelectionFor(
          { kind: next === "work" ? "works" : "editor" },
          rememberedEditor.current ?? workId ?? undefined,
          noWorkId,
        ),
      },
      { replace: false, ...options },
    );
  };
  const selectRailScreen = useRailScreenSwitch(
    activeScreen,
    (ticket) => latest.current.navigation?.isCurrent(ticket) ?? false,
  );
  const selectScreen = (next: ScreenKey) =>
    selectRailScreen(next, () =>
      next === "chat" ? chat.showChatScreen() : showScreenDestination(next),
    );
  // A project folder keeps the current editing context; a Work's folder names its Work.
  const browse = (scheme: ProjectContextTreeScheme | null, path = "") =>
    go(
      {
        ...toDestination(browseDestination(scheme, path)),
        work: workSelectionFor(browseDestination(scheme, path), workId ?? undefined, noWorkId),
      },
      { replace: false },
    );

  return (
    <ProjectNavigationProvider
      screen={activeScreen}
      openContextRoute={openContext}
      openWork={routeCommands.openWork}
      screenCommands={{
        showEditor: (options) => showScreenDestination("context", options),
        showWork: () => showScreenDestination("work"),
      }}
      isCurrentNavigation={(ticket) => latest.current.navigation?.isCurrent(ticket) ?? false}
      captureNavigation={captureNavigation}
      isCurrentContextRoute={isCurrentContextRoute}
      registerLeaveGuard={navigation?.registerGuard}
    >
      <ChatNavigationProvider value={chat}>
        <ProjectDocumentNavigationProvider
          projectId={projectId}
          captureNavigation={captureNavigation}
        >
          {documentDestination && !localDocumentId ? (
            <ProjectAddressDocument
              projectId={projectId}
              href={location.href}
              entryKey={location.state.__TSR_key ?? ""}
              address={address}
              // Cached paths can have been renamed or reused; only a settled lookup may repair the URL.
              result={documentResult}
              localFile={reconciledDocumentAddress.localFile}
              reviewItemKey={reviewItemKey}
              workId={workId}
              noWorkId={noWorkId}
              navigation={navigation}
              onAdmission={setAdmission}
            />
          ) : null}
          <ProjectView
            project={project}
            projectId={projectId}
            activeScreen={activeScreen}
            chatDisplay={chat.display}
            entryHydration={entryHydration}
            routeWork={routeWork}
            rememberedWork={rememberedWork}
            editorRouteWork={editorWork}
            routeLocationKey={location.state.__TSR_key ?? location.href}
            routeIssues={{
              main: failedDestination ? "error" : mainIssue,
              // Loading until the removal lookup answers, so the destination
              // never says "unavailable", then who removed it.
              editor: failedDestination
                ? "error"
                : removedDocumentId !== null && removedDestination === undefined
                  ? "loading"
                  : editorIssue,
              removed:
                removedDestination?.kind === "removed"
                  ? { title: removedTitle, record: removedDestination.record }
                  : undefined,
            }}
            onRetryEditorRoute={retryEditorAddress}
            onDisplayedSelection={reportSelection}
            routeCommands={routeCommands}
            contextRemovalRoute={{
              transition: (_id, target, prepared) => closeDestination(target, prepared),
              readSearch: () => search,
              updateSearch: (_id, update, relocated) =>
                applyContextRemovalSearchUpdate({
                  search,
                  update,
                  itemKey: address.itemKey,
                  relocated,
                  openContext,
                  goWorks: () => void go(toDestination({ kind: "works" }), { replace: true }),
                  goEditor: () => void go(toDestination({ kind: "editor" }), { replace: true }),
                }),
            }}
            activeLocalDocumentId={editorDocument.localDocumentId}
            activeContextScheme={editorDocument.activeContextScheme}
            activeContextFolder={search.folder ?? null}
            activeContextPath={editorDocument.activeContextPath}
            activeContextChat={editorDocument.activeContextChat}
            reviewItemKey={address.itemKey}
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
            onSelectScreen={selectScreen}
            onSelectContextScheme={(scheme) => browse(scheme)}
            onExitContextScheme={() => browse(null)}
            onSelectContextFolder={(path) => browse(search.scheme ?? null, path)}
            onOpenContextTarget={openContext}
            onSetEditorReviewItemKey={setEditorReviewItemKey}
          />
        </ProjectDocumentNavigationProvider>
      </ChatNavigationProvider>
    </ProjectNavigationProvider>
  );
}
