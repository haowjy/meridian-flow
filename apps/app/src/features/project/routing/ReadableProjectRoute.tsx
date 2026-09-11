/** Browser address resolution and navigation over one authorized, ID-backed project shell. */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { WorksSnapshot } from "@meridian/contracts/works";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getProjectDocumentAddress, listProjectThreads } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { getContextTabs, useContextTabs, useContextTabsStore } from "@/client/stores";
import { hydrateWorkingSet, setThread } from "@/client/working-set";
import { originalBrowserSearch } from "@/router-search";
import { useResolvedChatThread } from "../chat/chat-thread-resolution";
import { ProjectDocumentNavigationProvider } from "../context/open-project-document";
import { ProjectView } from "../ProjectView";
import type { ScreenKey } from "../shell/screens";
import { type AddressAdmission, ProjectAddressDocument } from "./ProjectAddressDocument";
import { ProjectNavigationProvider } from "./ProjectNavigationContext";
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
  addressChatSelection,
  addressWorkSelection,
  resolveAddressSelection,
} from "./project-address-resolution";
import { resolveLocalDocumentSelection } from "./project-local-selection";
import { createProjectNavigation, type DisplayedProjectSelection } from "./project-navigation";
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
function issue<T>(resolution: AddressResolution<T>): ProjectRouteIssue | undefined {
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
  if (destination.kind === "home") return "home";
  if (destination.kind === "work" || destination.kind === "works") return "work";
  if (destination.kind === "chat" || destination.kind === "chats") return "chat";
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
          projectSlug: project.slug,
          destination: { kind: "home" },
          chat: NONE,
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
  const requestedChat = addressChatSelection(address);
  const chat = resolveAddressSelection(
    requestedChat,
    threads.isError
      ? { status: "error" }
      : threads.threads !== null
        ? { status: "ready", entries: threads.threads }
        : { status: "loading" },
  );
  const { resolvedThreadId } = useResolvedChatThread(
    projectId,
    chat.status === "resolved" ? chat.value.id : null,
    requestedChat.kind === "absent",
  );
  const displayedChat = threads.threads?.find((thread) => thread.id === resolvedThreadId) ?? null;
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
    (workCatalog.status !== "ready" ||
      (requestedChat.kind === "absent" && (threads.isError || threads.threads === null)));
  const editorWork: AddressResolution<Work> = editorDefaultPending
    ? { status: works.status === "error" || threads.isError ? "error" : "loading", slug: "" }
    : resolveAddressSelection(editorSelection, workCatalog);
  const workId = editorWork.status === "resolved" ? editorWork.value.id : null;
  const { tabs: deskTabs } = useContextTabs(projectId);
  const deskHydrated = useContextTabsStore((state) => state._deskHydrated);
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
    hydrated: deskHydrated,
    tabs: deskTabs,
  });
  const localDocumentId = localDocument.kind === "resolved" ? localDocument.documentId : undefined;
  const localPointer = localDocumentId
    ? { accountId: user.userId, projectId, documentId: localDocumentId }
    : undefined;
  useLayoutEffect(() => {
    if (localDocumentId && workId)
      void useContextTabsStore.getState().selectTab(projectId, workId, localDocumentId);
  }, [projectId, workId, localDocumentId]);
  const shown = useRef<DisplayedProjectSelection>({ chatSlug: null, workSlug: null });
  const [navigation, setNavigation] = useState<ReturnType<typeof createProjectNavigation> | null>(
    null,
  );
  useLayoutEffect(() => {
    const coordinator = createProjectNavigation(
      {
        read: () => ({
          href: router.history.location.href,
          key: router.history.location.state.__TSR_key ?? "",
          state: { ...router.history.location.state },
        }),
        subscribe: (listener) => router.history.subscribe(listener),
        replaceEntry: (href, state) => router.history.replace(href, state, { ignoreBlocker: true }),
        navigate: (href, options) =>
          router.navigate({ href, replace: options.replace, state: options.state }),
      },
      () => shown.current,
    );
    setNavigation(coordinator);
    return () => coordinator.dispose();
  }, [router]);
  const latest = useRef({ address, location, navigation, works: works.works });
  latest.current = { address, location, navigation, works: works.works };
  const captureNavigation = useCallback(() => {
    const current = latest.current.navigation;
    const location = latest.current.location;
    const ticket = current?.captureForEntry({
      href: location.href,
      key: location.state.__TSR_key ?? "",
    });
    return () => !!ticket && !!current?.isCurrent(ticket);
  }, []);
  const reportSelection = useCallback(
    (value: { threadId: string | null; editorWorkId: string | null }) => {
      const chatSlug =
        threads.threads?.find((thread) => thread.id === value.threadId)?.slug ?? null;
      const workSlug = works.works?.find((work) => work.id === value.editorWorkId)?.slug ?? null;
      shown.current = { chatSlug, workSlug, local: localPointer };
      if (activeScreen === "context" && !issue(editorWork)) rememberedEditor.current = workSlug;
    },
    [
      threads.threads,
      works.works,
      activeScreen,
      editorWork.status,
      localDocumentId,
      user.userId,
      projectId,
    ],
  );

  const documentDestination = destination.kind === "document" ? destination : null;
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
  const documentIssue: ProjectRouteIssue | undefined = !documentDestination
    ? undefined
    : (issue(work) ??
      (documentLookup.isError
        ? "error"
        : !documentLookup.data
          ? "loading"
          : documentLookup.data.kind === "unavailable"
            ? "unavailable"
            : undefined));
  const mainIssue =
    parsed.kind === "invalid"
      ? "unavailable"
      : destination.kind === "work"
        ? issue(work)
        : undefined;
  const editorIssue =
    (localDocument.kind === "loading" || localDocument.kind === "unavailable"
      ? localDocument.kind
      : undefined) ??
    (editorWork.status === "resolved" && editorWork.value.status === "archived"
      ? "unavailable"
      : issue(editorWork)) ??
    documentIssue ??
    (documentDestination
      ? admission?.href === location.href &&
        admission.key === (location.state.__TSR_key ?? "") &&
        documentLookup.data?.kind !== "unavailable" &&
        admission.documentId === documentLookup.data?.document.documentId
        ? admission.issue
        : "loading"
      : undefined);

  useEffect(() => {
    if (resolvedThreadId) setThread(projectId, resolvedThreadId);
  }, [projectId, resolvedThreadId]);
  useEffect(() => {
    if (!navigation || parsed.kind !== "valid") return;
    const ticket = navigation.captureForEntry({
      href: location.href,
      key: location.state.__TSR_key ?? "",
    });
    if (!ticket) return;
    let next = address;
    if (requestedChat.kind === "absent" && !threads.isError && threads.threads !== null)
      next = { ...next, chat: selection(displayedChat?.slug ?? null) };
    if (activeScreen === "context" && address.work.kind === "absent" && !issue(editorWork))
      next = { ...next, work: editorSelection };
    void navigation.replaceIfCurrent(ticket, next);
  }, [
    navigation,
    location.href,
    location.state.__TSR_key,
    parsed.kind,
    threads.threads,
    threads.isError,
    displayedChat?.slug,
    editorWork.status,
    editorSelection.kind,
    activeScreen,
  ]);

  async function go(next: ProjectAddress, options: NavigationOptions) {
    if (!navigation?.captureForEntry({ href: location.href, key: location.state.__TSR_key ?? "" }))
      return;
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
  async function openChat(threadId: string, options: NavigationOptions, dock = false) {
    if (!threadId && dock) return go({ ...address, chat: NONE }, { replace: true });
    const ticket = navigation?.captureForEntry({
      href: location.href,
      key: location.state.__TSR_key ?? "",
    });
    let thread = threads.threads?.find((thread) => thread.id === threadId);
    if (!thread?.slug) {
      const catalog = await listProjectThreads(projectId);
      queryClient.setQueryData(projectQueryKeys.threads(projectId), catalog);
      if (!ticket || !navigation?.isCurrent(ticket)) return;
      thread = catalog.find((candidate) => candidate.id === threadId);
    }
    if (!thread?.slug) throw new Error("Chat address is unavailable");
    return go(
      dock
        ? { ...address, chat: selection(thread.slug) }
        : toDestination({ kind: "chat", chatSlug: thread.slug }),
      { replace: dock || options.replace },
    );
  }
  const openContext = useCallback(
    async (target: ContextRouteTarget, options?: { replace?: boolean }) => {
      const current = latest.current;
      if (
        !current.navigation?.captureForEntry({
          href: current.location.href,
          key: current.location.state.__TSR_key ?? "",
        })
      )
        return;
      const scoped = target.scheme === "scratch" || target.scheme === "uploads";
      const slug = target.workId
        ? current.works?.find((work) => work.id === target.workId)?.slug
        : null;
      if (target.workId && !slug) throw new Error("Work address is unavailable");
      let state: Record<string, unknown> | undefined;
      if (target.path === "") {
        const desk = getContextTabs(projectId);
        const documentId = target.workId ? desk.selectedTabIdByWork[target.workId] : undefined;
        const pointer = { version: 1, accountId: user.userId, projectId, documentId };
        const resolved = resolveLocalDocumentSelection({
          pointer,
          accountId: user.userId,
          projectId,
          workId: target.workId,
          hydrated: true,
          tabs: desk.tabs,
        });
        if (resolved.kind !== "resolved") throw new Error("Local document is unavailable");
        state = { meridianProjectSelection: pointer };
      }
      return current.navigation.navigate(
        {
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
        },
        { replace: options?.replace ?? false, state },
      );
    },
    [projectId, user.userId],
  );
  const routeCommands: ProjectRouteCommands = {
    openHome: (options) => go(toDestination({ kind: "home" }), options),
    openChat: (id, options) => openChat(id, options),
    openDockThread: (id, options) => openChat(id, options, true),
    openWork: (target, options) =>
      go(toDestination({ kind: "work", workSlug: workSlug(target.workId) }), options),
    workHref: (target) =>
      projectAddressHref(toDestination({ kind: "work", workSlug: workSlug(target.workId) })),
    closeWork: (options) => go(toDestination({ kind: "works" }), options),
    openWorkContext: (target, options) =>
      target.path !== undefined
        ? openContext({ scheme: target.scheme, path: target.path, workId: target.workId }, options)
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
    thread: resolvedThreadId ?? undefined,
    work: workId ?? "none",
    scheme: localDocumentId
      ? "scratch"
      : destination.kind === "document" || destination.kind === "browse"
        ? (destination.scheme ?? undefined)
        : undefined,
    path: localDocumentId ? "" : documentDestination ? `/${documentDestination.path}` : undefined,
    folder: destination.kind === "browse" ? `/${destination.path}` : undefined,
    results: address.results ? "" : undefined,
  };
  const selectScreen = (next: ScreenKey) =>
    next === activeScreen && !(next === "chat" && destination.kind === "chat")
      ? Promise.resolve()
      : go(
          {
            ...toDestination({
              kind:
                next === "home"
                  ? "home"
                  : next === "work"
                    ? "works"
                    : next === "context"
                      ? "editor"
                      : "chats",
            }),
            work: selection(rememberedEditor.current ?? shown.current.workSlug),
          },
          { replace: false },
        );
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
      openNewChat={() => go(toDestination({ kind: "chats" }), { replace: false })}
      captureNavigation={captureNavigation}
    >
      <ProjectDocumentNavigationProvider
        projectId={projectId}
        navigationRevision={location.state.__TSR_key}
        captureNavigation={captureNavigation}
      >
        {documentDestination ? (
          <ProjectAddressDocument
            projectId={projectId}
            href={location.href}
            entryKey={location.state.__TSR_key ?? ""}
            address={address}
            result={documentLookup.data}
            workId={workId}
            workSlug={editorWork.status === "resolved" ? editorWork.value.slug : null}
            navigation={navigation}
            onAdmission={setAdmission}
          />
        ) : null}
        <ProjectView
          projectId={projectId}
          workingSet={data.workingSet}
          workingSetSyncEnabled={user.workingSetSyncEnabled === true}
          activeScreen={activeScreen}
          activeThreadId={resolvedThreadId}
          chatDestination={destination.kind === "chats" ? destination.kind : undefined}
          entryHydration={entryHydration}
          addressOwnsDocumentAdmission
          routeWork={routeWork(work)}
          editorRouteWork={routeWork(editorWork)}
          routeIssues={{ main: mainIssue, chat: issue(chat), editor: editorIssue }}
          onDisplayedSelection={reportSelection}
          routeCommands={routeCommands}
          contextRemovalRoute={{
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
          onSelectThread={(id) => openChat(id, { replace: false })}
          onSelectDockThread={(id) => openChat(id, { replace: true }, true)}
          onSelectContextScheme={(scheme) => browse(scheme)}
          onExitContextScheme={() => browse(null)}
          onSelectContextFolder={(path) => browse(search.scheme ?? null, path)}
          onOpenContextTarget={openContext}
          onOpenResults={() => go({ ...address, results: true }, { replace: true })}
          onCloseResults={() => go({ ...address, results: false }, { replace: true })}
        />
      </ProjectDocumentNavigationProvider>
    </ProjectNavigationProvider>
  );
}
