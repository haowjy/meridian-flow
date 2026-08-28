/**
 * Pure grammar, Work resolution, and search transitions for the project route.
 * The route component is the sole adapter from these values to TanStack Router.
 */

import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
  type Work,
} from "@meridian/contracts/protocol";
import { type ParsedRequestId, parseRequestId } from "@meridian/contracts/request-id";
import { SCREENS, type ScreenKey } from "../shell/screens";

export type ProjectSearch = {
  screen?: ScreenKey;
  thread?: string;
  scheme?: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
  results?: "";
  work?: string;
};

export type ExplicitWorkSearch =
  | { kind: "absent" }
  | { kind: "malformed"; value: string }
  | { kind: "valid"; id: ParsedRequestId; canonical: boolean };

export type WorkCatalog =
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; works: readonly Work[] };

export type RouteWorkResolution =
  | { status: "absent" }
  | { status: "malformed"; value: string }
  | { status: "loading"; workId: ParsedRequestId }
  | { status: "catalog-error"; workId: ParsedRequestId }
  | { status: "present"; workId: ParsedRequestId; work: Work }
  | { status: "not-found"; workId: ParsedRequestId };

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
    work: target.workId ?? undefined,
    scheme: target.scheme,
    folder: segments.length ? `/${segments.join("/")}` : undefined,
    path: target.path,
    results: undefined,
  });
}

export type WorkContextTarget = {
  kind: "work-context";
  workId: ParsedRequestId;
  scheme: ProjectContextTreeScheme;
  folder?: string;
  path?: string;
};

export type ProjectRouteCommand =
  | { kind: "home" }
  | { kind: "chat"; threadId: string }
  | { kind: "dock-thread"; threadId?: string; resolvedScreen: ScreenKey }
  | { kind: "screen"; screen: ScreenKey }
  | WorkDetailTarget
  | WorkContextTarget
  | { kind: "work-collection" };

export type ProjectRouteCommands = {
  openHome: (options: NavigationOptions) => Promise<void>;
  openChat: (threadId: string, options: NavigationOptions) => Promise<void>;
  openDockThread: (threadId: string, options: NavigationOptions) => Promise<void>;
  openWork: (target: WorkDetailTarget, options: NavigationOptions) => Promise<void>;
  workHref: (target: WorkDetailTarget) => string;
  closeWork: (options: NavigationOptions) => Promise<void>;
  openWorkContext: (target: WorkContextTarget, options: NavigationOptions) => Promise<void>;
};

export function projectSearchHref(search: ProjectSearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(stripEmptySearch(search))) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "?";
}

function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === "string" && SCREENS.some((screen) => screen.key === value);
}

export function parseProjectSearch(search: Record<string, unknown>): ProjectSearch {
  const scheme = isProjectContextTreeScheme(search.scheme) ? search.scheme : undefined;
  const folder =
    scheme && typeof search.folder === "string" && search.folder ? search.folder : undefined;
  const path = scheme && typeof search.path === "string" ? search.path : undefined;
  return stripEmptySearch({
    screen: isScreenKey(search.screen) ? search.screen : undefined,
    thread: typeof search.thread === "string" && search.thread ? search.thread : undefined,
    scheme,
    folder,
    path,
    results: search.results === undefined ? undefined : "",
    // Preserve an explicit malformed value so the route owner can normalize it.
    work: typeof search.work === "string" ? search.work : undefined,
  });
}

export function parseExplicitWork(value: string | undefined): ExplicitWorkSearch {
  if (value === undefined) return { kind: "absent" };
  const id = parseRequestId(value);
  if (!id) return { kind: "malformed", value };
  return { kind: "valid", id, canonical: value === id };
}

export function resolveRouteWork(
  explicit: ExplicitWorkSearch,
  catalog: WorkCatalog,
): RouteWorkResolution {
  if (explicit.kind === "absent") return { status: "absent" };
  if (explicit.kind === "malformed") return { status: "malformed", value: explicit.value };
  if (catalog.status === "loading") return { status: "loading", workId: explicit.id };
  if (catalog.status === "error") return { status: "catalog-error", workId: explicit.id };
  const work = catalog.works.find((candidate) => candidate.id === explicit.id);
  return work
    ? { status: "present", workId: explicit.id, work }
    : { status: "not-found", workId: explicit.id };
}

export function stripEmptySearch(search: ProjectSearch): ProjectSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) =>
        value !== undefined &&
        (key === "results" || key === "path" || key === "work" || value !== ""),
    ),
  ) as ProjectSearch;
}

function clearContext(): Pick<ProjectSearch, "scheme" | "folder" | "path" | "results"> {
  return { scheme: undefined, folder: undefined, path: undefined, results: undefined };
}

function dirname(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length ? `/${segments.join("/")}` : undefined;
}

export function transitionProjectSearch(
  current: ProjectSearch,
  command: ProjectRouteCommand,
): ProjectSearch {
  switch (command.kind) {
    case "home":
      return stripEmptySearch({ ...current, screen: "home", work: undefined, ...clearContext() });
    case "chat":
      return stripEmptySearch({
        ...current,
        screen: undefined,
        thread: command.threadId,
        work: undefined,
        ...clearContext(),
      });
    case "dock-thread":
      return stripEmptySearch({
        ...current,
        screen: command.resolvedScreen,
        thread: command.threadId,
      });
    case "work-collection":
      return stripEmptySearch({
        ...current,
        screen: "work",
        work: undefined,
        ...clearContext(),
      });
    case "work-detail":
      return stripEmptySearch({
        ...current,
        screen: "work",
        work: command.workId,
        ...clearContext(),
      });
    case "work-context":
      return stripEmptySearch({
        ...current,
        screen: "context",
        work: command.workId,
        scheme: command.scheme,
        folder: command.folder ?? (command.path ? dirname(command.path) : undefined),
        path: command.path,
        results: undefined,
      });
    case "screen": {
      // An explicit empty path pins a fresh untitled tab while another screen
      // covers Editor. Named Home and Chat commands remain the full-clear seam.
      const context =
        command.screen !== "context" && current.path !== ""
          ? clearContext()
          : { results: undefined };
      return stripEmptySearch({
        ...current,
        screen: command.screen,
        work: command.screen === "home" || command.screen === "chat" ? undefined : current.work,
        ...context,
      });
    }
  }
}

export type WorkNormalizationPlan = {
  kind: "canonicalize" | "collection";
  expected: Pick<ProjectSearch, "screen" | "work">;
  next: ProjectSearch;
  replace: true;
};

export function planWorkNormalization(
  search: ProjectSearch,
  explicit: ExplicitWorkSearch,
  resolution: RouteWorkResolution,
): WorkNormalizationPlan | null {
  const expected = { screen: search.screen, work: search.work };
  if (explicit.kind === "valid" && !explicit.canonical) {
    return {
      kind: "canonicalize",
      expected,
      next: stripEmptySearch({ ...search, work: explicit.id }),
      replace: true,
    };
  }
  if (resolution.status === "malformed" || resolution.status === "not-found") {
    return {
      kind: "collection",
      expected,
      next: transitionProjectSearch(search, { kind: "work-collection" }),
      replace: true,
    };
  }
  return null;
}

export function applyNormalizationIfCurrent(
  plan: WorkNormalizationPlan,
  latest: ProjectSearch,
): ProjectSearch {
  if (latest.screen !== plan.expected.screen || latest.work !== plan.expected.work) return latest;
  return plan.kind === "canonicalize"
    ? stripEmptySearch({ ...latest, work: plan.next.work })
    : transitionProjectSearch(latest, { kind: "work-collection" });
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
