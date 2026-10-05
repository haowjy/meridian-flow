/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { useQuery } from "@tanstack/react-query";
import { useBlocker, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getProjectDocumentAddress } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProjectThreads } from "@/client/query/useProjectThreads";
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
import {
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
  workIdSelection,
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
  type ContextRouteTarget,
  type NavigationOptions,
  type ProjectRouteCommands,
  type ProjectSearch,
  projectSearchEquals,
  type RouteWorkResolution,
  routeWorkIssue,
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
  const rememberedEditor = useRef<string | null | undefined>(undefined);
  const requestedWork = addressWorkSelection(address);
  // Chat may seed a genuinely absent Editor context once, never rebind it after navigation.
  const editorSelection =
    activeScreen === "context" && requestedWork.kind !== "absent"
      ? requestedWork
      : workIdSelection(
          rememberedEditor.current !== undefined
            ? rememberedEditor.current
            : (displayedChat?.workId ?? null),
        );
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
  const editorWork: RouteWorkResolution = editorDefaultPending
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
    if (localDocumentId)
      void useContextTabsStore.getState().selectTab(projectId, workId ?? "", localDocumentId);
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

  const latest = useRef({ address, location, navigation });
  latest.current = { address, location, navigation };
  const captureNavigation = useCallback(() => {
    const current = latest.current.navigation;
    const ticket = current?.beginIntent();
    return () => !!ticket && !!current?.isCurrent(ticket);
  }, []);
  const reportSelection = useCallback(
    ({ editorWorkId: workId }: { editorWorkId: ParsedRequestId | null }) => {
      shown.current = {
        work: workSelectionFor(
          address.destination,
          workId ?? undefined,
          workCatalog.noWork?.id ?? null,
        ),
        local: localPointer,
      };
      if (activeScreen === "context" && !routeWorkIssue(editorWork))
        rememberedEditor.current = workId;
    },
    [activeScreen, editorWork.status],
  );

  // A scheme the Editor never opens (Uploads) shows in its resource view.
  const resourceDestination =
    (destination.kind === "document" || destination.kind === "browse") &&
    destination.scheme !== null &&
    !isEditorScheme(destination.scheme);
  const documentDestination =
    destination.kind === "document" && !resourceDestination ? destination : null;
  const addressWorkId = address.work.kind === "id" ? address.work.id : null;
  const { catalog: addressCatalog } = useContextCatalogView(
    projectId,
    documentDestination?.scheme ?? "manuscript",
    {
      workId: documentDestination?.scheme === "scratch" ? addressWorkId : null,
      enabled: !!documentDestination && !routeWorkIssue(routeWork),
    },
  );
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
    enabled: !!documentDestination && !routeWorkIssue(routeWork),
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
  const reconciledDocumentAddress = reconcileDocumentAddress(
    localDocumentAddress,
    documentLookup.data,
  );
  const documentResult = reconciledDocumentAddress.result;
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : (routeWorkIssue(routeWork) ??
      (!documentResult && documentLookup.isError
        ? "error"
        : !documentResult
          ? "loading"
          : documentResult.kind === "unavailable"
            ? "unavailable"
            : undefined));
  const mainIssue =
    parsed.kind === "invalid"
      ? "unavailable"
      : destination.kind === "work" && routeWork.status === "unresolved"
        ? routeWork.reason
        : undefined;
  const editorIssue = resourceDestination
    ? "resource-viewing"
    : ((localDocument.kind === "loading" || localDocument.kind === "unavailable"
        ? localDocument.kind
        : undefined) ??
      routeWorkIssue(editorWork) ??
      (localDocumentId ? undefined : documentIssue) ??
      (documentDestination && !localDocumentId
        ? admission?.href === location.href &&
          admission.key === (location.state.__TSR_key ?? "") &&
          documentResult?.kind !== "unavailable" &&
          admission.documentId === documentResult?.document.documentId
          ? admission.issue
          : "loading"
        : undefined));

  async function go(next: ProjectAddress, options: NavigationOptions) {
    if (!navigation) return;
    return navigation.navigate(next, options);
  }
  function toDestination(next: ProjectDestination): ProjectAddress {
    return {
      ...address,
      destination: next,
      workView: next.kind === "work" ? address.workView : undefined,
      worksView: undefined,
      results: false,
    };
  }
  const contextDestination = useCallback(
    (target: ContextRouteTarget, preparedTab?: ContextTab) => {
      const current = latest.current;
      let state: Record<string, unknown> | undefined;
      // A locally created document keeps its stable selection even when its
      // readable address is reused or its background placement is rejected.
      if (
        target.path === "" ||
        (preparedTab?.kind === "tracked" && preparedTab.origin === "local-resource")
      ) {
        const workspace = getContextTabs(projectId);
        const documentId = target.documentId ?? workspace.selectedTabIdByWork[target.workId ?? ""];
        const tabs = preparedTab
          ? [
              ...workspace.tabs.filter((tab) => tab.documentId !== preparedTab.documentId),
              preparedTab,
            ]
          : workspace.tabs;
        const selected = tabs.find((tab) => tab.documentId === documentId);
        if (!selected?.resourceHandle) throw new Error("Local document is unavailable");
        const pointer = {
          version: 2,
          accountId: user.userId,
          projectId,
          resourceHandle: selected.resourceHandle,
        };
        const resolved = resolveLocalDocumentSelection({
          pointer,
          accountId: user.userId,
          projectId,
          workId:
            selected.kind !== "new" && isWorkScopedScheme(selected.scheme)
              ? (selected.workId ?? null)
              : target.workId,
          hydrated: true,
          tabs,
        });
        if (resolved.kind !== "resolved") throw new Error("Local document is unavailable");
        state = { meridianProjectSelection: pointer };
      }
      return {
        address: {
          ...current.address,
          destination: target.path
            ? { kind: "document", scheme: target.scheme, path: target.path.replace(/^\/+/, "") }
            : { kind: "editor" },
          work: workIdSelection(target.workId),
          results: false,
        } as ProjectAddress,
        state,
      };
    },
    [projectId, user.userId],
  );
  const openContext = useCallback(
    async (
      target: ContextRouteTarget,
      options?: OpenContextOptions,
    ): Promise<NavigationSettlement> => {
      const current = latest.current;
      if (!current.navigation || options?.isCurrent?.() === false) return { kind: "superseded" };
      const next = contextDestination(target, options?.tab);
      const workspace = getContextTabs(projectId);
      const tab = target.documentId
        ? workspace.tabs.find((tab) => tab.documentId === target.documentId)
        : workspace.tabs.find(
            (tab) => tab.kind !== "new" && tab.scheme === target.scheme && tab.path === target.path,
          );
      const result = await current.navigation.transition(
        next.address,
        { replace: options?.replace ?? false, state: next.state },
        {
          isCurrent: () =>
            options?.canCommit?.() !== false &&
            (!tab ||
              getContextTabs(projectId).tabs.some(
                (member) => member.tabInstanceId === tab.tabInstanceId,
              )),
          commit: () => {
            if (options?.tab) {
              const installed = useContextTabsStore.getState().openTab(projectId, options.tab);
              if (installed.kind !== "opened") throw new Error("Editor tab could not be opened");
            }
            const selected = options?.tab ?? tab;
            if (selected)
              void useContextTabsStore
                .getState()
                .selectTab(
                  projectId,
                  selected.kind !== "new" && isWorkScopedScheme(selected.scheme)
                    ? (selected.workId ?? "")
                    : (target.workId ?? ""),
                  selected.documentId,
                );
          },
        },
      );
      return result;
    },
    [contextDestination, projectId],
  );
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
    openWork: (target, options) =>
      go(toDestination({ kind: "work", workId: target.workId }), options),
    workHref: (target) =>
      projectAddressHref(toDestination({ kind: "work", workId: target.workId })),
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
              work: workIdSelection(target.workId),
            },
            options,
          ),
  };
  const search: ProjectSearch = {
    screen: activeScreen,
    work: workId ?? "none",
    scheme: localDocumentId
      ? "unfiled"
      : destination.kind === "document" || destination.kind === "browse"
        ? (destination.scheme ?? undefined)
        : undefined,
    path: localDocumentId ? "" : documentDestination ? `/${documentDestination.path}` : undefined,
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
    if (next === "context" && contextRemoval.getProjectSnapshot(projectId).live) {
      const workspace = getContextTabs(projectId);
      const tab = selectEditorEntryTab({
        tabs: workspace.tabs,
        selectedDocumentId: workspace.selectedTabIdByWork[workId ?? ""],
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
        work: workIdSelection(rememberedEditor.current ?? workId),
      },
      { replace: false },
    );
  };
  // A project folder keeps the current editing context; a Work's folder names its Work.
  const browse = (scheme: ProjectContextTreeScheme | null, path = "") =>
    go(
      {
        ...toDestination(browseDestination(scheme, path)),
        ...(isWorkScopedScheme(scheme) ? { work: workIdSelection(workId) } : {}),
      },
      { replace: false },
    );

  return (
    <ProjectNavigationProvider
      screen={activeScreen}
      openContextRoute={openContext}
      captureNavigation={captureNavigation}
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
              workId={workId}
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
                      workId: next.work === "none" ? null : (next.work ?? workId),
                    },
                    { replace: true },
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
            resultsOpen={address.results}
            onSelectScreen={selectScreen}
            onSelectContextScheme={(scheme) => browse(scheme)}
            onExitContextScheme={() => browse(null)}
            onSelectContextFolder={(path) => browse(search.scheme ?? null, path)}
            onOpenContextTarget={openContext}
            onOpenResults={() => go({ ...address, results: true }, { replace: true })}
            onCloseResults={() => go({ ...address, results: false }, { replace: true })}
          />
        </ProjectDocumentNavigationProvider>
      </ChatNavigationProvider>
    </ProjectNavigationProvider>
  );
}
