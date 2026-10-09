/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { useQuery } from "@tanstack/react-query";
import { useBlocker, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getProjectContextAvailability,
  getProjectDocumentAddress,
} from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import {
  type ContextTab,
  getContextTabs,
  isEditorScheme,
  useContextTabs,
  useContextTabsStore,
} from "@/client/stores";
import { readRecentRoutes, type WorkingSetHydrationPlan } from "@/client/working-set";
import { originalBrowserSearch } from "@/router-search";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { routeTargetForTab } from "../context/context-removal-planner";
import { contextTabMatchesRoute } from "../context/context-tab-identity";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { ProjectView } from "../ProjectView";
import type { ScreenKey } from "../shell/screens";
import {
  ChatNavigationProvider,
  chatSurfaceThreadId,
  useProjectChatNavigation,
} from "./chat-navigation";
import { editorDefaultWorkPending } from "./editor-default-work";
import { resolveLaunchLocator } from "./launch-locator";
import {
  canonicalDocumentPath,
  gateLiveView,
  projectAddressMatchesContextTarget,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
  routeContinuityDocumentId,
} from "./local-document-address";
import { type AddressAdmission, ProjectAddressDocument } from "./ProjectAddressDocument";
import { type OpenContextOptions, ProjectNavigationProvider } from "./ProjectNavigationContext";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import {
  type AddressSelection,
  browseDestination,
  isWorkScopedScheme,
  type ProjectAddress,
  type ProjectDestination,
  parseProjectAddress,
  projectAddressHref,
} from "./project-address";
import { addressWorkSelection, workSelectionFor } from "./project-address-resolution";
import { resolveLocalDocumentSelection, selectEditorEntryTab } from "./project-local-selection";
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
  projectSearchEquals,
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

/** A prepared tab states the locator the route will use, not the one it was built from. */
function tabAtLocator(tab: ContextTab, locator: ContextRouteRequest): ContextTab {
  if (tab.kind === "new" || (tab.scheme === locator.scheme && tab.path === locator.path))
    return tab;
  return {
    ...tab,
    scheme: locator.scheme,
    path: locator.path,
    name: locator.path.slice(locator.path.lastIndexOf("/") + 1),
  };
}

export function ReadableProjectRoute({
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
          results: false,
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
        replaceEntry: (href, state) => router.history.replace(href, state, { ignoreBlocker: true }),
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
  const { catalog: manuscriptCatalog } = useContextCatalogView(projectId, "manuscript", {
    workId: null,
    enabled: false,
  });
  const latest = useRef({
    address,
    location,
    navigation,
    editorWorkId: workId,
    noWorkId,
    manuscriptCatalog,
  });
  latest.current = {
    address,
    location,
    navigation,
    editorWorkId: workId,
    noWorkId,
    manuscriptCatalog,
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
  const {
    catalog: addressCatalog,
    isComplete: addressCatalogComplete,
    isFetching: addressCatalogFetching,
    isError: addressCatalogError,
    refetch: refetchAddressCatalog,
  } = useContextCatalogView(projectId, documentDestination?.scheme ?? "manuscript", {
    workId: documentDestination?.scheme === "scratch" ? addressWorkId : null,
    enabled: !!documentDestination && editorWork.status === "present",
  });
  const [admission, setAdmission] = useState<AddressAdmission | null>(null);
  const documentLookup = useQuery({
    queryKey: [
      ...projectQueryKeys.documentAddresses(projectId),
      documentDestination?.scheme,
      documentDestination?.path,
      documentDestination?.scheme === "scratch" ? addressWorkId : null,
      addressCatalog?.normalized.generation,
      addressCatalog?.normalized.appliedRevision,
    ],
    queryFn: () => {
      if (!documentDestination) throw new Error("Document address is required");
      return getProjectDocumentAddress(
        projectId,
        documentDestination.scheme,
        documentDestination.path,
        { workId: documentDestination.scheme === "scratch" ? addressWorkId : null },
      );
    },
    enabled: !!documentDestination && editorWork.status === "present",
    staleTime: 0,
    retry: false,
  });
  const { selection } = useContextRemovalProject(projectId);
  const boundDocumentId = routeContinuityDocumentId({
    selection,
    admittedDocumentId: admission?.documentId ?? null,
    destination: documentDestination,
    editorWorkId: workId,
  });
  const localDocumentAddress = useMemo(
    () =>
      documentDestination
        ? resolveLocalDocumentAddress(
            projectId,
            documentDestination,
            addressWorkId,
            addressCatalog,
            boundDocumentId,
          )
        : undefined,
    [addressCatalog, documentDestination, addressWorkId, projectId, boundDocumentId],
  );
  const editorDrafts = useWorkDrafts(
    projectId,
    documentDestination?.scheme === "manuscript" ? workId : null,
  );
  const reconciledDocumentAddress = reconcileDocumentAddress(
    localDocumentAddress,
    documentLookup.data,
  );
  const gated = gateLiveView(
    reconciledDocumentAddress.result,
    documentDestination?.scheme ?? "",
    {
      catalog: addressCatalog,
      isComplete: addressCatalogComplete,
      isFetching: addressCatalogFetching,
      isError: addressCatalogError,
    },
    editorDrafts,
    (documentId) => workspaceTabs.some((tab) => !tab.draftOnly && tab.documentId === documentId),
  );
  const documentResult = gated.result;
  const draftOnly = gated.outcome === "ready" ? gated.draftOnly : undefined;
  const addressDocumentId =
    documentResult && documentResult.kind !== "unavailable"
      ? documentResult.document.documentId
      : undefined;
  addressDocumentIdRef.current = addressDocumentId;
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : (routeWorkIssue(routeWork) ??
      (!documentResult
        ? // A prerequisite that failed ends the wait: the address stays, with a way to retry.
          documentLookup.isError || gated.outcome === "failed"
          ? "error"
          : "loading"
        : documentResult.kind === "unavailable"
          ? "unavailable"
          : undefined));
  const mainIssue =
    parsed.kind === "invalid"
      ? "unavailable"
      : destination.kind === "work" && routeWork.status === "unresolved"
        ? routeWork.reason
        : undefined;
  // The failed reads are what the address waits on; retrying them is the destination's recovery.
  const retryEditorAddress = useCallback(() => {
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
          (draftOnly
            ? // Review installs the tab; until it has, the address is still being repaired.
              address.draftId === draftOnly.draft.draftId &&
              workspaceTabs.some((tab) => tab.documentId === draftOnly.documentId)
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

  async function go(next: ProjectAddress, options: NavigationOptions) {
    if (!navigation) return;
    return navigation.navigate(next, options);
  }
  function toDestination(next: ProjectDestination): ProjectAddress {
    return {
      ...address,
      destination: next,
      draftId: undefined,
      workView: undefined,
      worksView: undefined,
      results: false,
    };
  }
  // A Work opens on its chats unless the target names Files: one address, so
  // one transition and one history entry, whatever screen it leaves.
  function workAddress(target: WorkDetailTarget): ProjectAddress {
    return {
      ...toDestination({ kind: "work", workId: target.workId }),
      workView: target.view === "files" ? "files" : undefined,
    };
  }
  const contextDestination = useCallback(
    (target: ContextRouteRequest, preparedTab?: ContextTab, draftId?: string) => {
      const current = latest.current;
      let state: Record<string, unknown> | undefined;
      const workspace = getContextTabs(projectId);
      const resolvedWorkId = target.workId;
      const documentId =
        target.documentId ??
        (target.path === "" && resolvedWorkId
          ? workspace.selectedTabIdByWork[resolvedWorkId]
          : undefined);
      const tab = documentId
        ? workspace.tabs.find((tab) => tab.documentId === documentId)
        : resolvedWorkId
          ? workspace.tabs.find((tab) =>
              contextTabMatchesRoute(tab, target.scheme, target.path, resolvedWorkId),
            )
          : undefined;
      const selected = preparedTab ?? tab;
      // A locally created document keeps its stable selection even when its
      // readable address is reused or its background placement is rejected.
      if (
        target.path === "" ||
        (selected?.kind === "tracked" && selected.origin === "local-resource")
      ) {
        const tabs = preparedTab
          ? [
              ...workspace.tabs.filter((tab) => tab.documentId !== preparedTab.documentId),
              preparedTab,
            ]
          : workspace.tabs;
        if (
          !selected?.resourceHandle ||
          (selected.kind !== "new" &&
            !(selected.kind === "tracked" && selected.origin === "local-resource"))
        )
          throw new Error("Local document is unavailable");
        const pointer = {
          version: 2,
          accountId: user.userId,
          projectId,
          resourceHandle: selected.resourceHandle,
        };
        // Pointer identity is ready now; Editor Work membership waits for resolution.
        const resolved = resolvedWorkId
          ? resolveLocalDocumentSelection({
              pointer,
              accountId: user.userId,
              projectId,
              workId: routeTargetForTab(selected, resolvedWorkId).workId,
              hydrated: true,
              tabs,
            })
          : null;
        if (resolved && resolved.kind !== "resolved")
          throw new Error("Local document is unavailable");
        state = { meridianProjectSelection: pointer };
      }
      const destination: ProjectDestination = target.path
        ? { kind: "document", scheme: target.scheme, path: canonicalDocumentPath(target.path) }
        : { kind: "editor" };
      return {
        tab,
        address: {
          ...current.address,
          destination,
          work: workSelectionFor(destination, target.workId, current.noWorkId),
          draftId,
          results: false,
        } as ProjectAddress,
        state,
      };
    },
    [projectId, user.userId],
  );
  const openContext = useCallback(
    async (
      request: ContextRouteRequest,
      options?: OpenContextOptions,
    ): Promise<NavigationSettlement> => {
      const current = latest.current;
      if (!current.navigation || options?.isCurrent?.() === false) return { kind: "superseded" };
      const resolvedWorkId = request.workId ?? current.editorWorkId;
      const requested = { ...request, workId: resolvedWorkId ?? undefined };
      // Identity decides sameness once the address has resolved; the path is
      // only the fallback before that.
      const sameDocument = projectAddressMatchesContextTarget(
        current.address,
        requested,
        current.noWorkId,
        addressDocumentIdRef.current,
        current.editorWorkId,
      );
      // A review launch carries the locator its draft row captured, which a rename or a
      // reused path can have outdated. Identity decides where that document is now.
      let target: ContextRouteRequest = requested;
      if (options?.replaceIfSameDocument === true) {
        try {
          target = await resolveLaunchLocator({
            requested,
            tabs: getContextTabs(projectId).tabs,
            addressed: current.address.destination,
            addressNamesIt: sameDocument,
            draftOnly: options.tab?.kind === "tracked" && options.tab.draftOnly === true,
            catalog: current.manuscriptCatalog,
            lookup: (documentId) =>
              getProjectContextAvailability(projectId, [documentId]).then(
                (result) => result.resolutions[0] ?? { kind: "failed" as const },
                () => ({ kind: "failed" as const }),
              ),
          });
        } catch (error) {
          return { kind: "failed", error, ticket: current.navigation.capture() };
        }
        if (options.isCurrent?.() === false) return { kind: "superseded" };
      }
      const preparedTab = options?.tab ? tabAtLocator(options.tab, target) : undefined;
      // Re-opening the document the address names (a rename or move following
      // its own placement, a review re-launch) keeps the review the address
      // carries; any other document starts without one.
      const next = contextDestination(
        target,
        preparedTab,
        options?.draftId ?? (sameDocument ? current.address.draftId : undefined),
      );
      const tab = next.tab;
      // Install the prepared tab and select it in its own Work. A Review launch
      // re-admits its pending draft, so Back cannot keep the address closed.
      const settleTab = () => {
        let selected = tab;
        if (preparedTab) {
          const installed = useContextTabsStore.getState().openTab(projectId, preparedTab);
          if (installed.kind !== "opened") throw new Error("Editor tab could not be opened");
          if (installed.tab.kind === "tracked")
            contextRemoval.admitDraftReview(projectId, installed.tab);
          selected = installed.tab;
        }
        if (selected && resolvedWorkId)
          void useContextTabsStore
            .getState()
            .selectTab(
              projectId,
              selected.kind !== "new" && isWorkScopedScheme(selected.scheme)
                ? routeTargetForTab(selected, resolvedWorkId).workId
                : resolvedWorkId,
              selected.documentId,
            );
      };
      // Reviewing the document the address already names rewrites `?draft=` in
      // place; any other document is a new history entry.
      if (
        options?.replace === undefined &&
        options?.replaceIfSameDocument === true &&
        sameDocument
      ) {
        const replacement = await current.navigation.replaceIfCurrent(
          current.navigation.capture(),
          next.address,
        );
        if (replacement.kind === "replaced") {
          settleTab();
          return { kind: "applied" };
        }
        if (replacement.kind === "failed") return replacement;
        return { kind: "superseded" };
      }
      return current.navigation.transition(
        next.address,
        { replace: options?.replace ?? false, state: next.state },
        {
          isCurrent: () =>
            options?.canCommit?.() !== false &&
            (!tab ||
              getContextTabs(projectId).tabs.some(
                (member) => member.tabInstanceId === tab.tabInstanceId,
              )),
          commit: settleTab,
        },
      );
    },
    [contextDestination, contextRemoval, projectId],
  );
  const setEditorReviewDraftId = useCallback((draftId: string | null) => {
    const current = latest.current;
    if (!current.navigation) return;
    const ticket = current.navigation.capture();
    const { address } = current;
    // A review names its Work: an address that left it implicit states the Editor's own now.
    const work =
      draftId && address.work.kind === "absent" && current.editorWorkId
        ? workSelectionFor(address.destination, current.editorWorkId, current.noWorkId)
        : address.work;
    void current.navigation.replaceIfCurrent(ticket, {
      ...address,
      work,
      draftId: draftId ?? undefined,
    });
  }, []);
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
                results: false,
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

  const routeCommands: ProjectRouteCommands = {
    openWork: (target, options) => go(workAddress(target), options),
    workHref: (target) => projectAddressHref(workAddress(target)),
    workView: address.workView ?? "chats",
    setWorkView: (view) =>
      go({ ...address, workView: view === "files" ? "files" : undefined }, { replace: true }),
    worksView: address.worksView ?? "active",
    setWorksView: (view) =>
      go({ ...address, worksView: view === "active" ? undefined : view }, { replace: true }),
    closeWork: (options) => go(toDestination({ kind: "works" }), options),
    // Selecting no document keeps every open tab. Already on the chooser is a
    // no-op. A local draft is also `/editor`; its history pointer is the
    // selection. Navigation clears that pointer. Departure freezes it, so Back
    // returns to the draft.
    showEditorRecents: (options) => {
      const onChooser =
        destination.kind === "editor" &&
        (!("meridianProjectSelection" in location.state) ||
          location.state.meridianProjectSelection == null);
      return onChooser ? Promise.resolve() : go(toDestination({ kind: "editor" }), options);
    },
    openWorkContext: (target, options) =>
      target.path !== undefined
        ? openContext(
            { scheme: target.scheme, path: target.path, workId: target.workId },
            options,
          ).then((result) => {
            if (result.kind === "failed") throw result.error;
          })
        : go(
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
    folder: destination.kind === "browse" ? `/${destination.path}` : undefined,
    results: address.results ? "" : undefined,
    view: address.workView ?? address.worksView,
  };
  const selectScreen = (next: ScreenKey) => {
    if (next === activeScreen && next !== "chat") return Promise.resolve();
    // Chat reopens the current chat; with none, its index.
    if (next === "chat") return chat.showChatScreen();
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
        return openContext({ ...routeTargetForTab(tab, workId), documentId: tab.documentId }).then(
          (result) => {
            if (result.kind === "failed") throw result.error;
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
      { replace: false },
    );
  };
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
              draftOnlyId={draftOnly?.draft.draftId}
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
            addressOwnsDocumentAdmission
            routeWork={routeWork}
            rememberedWork={rememberedWork}
            editorRouteWork={editorWork}
            routeLocationKey={location.state.__TSR_key ?? location.href}
            routeIssues={{ main: mainIssue, editor: editorIssue }}
            onRetryEditorRoute={retryEditorAddress}
            onDisplayedSelection={reportSelection}
            routeCommands={routeCommands}
            contextRemovalRoute={{
              transition: (_id, target, prepared) => closeDestination(target, prepared),
              readSearch: () => search,
              updateSearch: (_id, update) => {
                const next = update(search);
                if (projectSearchEquals(next, search)) return;
                if (next.scheme && next.path !== undefined)
                  void openContext(
                    {
                      scheme: next.scheme,
                      path: next.path,
                      workId: next.work,
                    },
                    {
                      replace: true,
                      // The coordinator relocates the document the address names,
                      // or falls back to another. Either way the review follows
                      // the address until EditorReviewAddressOwner, which knows
                      // the document's identity, decides it no longer applies.
                      draftId: address.draftId,
                    },
                  );
                else if (next.screen === "work")
                  void go(toDestination({ kind: "works" }), { replace: true });
                else if (next.screen === "context")
                  void go(toDestination({ kind: "editor" }), { replace: true });
              },
            }}
            activeLocalDocumentId={localDocumentId}
            activeContextScheme={search.scheme ?? null}
            activeContextFolder={search.folder ?? null}
            activeContextPath={search.path ?? null}
            reviewDraftId={address.draftId}
            reviewAddressDocumentId={addressDocumentId}
            resultsOpen={address.results}
            onSelectScreen={selectScreen}
            onSelectContextScheme={(scheme) => browse(scheme)}
            onExitContextScheme={() => browse(null)}
            onSelectContextFolder={(path) => browse(search.scheme ?? null, path)}
            onOpenContextTarget={openContext}
            onSetEditorReviewDraftId={setEditorReviewDraftId}
            onOpenResults={() => go({ ...address, results: true }, { replace: true })}
            onCloseResults={() => go({ ...address, results: false }, { replace: true })}
          />
        </ProjectDocumentNavigationProvider>
      </ChatNavigationProvider>
    </ProjectNavigationProvider>
  );
}
