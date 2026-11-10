/** Stable-ID navigation commands and normalized context-removal CAS snapshots, not browser grammar. */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ScreenKey } from "../shell/screens";

export type ProjectSearch = {
  screen?: ScreenKey;
  scheme?: ProjectContextTreeScheme;
  path?: string;
  /** The Work that owns the route's locator: a Scratch address's owner, else the scope's. */
  work?: string;
  /** A chat's Scratch note: its lineage, by the first chat's id. */
  chat?: string;
  /** The chat index's Favorites filter; owned by `features/project/chat-index`. */
  filter?: "favorites";
  /** The chat index's settled search text; owned by `features/project/chat-index`. */
  q?: string;
};

export function projectSearchEquals(left: ProjectSearch, right: ProjectSearch): boolean {
  return (
    left.screen === right.screen &&
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.work === right.work &&
    left.chat === right.chat &&
    left.filter === right.filter &&
    left.q === right.q
  );
}

export type NavigationOptions = {
  afterCommit?: () => void;
  replace: boolean;
};

/**
 * A document's route. For Scratch `workId` is the owning Work; a
 * No Work chat's Scratch names its lineage in `rootThreadId` instead, and
 * `workId` is then only the Editor's own Work, as for a project document.
 */
export type ContextRouteTarget = {
  documentId?: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string;
  rootThreadId?: string;
};

/** Whether the Editor of `activeWorkId` shows this target: a Work's Scratch only in its own Editor. */
export function targetInEditorOf(target: ContextRouteTarget, activeWorkId: string): boolean {
  return (
    !isWorkScopedScheme(target.scheme) ||
    target.rootThreadId !== undefined ||
    target.workId === activeWorkId
  );
}

/** Whether two targets name one locator: scheme and path, within the same owner. */
export function sameContextTarget(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return (
    a.scheme === b.scheme &&
    a.path === b.path &&
    a.workId === b.workId &&
    a.rootThreadId === b.rootThreadId
  );
}

/** Open requests inherit the current Editor Work once at the route boundary. */
export type ContextRouteRequest = Omit<ContextRouteTarget, "workId"> & { workId?: string };

export type ContextRouteRepair = {
  expectedSearch: {
    screen: "context";
    work: string | undefined;
    chat?: string | undefined;
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
  return stripEmptySearch({
    ...search,
    screen: "context",
    work: target.workId,
    chat: target.rootThreadId,
    scheme: target.scheme,
    path: target.path,
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
    search.chat === target.rootThreadId &&
    workId === target.workId
  );
}

export type ProjectRouteCommands = {
  /** Editor destination with no document and no local history pointer. */
  showEditorRecents: (options: NavigationOptions) => Promise<void>;
};

function stripEmptySearch(search: ProjectSearch): ProjectSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => value !== undefined && (key === "path" || key === "work" || value !== ""),
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
    latest.chat !== expected.chat ||
    latest.scheme !== expected.scheme ||
    latest.path !== expected.path
  ) {
    return latest;
  }
  if (isClearContextRouteTarget(repair.next)) {
    return stripEmptySearch({
      ...latest,
      chat: undefined,
      scheme: undefined,
      path: undefined,
    });
  }
  return openContextRouteSearch(latest, repair.next);
}
