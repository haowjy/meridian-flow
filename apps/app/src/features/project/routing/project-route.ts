/** Stable-ID navigation commands and normalized context-removal CAS snapshots, not browser grammar. */
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { ScreenKey } from "../shell/screens";

export type ProjectSearch = {
  screen?: ScreenKey;
  thread?: string;
  scheme?: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
  results?: "";
  work?: string;
};

export function projectSearchEquals(left: ProjectSearch, right: ProjectSearch): boolean {
  return (
    left.screen === right.screen &&
    left.thread === right.thread &&
    left.scheme === right.scheme &&
    left.folder === right.folder &&
    left.path === right.path &&
    left.results === right.results &&
    left.work === right.work
  );
}

export type RouteWorkResolution =
  | { status: "unresolved"; reason: "loading" | "error" | "unavailable"; slug: string }
  | { status: "none" }
  | { status: "present"; workId: ParsedRequestId; work: Work };

export type NavigationOptions = { replace: boolean };

export type WorkDetailTarget = {
  kind: "work-detail";
  workId: ParsedRequestId;
};

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export type ContextRouteRepair = {
  expectedSearch: {
    screen: "context";
    work: string | undefined;
    scheme: ProjectContextTreeScheme;
    path: string;
  };
  expectedSelection:
    | { kind: "removed-binding"; revision: number; documentId: string }
    | { kind: "rejected-candidate"; revision: number }
    | { kind: "materialized-local"; revision: number; documentId: string };
  next: ContextRouteTarget | { kind: "clear" };
};

function isClearContextRouteTarget(
  target: ContextRouteRepair["next"],
): target is { kind: "clear" } {
  return "kind" in target && target.kind === "clear";
}

export function openContextRouteSearch(
  search: ProjectSearch,
  target: ContextRouteTarget,
): ProjectSearch {
  const segments = target.path.split("/").filter(Boolean);
  segments.pop();
  return stripEmptySearch({
    ...search,
    screen: "context",
    work: target.workId ?? "none",
    scheme: target.scheme,
    folder: segments.length ? `/${segments.join("/")}` : undefined,
    path: target.path,
    results: undefined,
  });
}

/** Compare raw route state with a resolved target without losing omitted Work inheritance. */
export function contextRouteMatchesSearch(
  search: ProjectSearch | null | undefined,
  target: ContextRouteTarget,
  inheritedWorkId: string | null,
): boolean {
  if (!search) return false;
  const workId = search.work === "none" ? null : (search.work ?? inheritedWorkId);
  return (
    search.screen === "context" &&
    search.scheme === target.scheme &&
    search.path === target.path &&
    workId === target.workId
  );
}

export type WorkContextTarget = {
  kind: "work-context";
  workId: ParsedRequestId;
  scheme: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
};

export type ProjectRouteCommands = {
  openHome: (options: NavigationOptions) => Promise<void>;
  openChat: (threadId: string, options: NavigationOptions) => Promise<void>;
  openDockThread: (threadId: string, options: NavigationOptions) => Promise<void>;
  openWork: (target: WorkDetailTarget, options: NavigationOptions) => Promise<void>;
  workHref: (target: WorkDetailTarget) => string;
  closeWork: (options: NavigationOptions) => Promise<void>;
  openWorkContext: (target: WorkContextTarget, options: NavigationOptions) => Promise<void>;
};

function stripEmptySearch(search: ProjectSearch): ProjectSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) =>
        value !== undefined &&
        (key === "results" || key === "path" || key === "work" || value !== ""),
    ),
  ) as ProjectSearch;
}

/** Latest-search compare-and-swap for a removal planned against a bound route. */
export function applyContextRepairIfCurrent(
  repair: ContextRouteRepair,
  latest: ProjectSearch,
): ProjectSearch {
  const expected = repair.expectedSearch;
  if (
    latest.screen !== expected.screen ||
    latest.work !== expected.work ||
    latest.scheme !== expected.scheme ||
    latest.path !== expected.path
  ) {
    return latest;
  }
  if (isClearContextRouteTarget(repair.next)) {
    return stripEmptySearch({
      ...latest,
      scheme: undefined,
      folder: undefined,
      path: undefined,
      results: undefined,
    });
  }
  return openContextRouteSearch(latest, repair.next);
}
