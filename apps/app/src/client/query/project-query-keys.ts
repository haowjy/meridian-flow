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

/** Any draft's attribution payload in the project: its chat titles go stale when a chat is renamed. */
export const isProjectDraftAttributionKey = (projectId: string, key: readonly unknown[]) =>
  key[0] === "projects" && key[1] === projectId && key[6] === "draft-attribution";

export const projectQueryKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  renamePrefix: ["projects", "rename"] as const,
  rename: (projectId: string) => ["projects", "rename", projectId] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  documentAddresses: (projectId: string) => ["projects", projectId, "document-addresses"] as const,
  threads: (projectId: string) => ["projects", projectId, "threads"] as const,
  works: (projectId: string) => ["projects", projectId, "works"] as const,
  chatFeed: (projectId: string) => ["projects", projectId, "chat-feed"] as const,
  /** One filtered chat feed; a partial filter (`{ favorite: true }`) matches every variant. */
  chatFeedFilter: (
    projectId: string,
    filter: { favorite?: boolean; search?: string | null; workId?: string | null },
  ) => [...projectQueryKeys.chatFeed(projectId), filter] as const,
  threadUserState: (projectId: string, threadId: string) =>
    ["projects", projectId, "thread-user-state", threadId] as const,
  threadRename: (projectId: string, threadId: string) =>
    ["projects", projectId, "thread-rename", threadId] as const,
  threadRenamePrefix: (projectId: string) => ["projects", projectId, "thread-rename"] as const,
  /** Client-only: this project's Work command records (`work-command-store`). */
  workCommands: (projectId: string) => ["projects", projectId, "work-commands"] as const,
  workDrafts: (projectId: string, workId: string) =>
    ["projects", projectId, "works", workId, "drafts"] as const,
  /** The drafts with changes to one document; invalidated with the Work draft lists. */
  documentDraftHints: (projectId: string, documentId: string) =>
    ["projects", projectId, "document-draft-hints", documentId] as const,
  documentDraftHintsOf: (projectId: string) =>
    ["projects", projectId, "document-draft-hints"] as const,
  /** An item's attribution payload, which the review runtime classifies against the room. */
  workDraftAttribution: (projectId: string, workId: string, documentId: string, itemKey: string) =>
    [
      "projects",
      projectId,
      "works",
      workId,
      "documents",
      documentId,
      "draft-attribution",
      itemKey,
    ] as const,
  /** Where to open one item (`DraftItemMeta`): its room, whether it has changes. */
  workDraftMeta: (projectId: string, workId: string, documentId: string, itemKey?: string) =>
    [
      "projects",
      projectId,
      "works",
      workId,
      "documents",
      documentId,
      "draft",
      itemKey ?? null,
    ] as const,
  contextCatalog: (projectId: string, scope: CatalogScope) =>
    ["projects", projectId, "context-catalog", catalogScopeKey(scope)] as const,
  contextCatalogView: (
    projectId: string,
    scheme: ProjectContextTreeScheme,
    owner: { workId?: string | null; rootThreadId?: string | null } = {},
  ) => {
    const scope: CatalogScope =
      scheme === "user"
        ? { kind: "user", userId: "self" }
        : scheme === "scratch" && owner.rootThreadId
          ? { kind: "lineage", projectId, rootThreadId: owner.rootThreadId }
          : scheme === "scratch" || scheme === "uploads"
            ? { kind: "work", projectId, workId: owner.workId ?? "" }
            : { kind: "project", projectId };
    return ["projects", projectId, "context-catalog", catalogScopeKey(scope)] as const;
  },
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
};
