/** Stable-ID navigation commands and normalized context-removal CAS snapshots, not browser grammar. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

/**
 * Main's document as the removal coordinator compares it: its locator, absent when main holds no
 * document. A snapshot for compare-and-swap repairs, not an address grammar (`project-address`).
 */
export type ProjectSearch = {
  scheme?: ProjectContextTreeScheme;
  path?: string;
  /** A Work's Scratch note: its owning Work. Absent for every other document. */
  work?: string;
  /** A chat's Scratch note: its lineage, by the first chat's id. */
  chat?: string;
};

export function projectSearchEquals(left: ProjectSearch, right: ProjectSearch): boolean {
  return (
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.work === right.work &&
    left.chat === right.chat
  );
}

export type NavigationOptions = {
  afterCommit?: () => void;
  replace: boolean;
};

/**
 * A document's route. The owner is a fact about a Scratch note only: `workId` names a Work's
 * Scratch owner, `rootThreadId` a No Work chat's. Every other document has neither, so the
 * Work scope never takes part in its identity.
 */
export type ContextRouteTarget = { documentId?: string; path: string } & (
  | { scheme: "scratch"; workId: string; rootThreadId?: undefined }
  | { scheme: "scratch"; rootThreadId: string; workId?: undefined }
  | {
      scheme: Exclude<ProjectContextTreeScheme, "scratch">;
      workId?: undefined;
      rootThreadId?: undefined;
    }
);

/**
 * What a route or a caller names: a Scratch note may leave its owner out (a link without one,
 * or a caller leaving it to the scope's Work).
 */
export type ContextRouteRequest =
  | ContextRouteTarget
  | {
      documentId?: string;
      path: string;
      scheme: "scratch";
      workId?: undefined;
      rootThreadId?: undefined;
    };

/** Loose route fields (a URL, a tab, a chat link) to a request: the owner survives for Scratch only. */
export function contextRouteRequest(parts: {
  scheme: ProjectContextTreeScheme;
  path: string;
  documentId?: string | undefined;
  workId?: string | null | undefined;
  rootThreadId?: string | null | undefined;
}): ContextRouteRequest {
  const { scheme, path, documentId } = parts;
  const base = documentId ? { path, documentId } : { path };
  if (scheme !== "scratch") return { ...base, scheme };
  if (parts.rootThreadId) return { ...base, scheme, rootThreadId: parts.rootThreadId };
  if (parts.workId) return { ...base, scheme, workId: parts.workId };
  return { ...base, scheme };
}

/** Whether two targets name one locator: scheme and path, within the same owner. */
export function sameContextTarget(a: ContextRouteRequest, b: ContextRouteRequest): boolean {
  return (
    a.scheme === b.scheme &&
    a.path === b.path &&
    a.workId === b.workId &&
    a.rootThreadId === b.rootThreadId
  );
}

export type ContextRouteRepair = {
  expectedSearch: {
    work: string | undefined;
    chat?: string | undefined;
    scheme: ProjectContextTreeScheme;
    path: string;
  };
  expectedSelection: { kind: "materialized-local"; revision: number; documentId: string };
  next: ContextRouteRequest | { kind: "clear" };
};

function isClearContextRouteTarget(
  target: ContextRouteRepair["next"],
): target is { kind: "clear" } {
  return "kind" in target && target.kind === "clear";
}

export function openContextRouteSearch(
  search: ProjectSearch,
  target: ContextRouteRequest,
): ProjectSearch {
  return stripEmptySearch({
    ...search,
    work: target.workId,
    chat: target.rootThreadId,
    scheme: target.scheme,
    path: target.path,
  });
}

/** Compare raw route state with a resolved target. */
export function contextRouteMatchesSearch(
  search: ProjectSearch | null | undefined,
  target: ContextRouteRequest,
): boolean {
  if (!search) return false;
  return (
    search.scheme === target.scheme &&
    search.path === target.path &&
    search.chat === target.rootThreadId &&
    search.work === target.workId
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
