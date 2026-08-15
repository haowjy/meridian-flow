/**
 * Authenticated project route. Owns workspace search params and passes the
 * normalized route state into the controlled ProjectView shell.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  loadProjectRouteData,
  type ProjectRouteData,
  seedProjectRouteData,
} from "@/client/query/project-route-data";
import { useWorks } from "@/client/query/useWorks";
import { useThreadStore } from "@/client/stores";
import { setThread } from "@/client/working-set";
import { useProjectThreadGroups } from "@/features/project/data/project-thread-groups";
import { ProjectView } from "@/features/project/ProjectView";
import { ProjectContextRouteProvider } from "@/features/project/routing/ProjectContextRoute";
import {
  applyNormalizationIfCurrent,
  type ContextRouteTarget,
  type NavigationOptions,
  openContextRouteSearch,
  type ProjectRouteCommand,
  type ProjectRouteCommands,
  type ProjectSearch,
  parseExplicitWork,
  parseProjectSearch,
  planWorkNormalization,
  resolveRouteWork,
  stripEmptySearch,
  transitionProjectSearch,
} from "@/features/project/routing/project-route";
import type { ScreenKey } from "@/features/project/shell/screens";
import { Route as AuthenticatedRoute } from "../../_authenticated";

export const Route = createFileRoute("/_authenticated/project/$projectId")({
  loader: async ({ params }) => loadProjectRouteData(params.projectId),
  component: RouteComponent,
  validateSearch: parseProjectSearch,
});

function RouteComponent() {
  const { projectId } = Route.useParams();
  const routeData = Route.useLoaderData();
  const { user } = AuthenticatedRoute.useLoaderData();
  useProjectRouteCacheSeed(projectId, routeData);
  const search = Route.useSearch();
  const { screen, thread, scheme, folder, path, results } = search;
  const navigate = useNavigate();
  const workCatalog = useWorks(projectId);
  const explicitWork = parseExplicitWork(search.work);
  const routeWork = resolveRouteWork(
    explicitWork,
    workCatalog.status === "error"
      ? { status: "error" }
      : workCatalog.works !== null &&
          (workCatalog.status === "ready" || workCatalog.status === "empty")
        ? { status: "success", works: workCatalog.works }
        : { status: "loading" },
  );
  const workNormalization = planWorkNormalization(search, explicitWork, routeWork);
  const { threadById, threadsLoaded } = useProjectThreadGroups(projectId);
  const handoffPendingThreadIds = useThreadStore((state) => state.handoffPendingThreadIds);
  const activeThreadId = thread && threadsLoaded && threadById.has(thread) ? thread : null;

  useEffect(() => {
    if (activeThreadId) setThread(projectId, activeThreadId);
  }, [activeThreadId, projectId]);

  useEffect(() => {
    if (!thread || !threadsLoaded || threadById.has(thread)) return;
    if (handoffPendingThreadIds[thread]) return;

    void navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (prev) => stripEmptySearch({ ...(prev as ProjectSearch), thread: undefined }),
      replace: true,
    });
  }, [handoffPendingThreadIds, navigate, projectId, thread, threadById, threadsLoaded]);

  useEffect(() => {
    if (!workNormalization) return;
    const plan = workNormalization;
    void navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (latest) => applyNormalizationIfCurrent(plan, parseProjectSearch(latest)),
      replace: plan.replace,
    });
  }, [navigate, projectId, workNormalization]);

  const resolvedScreen: ScreenKey = screen ?? (thread ? "chat" : "home");

  function patchSearch(next: Partial<ProjectSearch>, options?: { replace?: boolean }) {
    return navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (prev) => stripEmptySearch({ ...(prev as ProjectSearch), ...next }),
      replace: options?.replace ?? false,
    });
  }

  function runCommand(command: ProjectRouteCommand, options: NavigationOptions) {
    return navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (prev) => transitionProjectSearch(parseProjectSearch(prev), command),
      replace: options.replace,
    });
  }

  const routeCommands: ProjectRouteCommands = {
    openHome: (options) => runCommand({ kind: "home" }, options),
    openChat: (threadId, options) => runCommand({ kind: "chat", threadId }, options),
    openDockThread: (threadId, options) =>
      runCommand({ kind: "dock-thread", threadId: threadId || undefined, resolvedScreen }, options),
    openWork: (target, options) => runCommand(target, options),
    closeWork: (options) => runCommand({ kind: "work-collection" }, options),
    openWorkContext: (target, options) => runCommand(target, options),
  };

  function handleSelectScreen(next: ScreenKey) {
    return runCommand({ kind: "screen", screen: next }, { replace: false });
  }

  function handleSelectThread(threadId: string) {
    return routeCommands.openChat(threadId, { replace: false });
  }

  function handleSelectDockThread(threadId: string) {
    // The dock only changes which conversation it shows, never the screen — so
    // pin the RESOLVED screen. `?screen` is absent on a default Home landing,
    // and a bare `?thread` there would resolve the writer onto Chat.
    return routeCommands.openDockThread(threadId, { replace: false });
  }

  function handleSelectContextScheme(nextScheme: ProjectContextTreeScheme) {
    patchSearch({
      screen: "context",
      scheme: nextScheme,
      folder: undefined,
      path: undefined,
      results: undefined,
    });
  }

  function handleExitContextScheme() {
    patchSearch({
      screen: "context",
      scheme: undefined,
      folder: undefined,
      path: undefined,
      results: undefined,
    });
  }

  function handleSelectContextFolder(nextFolder: string) {
    patchSearch({
      screen: "context",
      folder: nextFolder || undefined,
      path: undefined,
      results: undefined,
    });
  }

  function handleOpenContextTarget(target: ContextRouteTarget, options?: { replace?: boolean }) {
    return navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (previous) => openContextRouteSearch(parseProjectSearch(previous), target),
      replace: options?.replace ?? false,
    });
  }

  return (
    <ProjectContextRouteProvider openContextRoute={handleOpenContextTarget}>
      <ProjectView
        key={projectId}
        projectId={projectId}
        workingSet={routeData.workingSet}
        workingSetSyncEnabled={user.workingSetSyncEnabled === true}
        activeScreen={resolvedScreen}
        activeThreadId={activeThreadId}
        routeWork={routeWork}
        routeCommands={routeCommands}
        activeContextScheme={scheme ?? null}
        activeContextFolder={folder ?? null}
        activeContextPath={path ?? null}
        resultsOpen={results === ""}
        onSelectScreen={handleSelectScreen}
        onSelectThread={handleSelectThread}
        onSelectDockThread={handleSelectDockThread}
        onSelectContextScheme={handleSelectContextScheme}
        onExitContextScheme={handleExitContextScheme}
        onSelectContextFolder={handleSelectContextFolder}
        onOpenContextTarget={handleOpenContextTarget}
        onOpenResults={() => patchSearch({ results: "" })}
        onCloseResults={() => patchSearch({ results: undefined })}
      />
    </ProjectContextRouteProvider>
  );
}

function useProjectRouteCacheSeed(projectId: string, data: ProjectRouteData): void {
  const queryClient = useQueryClient();

  useState(() => {
    seedProjectRouteData(queryClient, projectId, data);
    return null;
  });

  useEffect(() => {
    seedProjectRouteData(queryClient, projectId, data);
  }, [data, projectId, queryClient]);
}
