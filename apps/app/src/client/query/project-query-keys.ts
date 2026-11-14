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
  /** Client-only: this project's Work command records (`work-command-store`). */
  workCommands: (projectId: string) => ["projects", projectId, "work-commands"] as const,
  /** One owner's draft list; `owner` is `work:<id>` or `lineage:<root>`. */
  ownerDrafts: (projectId: string, owner: string) =>
    ["projects", projectId, "drafts", owner] as const,
  ownerDraftsOf: (projectId: string) => ["projects", projectId, "drafts"] as const,
  /** The branches with changes to one document; invalidated with the Work draft lists. */
  documentDraftHints: (projectId: string, documentId: string) =>
    ["projects", projectId, "document-draft-hints", documentId] as const,
  documentDraftHintsOf: (projectId: string) =>
    ["projects", projectId, "document-draft-hints"] as const,
  ownerDraftMetadata: (projectId: string, owner: string, documentId: string, itemKey?: string) =>
    ["projects", projectId, "draft-metadata", owner, documentId, itemKey ?? null] as const,
  /** Every item's draft metadata read of one document of an owner. */
  ownerDraftMetadataOf: (projectId: string, owner: string, documentId: string) =>
    ["projects", projectId, "draft-metadata", owner, documentId] as const,
  contextSources: (projectId: string) => ["projects", projectId, "context-sources"] as const,
  /** `fileCount` refetches the facts when an upload arrives or goes. */
  chatUploads: (projectId: string, chatId: string, fileCount: number) =>
    ["projects", projectId, "chat-uploads", chatId, fileCount] as const,
  accountContextSources: () => ["account", "context-sources"] as const,
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
};
