// @ts-nocheck
/**
 * Authenticated workbench route. Owns workspace search params and passes the
 * normalized route state into the controlled WorkbenchView shell.
 */

import type { WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  loadWorkbenchRouteData,
  seedWorkbenchRouteData,
  type WorkbenchRouteData,
} from "@/client/query/workbench-route-data";
import { useThreadStore } from "@/client/stores";
import { useWorkbenchThreadGroups } from "@/features/workbench/data/dashboard-data";
import { SCREENS, type ScreenKey } from "@/features/workbench/shell/screens";
import { WorkbenchView } from "@/features/workbench/WorkbenchView";

type WorkbenchSearch = {
  screen?: ScreenKey;
  thread?: string;
  scheme?: WorkbenchContextTreeScheme;
  folder?: string;
  path?: string;
  results?: "";
};

function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === "string" && SCREENS.some((screen) => screen.key === value);
}

function isContextScheme(value: unknown): value is WorkbenchContextTreeScheme {
  return value === "kb" || value === "user" || value === "work" || value === "fs1";
}

function stripEmptySearch(search: WorkbenchSearch): WorkbenchSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => value !== undefined && (key === "results" || value !== ""),
    ),
  ) as WorkbenchSearch;
}

export const Route = createFileRoute("/_authenticated/workbench/$workbenchId")({
  loader: async ({ params }) => loadWorkbenchRouteData(params.workbenchId),
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): WorkbenchSearch => {
    const scheme = isContextScheme(search.scheme) ? search.scheme : undefined;
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
  const { workbenchId } = Route.useParams();
  const routeData = Route.useLoaderData();
  useWorkbenchRouteCacheSeed(workbenchId, routeData);
  const { screen, thread, scheme, folder, path, results } = Route.useSearch();
  const navigate = useNavigate();
  const { threadById, threadsLoaded } = useWorkbenchThreadGroups(workbenchId);
  const handoffPendingThreadIds = useThreadStore((state) => state.handoffPendingThreadIds);
  const activeThreadId = thread && threadsLoaded && threadById.has(thread) ? thread : null;

  useEffect(() => {
    if (!thread || !threadsLoaded || threadById.has(thread)) return;
    if (handoffPendingThreadIds[thread]) return;

    void navigate({
      to: "/workbench/$workbenchId",
      params: { workbenchId },
      search: (prev) => stripEmptySearch({ ...(prev as WorkbenchSearch), thread: undefined }),
      replace: true,
    });
  }, [handoffPendingThreadIds, navigate, workbenchId, thread, threadById, threadsLoaded]);

  const resolvedScreen: ScreenKey = screen ?? (thread ? "chat" : "home");

  function patchSearch(next: Partial<WorkbenchSearch>, options?: { replace?: boolean }) {
    void navigate({
      to: "/workbench/$workbenchId",
      params: { workbenchId },
      search: (prev) => stripEmptySearch({ ...(prev as WorkbenchSearch), ...next }),
      replace: options?.replace ?? false,
    });
  }

  function handleSelectScreen(next: ScreenKey) {
    const reset: Partial<WorkbenchSearch> = { screen: next, results: undefined };
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

  function handleSelectContextScheme(nextScheme: WorkbenchContextTreeScheme) {
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
    nextScheme?: WorkbenchContextTreeScheme,
    options?: { replace?: boolean },
  ) {
    const patch: Partial<WorkbenchSearch> = {
      screen: "context",
      path: nextPath || undefined,
      results: undefined,
    };
    if (nextScheme) patch.scheme = nextScheme;
    if (nextPath) patch.folder = dirname(nextPath);
    patchSearch(patch, options);
  }

  return (
    <WorkbenchView
      workbenchId={workbenchId}
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

function useWorkbenchRouteCacheSeed(workbenchId: string, data: WorkbenchRouteData): void {
  const queryClient = useQueryClient();

  useState(() => {
    seedWorkbenchRouteData(queryClient, workbenchId, data);
    return null;
  });

  useEffect(() => {
    seedWorkbenchRouteData(queryClient, workbenchId, data);
  }, [data, workbenchId, queryClient]);
}
