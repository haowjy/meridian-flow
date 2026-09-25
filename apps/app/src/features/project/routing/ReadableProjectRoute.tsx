/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { WorksSnapshot } from "@meridian/contracts/works";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getProjectDocumentAddress } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import {
  type ContextTab,
  getContextTabs,
  useContextTabs,
  useContextTabsStore,
} from "@/client/stores";
import { hydrateWorkingSet, readRecentRoutes } from "@/client/working-set";
import { originalBrowserSearch } from "@/router-search";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { routeTargetForTab } from "../context/context-removal-planner";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { ProjectView } from "../ProjectView";
import type { ScreenKey } from "../shell/screens";
import {
  ChatNavigationProvider,
  chatSurfaceThreadId,
  useProjectChatNavigation,
} from "./chat-navigation";
import { editorDefaultWorkPending } from "./editor-default-work";
import { reconcileDocumentAddress, resolveLocalDocumentAddress } from "./local-document-address";
import { type AddressAdmission, ProjectAddressDocument } from "./ProjectAddressDocument";
import { type OpenContextOptions, ProjectNavigationProvider } from "./ProjectNavigationContext";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import {
  type AddressSelection,
  type ProjectAddress,
  type ProjectDestination,
  parseProjectAddress,
  projectAddressHref,
} from "./project-address";
import {
  type AddressResolution,
  addressWorkSelection,
  resolveAddressSelection,
} from "./project-address-resolution";
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
} from "./project-route";

const NONE: AddressSelection = { kind: "none" };
function selection(slug: string | null): AddressSelection {
  return slug ? { kind: "slug", slug } : NONE;
}
function issue<T>(
  resolution: AddressResolution<T>,
): Exclude<ProjectRouteIssue, "resource-viewing"> | undefined {
  if (resolution.status === "loading" || resolution.status === "error") return resolution.status;
  if (resolution.status === "unavailable" || resolution.status === "malformed")
    return "unavailable";
}
function routeWork(resolution: AddressResolution<Work>): RouteWorkResolution {
  if (resolution.status === "resolved") {
    const workId = parseRequestId(resolution.value.id);
    if (!workId) throw new Error("Invalid persisted Work identity");
    return { status: "present", workId, work: resolution.value };
  }
  const failure = issue(resolution);
  if (failure)
    return {
      status: "unresolved",
      reason: failure,
      slug:
        resolution.status === "malformed"
          ? resolution.value
          : "slug" in resolution
            ? resolution.slug
            : "",
    };
  return { status: "none" };
}
function screen(destination: ProjectDestination): ScreenKey {
  if (destination.kind === "work" || destination.kind === "works") return "work";
  if (destination.kind === "chat" || destination.kind === "chat-index") return "chat";
  return "context";
}

export function ReadableProjectRoute({
  project,
  data,
  user,
}: {
  project: Project;
  data: ProjectRouteData;
  user: { userId: string; workingSetSyncEnabled?: boolean | null };
}) {
  const projectId = project.id;
  const contextRemoval = useContextRemovalCoordinator();
  const queryClient = useQueryClient();
  useState(() => {
    seedProjectRouteData(queryClient, projectId, data);
    return null;
  });
  const [entryHydration] = useState(() =>
    hydrateWorkingSet(projectId, data.workingSet, user.workingSetSyncEnabled === true),
  );
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
  const threads = useProjectThreads(projectId);
  const works = useWorks(projectId);
  const workCatalog =
    works.status === "ready" || works.status === "empty"
      ? { status: "ready" as const, entries: works.works ?? [] }
      : { status: works.status === "error" ? ("error" as const) : ("loading" as const) };
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
  const work = resolveAddressSelection(requestedWork, workCatalog);
  // Chat may seed a genuinely absent Editor context once, never rebind it after navigation.
  const editorSelection =
    activeScreen === "context" && requestedWork.kind !== "absent"
      ? requestedWork
      : selection(
          rememberedEditor.current !== undefined
            ? rememberedEditor.current
            : (works.works?.find((value) => value.id === displayedChat?.workId)?.slug ?? null),
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
  const editorWork: AddressResolution<Work> = editorDefaultPending
    ? { status: works.status === "error" || threads.isError ? "error" : "loading", slug: "" }
    : resolveAddressSelection(editorSelection, workCatalog);
  const workId = editorWork.status === "resolved" ? editorWork.value.id : null;
  const { tabs: workspaceTabs } = useContextTabs(projectId);
  const workspaceHydrated = useContextTabsStore((state) => state._workspaceHydrated);
  const localDocument = resolveLocalDocumentSelection({
    pointer:
      destination.kind === "editor"
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
  const shown = useRef<DisplayedProjectSelection>({ workSlug: null });
  const [navigation, setNavigation] = useState<ReturnType<typeof createProjectNavigation> | null>(
    null,
  );
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
    navigation.repairQuerySelections(ticket, {
      work: works.isFetching ? { status: "loading" } : workCatalog,
    });
  }, [navigation, location, works.works, works.status, works.isFetching]);

  const latest = useRef({ address, location, navigation, works: works.works });
  latest.current = { address, location, navigation, works: works.works };
  const captureNavigation = useCallback(() => {
    const current = latest.current.navigation;
    const ticket = current?.beginIntent();
    return () => !!ticket && !!current?.isCurrent(ticket);
  }, []);
  const reportSelection = useCallback(
    (value: { editorWorkId: string | null }) => {
      const workSlug = works.works?.find((work) => work.id === value.editorWorkId)?.slug ?? null;
      shown.current = { workSlug, local: localPointer };
      if (activeScreen === "context" && !issue(editorWork)) rememberedEditor.current = workSlug;
    },
    [works.works, activeScreen, editorWork.status],
  );

  const resourceDestination =
    (destination.kind === "document" || destination.kind === "browse") &&
    (destination.scheme === "scratch" || destination.scheme === "uploads");
  const documentDestination =
    destination.kind === "document" && !resourceDestination ? destination : null;
  const sourceWorkId =
    documentDestination?.workSlug && work.status === "resolved" ? work.value.id : null;
  const { catalog: addressCatalog } = useContextCatalogView(
    projectId,
    documentDestination?.scheme ?? "manuscript",
    { workId: sourceWorkId, enabled: !!documentDestination && !issue(work) },
  );
  const [admission, setAdmission] = useState<AddressAdmission | null>(null);
  const documentLookup = useQuery({
    queryKey: [
      ...projectQueryKeys.documentAddresses(projectId),
      documentDestination?.scheme,
      documentDestination?.path,
      sourceWorkId,
      addressCatalog?.normalized.generation,
      addressCatalog?.normalized.appliedRevision,
    ],
    queryFn: () => {
      if (!documentDestination) throw new Error("Document address is required");
      return getProjectDocumentAddress(
        projectId,
        documentDestination.scheme,
        documentDestination.path,
        sourceWorkId ? { workId: sourceWorkId } : undefined,
      );
    },
    enabled: !!documentDestination && !issue(work),
    staleTime: 0,
    retry: false,
  });
  const localDocumentAddress = useMemo(
    () =>
      documentDestination
        ? resolveLocalDocumentAddress(projectId, documentDestination, addressCatalog)
        : undefined,
    [addressCatalog, documentDestination, projectId],
  );
  const reconciledDocumentAddress = reconcileDocumentAddress(
    localDocumentAddress,
    documentLookup.data,
  );
  const documentResult = reconciledDocumentAddress.result;
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : (issue(work) ??
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
      : destination.kind === "work"
        ? issue(work)
        : undefined;
  const editorIssue = resourceDestination
    ? "resource-viewing"
    : ((localDocument.kind === "loading" || localDocument.kind === "unavailable"
        ? localDocument.kind
        : undefined) ??
      (editorWork.status === "resolved" && editorWork.value.status === "archived"
        ? "unavailable"
        : issue(editorWork)) ??
      documentIssue ??
      (documentDestination
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
    return { ...address, destination: next, results: false };
  }
  function workSlug(id: string): string {
    // Mutation completion can precede React's next render. Read the canonical
    // projection, not the render snapshot captured before a Work was created.
    const catalog = queryClient.getQueryData<WorksSnapshot>(projectQueryKeys.works(projectId));
    const slug = catalog?.works.find((work) => work.id === id && work.deletedAt === null)?.slug;
    if (!slug) throw new Error("Work address is unavailable");
    return slug;
  }
  const contextDestination = useCallback(
    (target: ContextRouteTarget, preparedTab?: ContextTab) => {
      const current = latest.current;
      const scoped = target.scheme === "scratch" || target.scheme === "uploads";
      const slug = target.workId
        ? current.works?.find((work) => work.id === target.workId)?.slug
        : null;
      if (target.workId && !slug) throw new Error("Work address is unavailable");
      let state: Record<string, unknown> | undefined;
      if (target.path === "") {
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
          workId: target.workId,
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
            ? {
                kind: "document",
                scheme: target.scheme,
                path: target.path.replace(/^\/+/, ""),
                workSlug: scoped ? (slug ?? null) : null,
              }
            : { kind: "editor" },
          work: selection(slug ?? null),
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
                .selectTab(projectId, target.workId ?? "", selected.documentId);
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
      go(toDestination({ kind: "work", workSlug: workSlug(target.workId) }), options),
    workHref: (target) =>
      projectAddressHref(toDestination({ kind: "work", workSlug: workSlug(target.workId) })),
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
            toDestination({
              kind: "browse",
              scheme: target.scheme,
              path: (target.folder ?? "").replace(/^\/+/, ""),
              workSlug:
                target.scheme === "scratch" || target.scheme === "uploads"
                  ? workSlug(target.workId)
                  : null,
            }),
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
  };
  const selectScreen = (next: ScreenKey) => {
    if (next === activeScreen && next !== "chat") return Promise.resolve();
    // Chat reopens the current chat; with none, its index.
    if (next === "chat") return chat.showChatScreen();
    if (next === "context" && contextRemoval.getProjectSnapshot(projectId).live) {
      const workspace = getContextTabs(projectId);
      const tab = selectEditorEntryTab({
        tabs: workspace.tabs,
        selectedDocumentId: workspace.selectedTabIdByWork[workId ?? ""],
        recentRoutes: readRecentRoutes(projectId),
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
        work: selection(rememberedEditor.current ?? shown.current.workSlug),
      },
      { replace: false },
    );
  };
  const browse = (scheme: ProjectContextTreeScheme | null, path = "") =>
    go(
      toDestination({
        kind: "browse",
        scheme,
        path: path.replace(/^\/+/, ""),
        workSlug: scheme === "scratch" || scheme === "uploads" ? shown.current.workSlug : null,
      }),
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
          {documentDestination ? (
            <ProjectAddressDocument
              projectId={projectId}
              href={location.href}
              entryKey={location.state.__TSR_key ?? ""}
              address={address}
              // Cached paths can have been renamed or reused; only a settled lookup may repair the URL.
              result={documentResult}
              localFile={reconciledDocumentAddress.localFile}
              workId={workId}
              workSlug={editorWork.status === "resolved" ? editorWork.value.slug : null}
              navigation={navigation}
              onAdmission={setAdmission}
            />
          ) : null}
          <ProjectView
            project={project}
            projectId={projectId}
            workingSet={data.workingSet}
            workingSetSyncEnabled={user.workingSetSyncEnabled === true}
            activeScreen={activeScreen}
            chatDisplay={chat.display}
            entryHydration={entryHydration}
            addressOwnsDocumentAdmission
            routeWork={routeWork(work)}
            editorRouteWork={routeWork(editorWork)}
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
