/** Stable-ID navigation commands and normalized context-removal CAS snapshots, not browser grammar. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { AddressableWork } from "@/client/query/useWorks";
import type { ScreenKey } from "../shell/screens";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import type { WorksView, WorkView } from "./project-address";

export type ProjectSearch = {
  screen?: ScreenKey;
  scheme?: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
  results?: "";
  work?: string;
  /** The chat index's Favorites filter; owned by `features/project/chat-index`. */
  filter?: "favorites";
  /** The chat index's settled search text; owned by `features/project/chat-index`. */
  q?: string;
  /** Work detail view (chats default) or Work list tab (active default). */
  view?: "files" | "archived" | "deleted";
};

export function projectSearchEquals(left: ProjectSearch, right: ProjectSearch): boolean {
  return (
    left.screen === right.screen &&
    left.scheme === right.scheme &&
    left.folder === right.folder &&
    left.path === right.path &&
    left.results === right.results &&
    left.work === right.work &&
    left.filter === right.filter &&
    left.q === right.q &&
    left.view === right.view
  );
}

/**
 * The Work a route addresses. `unresolved` has no id when the address named
 * no Work it could parse.
 */
export type RouteWorkResolution =
  | { status: "new" }
  | {
      status: "unresolved";
      reason: "loading" | "error" | "unavailable";
      workId: ParsedRequestId | null;
    }
  | {
      status: "creating";
      workId: ParsedRequestId;
      name: string;
      goal: string | null;
      phase: "pending" | "failed";
    }
  | { status: "absent" }
  | { status: "present"; workId: ParsedRequestId; work: AddressableWork };

/** The id of the Work a route addresses, whether it is present, being created, or unresolved. */
export function routeWorkId(routeWork: RouteWorkResolution): ParsedRequestId | null {
  return "workId" in routeWork ? routeWork.workId : null;
}

/**
 * What keeps a route's Work from showing its content yet. A Work being created
 * is still loading; one whose create failed never arrives, so it is an error.
 */
export function routeWorkIssue(
  routeWork: RouteWorkResolution,
): Exclude<ProjectRouteIssue, "resource-viewing"> | undefined {
  if (routeWork.status === "unresolved") return routeWork.reason;
  if (routeWork.status === "creating") return routeWork.phase === "failed" ? "error" : "loading";
}

export type NavigationOptions = { replace: boolean };

export type WorkDetailTarget = {
  kind: "work-detail";
  workId: ParsedRequestId;
};

export type ContextRouteTarget = {
  documentId?: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string;
};

/** Open requests inherit the current Editor Work once at the route boundary. */
export type ContextRouteRequest = Omit<ContextRouteTarget, "workId"> & { workId?: string };

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
    work: target.workId,
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
  const workId = search.work ?? inheritedWorkId;
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
  openWork: (target: WorkDetailTarget, options: NavigationOptions) => Promise<void>;
  workHref: (target: WorkDetailTarget) => string;
  workView: WorkView;
  setWorkView: (view: WorkView) => Promise<void>;
  worksView: WorksView;
  setWorksView: (view: WorksView) => Promise<void>;
  closeWork: (options: NavigationOptions) => Promise<void>;
  openWorkContext: (target: WorkContextTarget, options: NavigationOptions) => Promise<void>;
  /** Editor destination with no document and no local history pointer. */
  showEditorRecents: (options: NavigationOptions) => Promise<void>;
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
