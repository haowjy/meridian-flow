/**
 * project-query-keys — the canonical React Query key factory for project-scoped
 * data (list, detail, threads, works, context tree). Single source of key
 * shapes so reads, writes, and invalidations stay consistent.
 */
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
  return queryKey[4] === "branches" || (queryKey[4] === "documents" && queryKey.includes("draft"));
}

export const projectQueryKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  renamePrefix: ["projects", "rename"] as const,
  rename: (projectId: string) => ["projects", "rename", projectId] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  /** A document's imported properties, fetched by id once the tree says it has any. */
  documentProperties: (projectId: string, documentId: string) =>
    ["projects", projectId, "documents", documentId, "properties"] as const,
  trash: (projectId: string) => ["projects", projectId, "trash"] as const,
  trashedDocument: (projectId: string, documentId: string) =>
    [...projectQueryKeys.trash(projectId), documentId] as const,
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
  /** Client-only: this project's Work Undo windows (`work-mutations`). */
  workCommands: (projectId: string) => ["projects", projectId, "work-commands"] as const,
  /** One draft's list of changed documents. */
  drafts: (projectId: string, draft: string) => ["projects", projectId, "drafts", draft] as const,
  draftsOf: (projectId: string) => ["projects", projectId, "drafts"] as const,
  /** The branches with changes to one document; invalidated with the Work draft lists. */
  documentDraftHints: (projectId: string, documentId: string) =>
    ["projects", projectId, "document-draft-hints", documentId] as const,
  documentDraftHintsOf: (projectId: string) =>
    ["projects", projectId, "document-draft-hints"] as const,
  contextSources: (projectId: string) => ["projects", projectId, "context-sources"] as const,
  /** `fileCount` refetches the facts when an upload arrives or goes. */
  chatUploads: (projectId: string, chatId: string, fileCount: number) =>
    ["projects", projectId, "chat-uploads", chatId, fileCount] as const,
  accountContextSources: () => ["account", "context-sources"] as const,
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
};

/** The project a read belongs to: `["projects", id, ...]`, the detail key, or an account's recents. */
export function projectIdOfQueryKey(queryKey: readonly unknown[]): string | null {
  // The project detail key is ["projects", "detail", id]; recents are ["account", acct, "recent-documents", id].
  const id =
    queryKey[0] === "projects"
      ? queryKey[1] === "detail"
        ? queryKey[2]
        : queryKey[1]
      : queryKey[0] === "account" && queryKey[2] === "recent-documents"
        ? queryKey[3]
        : null;
  return typeof id === "string" ? id : null;
}
