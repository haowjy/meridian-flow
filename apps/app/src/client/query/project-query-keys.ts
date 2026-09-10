/**
 * project-query-keys — the canonical React Query key factory for project-scoped
 * data (list, detail, threads, works, context tree). Single source of key
 * shapes so reads, writes, and invalidations stay consistent.
 */
import type { CatalogScope, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";

export function isProjectWorkDerivedKey(
  queryKey: readonly unknown[],
  projectId: string,
  workIds?: ReadonlySet<string>,
): boolean {
  if (queryKey[0] !== "projects" || queryKey[1] !== projectId || queryKey[2] !== "works") {
    return false;
  }
  const workId = queryKey[3];
  if (typeof workId !== "string" || (workIds && !workIds.has(workId))) return false;
  return queryKey[4] === "drafts" || (queryKey[4] === "documents" && queryKey.includes("draft"));
}

export function isWorkScopedProjectContextCatalogKey(
  queryKey: readonly unknown[],
  projectId: string,
  workIds?: ReadonlySet<string>,
): boolean {
  if (
    queryKey.length !== 4 ||
    queryKey[0] !== "projects" ||
    queryKey[1] !== projectId ||
    queryKey[2] !== "context-catalog"
  ) {
    return false;
  }
  const scopeKey = queryKey[3];
  if (typeof scopeKey !== "string" || !scopeKey.startsWith("work:")) return false;
  const workId = scopeKey.split(":").at(-1);
  return Boolean(workId && (!workIds || workIds.has(workId)));
}

export function isProjectContextCatalogKey(
  queryKey: readonly unknown[],
  projectId: string,
): boolean {
  return (
    queryKey.length === 4 &&
    queryKey[0] === "projects" &&
    queryKey[1] === projectId &&
    queryKey[2] === "context-catalog"
  );
}

export const projectQueryKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  threads: (projectId: string) => ["projects", projectId, "threads"] as const,
  workThreads: (projectId: string, workId?: string) =>
    workId
      ? (["projects", projectId, "work-threads", workId] as const)
      : (["projects", projectId, "work-threads"] as const),
  works: (projectId: string) => ["projects", projectId, "works"] as const,
  homeFeed: (projectId: string) => ["projects", projectId, "home-feed"] as const,
  threadUserState: (projectId: string, threadId: string) =>
    ["projects", projectId, "thread-user-state", threadId] as const,
  workDrafts: (projectId: string, workId: string) =>
    ["projects", projectId, "works", workId, "drafts"] as const,
  workDraftPreview: (projectId: string, workId: string, documentId: string, draftId?: string) =>
    [
      "projects",
      projectId,
      "works",
      workId,
      "documents",
      documentId,
      "draft",
      draftId ?? null,
    ] as const,
  contextCatalog: (projectId: string, scope: CatalogScope) =>
    ["projects", projectId, "context-catalog", catalogScopeKey(scope)] as const,
  contextCatalogView: (
    projectId: string,
    scheme: ProjectContextTreeScheme,
    workId?: string | null,
  ) => {
    const scope: CatalogScope =
      scheme === "user"
        ? { kind: "user", userId: "self" }
        : scheme === "scratch" || scheme === "uploads"
          ? workId
            ? { kind: "work", projectId, workId }
            : { kind: "none", projectId }
          : { kind: "project", projectId };
    return ["projects", projectId, "context-catalog", catalogScopeKey(scope)] as const;
  },
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
  results: (projectId: string) => ["projects", projectId, "results"] as const,
  resultSignedUrl: (projectId: string, resultId: string) =>
    ["projects", projectId, "results", resultId, "signed-url"] as const,
};
