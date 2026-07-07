/**
 * Authenticated project route. Owns workspace search params and passes the
 * normalized route state into the controlled ProjectView shell.
 */

import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  loadProjectRouteData,
  type ProjectRouteData,
  seedProjectRouteData,
} from "@/client/query/project-route-data";
import { useThreadStore } from "@/client/stores";
import { useProjectThreadGroups } from "@/features/project/data/dashboard-data";
import { ProjectView } from "@/features/project/ProjectView";
import { SCREENS, type ScreenKey } from "@/features/project/shell/screens";

type ProjectSearch = {
  screen?: ScreenKey;
  thread?: string;
  scheme?: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
  results?: "";
};

function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === "string" && SCREENS.some((screen) => screen.key === value);
}

function stripEmptySearch(search: ProjectSearch): ProjectSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => value !== undefined && (key === "results" || value !== ""),
    ),
  ) as ProjectSearch;
}

export const Route = createFileRoute("/_authenticated/project/$projectId")({
  loader: async ({ params }) => loadProjectRouteData(params.projectId),
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): ProjectSearch => {
    const scheme = isProjectContextTreeScheme(search.scheme) ? search.scheme : undefined;
    const folder =
      scheme && typeof search.folder === "string" && search.folder ? search.folder : undefined;
    const path = scheme && typeof search.path === "string" && search.path ? search.path : undefined;
    return {
      screen: isScreenKey(search.screen) ? search.screen : undefined,
      thread: typeof search.thread === "string" && search.thread ? search.thread : undefined,
      scheme,
      folder,
      path,
      results: search.results === undefined ? undefined : "",
    };
  },
});

function dirname(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length ? `/${segments.join("/")}` : undefined;
}

function RouteComponent() {
  const { projectId } = Route.useParams();
  const routeData = Route.useLoaderData();
  useProjectRouteCacheSeed(projectId, routeData);
  const { screen, thread, scheme, folder, path, results } = Route.useSearch();
  const navigate = useNavigate();
  const { threadById, threadsLoaded } = useProjectThreadGroups(projectId);
  const handoffPendingThreadIds = useThreadStore((state) => state.handoffPendingThreadIds);
  const activeThreadId = thread && threadsLoaded && threadById.has(thread) ? thread : null;

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

  const resolvedScreen: ScreenKey = screen ?? (thread ? "chat" : "home");

  function patchSearch(next: Partial<ProjectSearch>, options?: { replace?: boolean }) {
    void navigate({
      to: "/project/$projectId",
      params: { projectId },
      search: (prev) => stripEmptySearch({ ...(prev as ProjectSearch), ...next }),
      replace: options?.replace ?? false,
    });
  }

  function handleSelectScreen(next: ScreenKey) {
    const reset: Partial<ProjectSearch> = { screen: next, results: undefined };
    if (next !== "context") {
      reset.scheme = undefined;
      reset.folder = undefined;
      reset.path = undefined;
    }
    patchSearch(reset);
  }

  function handleSelectThread(threadId: string) {
    patchSearch({ screen: undefined, thread: threadId, results: undefined });
  }

  function handleSelectDockThread(threadId: string) {
    patchSearch({ thread: threadId || undefined });
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

  function handleSelectContextPath(
    nextPath: string,
    nextScheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) {
    const patch: Partial<ProjectSearch> = {
      screen: "context",
      path: nextPath || undefined,
      results: undefined,
    };
    if (nextScheme) patch.scheme = nextScheme;
    if (nextPath) patch.folder = dirname(nextPath);
    patchSearch(patch, options);
  }

  return (
    <ProjectView
      projectId={projectId}
      activeScreen={resolvedScreen}
      activeThreadId={activeThreadId}
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
      onSelectContextPath={handleSelectContextPath}
      onOpenResults={() => patchSearch({ results: "" })}
      onCloseResults={() => patchSearch({ results: undefined })}
    />
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
