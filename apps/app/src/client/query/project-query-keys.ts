export const projectQueryKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  documentProperties: (projectId: string, documentId: string) =>
    ["projects", projectId, "documents", documentId, "properties"] as const,
  trash: (projectId: string) => ["projects", projectId, "trash"] as const,
  trashedDocument: (projectId: string, documentId: string) =>
    [...projectQueryKeys.trash(projectId), documentId] as const,
  threads: (projectId: string) => ["projects", projectId, "threads"] as const,
  works: (projectId: string) => ["projects", projectId, "works"] as const,
  chatFeed: (projectId: string) => ["projects", projectId, "chat-feed"] as const,
  chatFeedFilter: (
    projectId: string,
    filter: { favorite?: boolean; search?: string | null; workId?: string | null },
  ) => [...projectQueryKeys.chatFeed(projectId), filter] as const,
  workCommands: (projectId: string) => ["projects", projectId, "work-commands"] as const,
  drafts: (projectId: string, draft: string) => ["projects", projectId, "drafts", draft] as const,
  draftsOf: (projectId: string) => ["projects", projectId, "drafts"] as const,
  workDrafts: (projectId: string, workId: string) =>
    [...projectQueryKeys.workDraftsOf(projectId), workId] as const,
  workDraftsOf: (projectId: string) => ["projects", projectId, "work-drafts"] as const,
  documentDraftHints: (projectId: string, documentId: string) =>
    ["projects", projectId, "document-draft-hints", documentId] as const,
  documentDraftHintsOf: (projectId: string) =>
    ["projects", projectId, "document-draft-hints"] as const,
  contextSources: (projectId: string) => ["projects", projectId, "context-sources"] as const,
  chatUploads: (projectId: string, chatId: string, fileCount: number) =>
    ["projects", projectId, "chat-uploads", chatId, fileCount] as const,
  accountContextSources: () => ["account", "context-sources"] as const,
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
};

export function projectIdOfQueryKey(queryKey: readonly unknown[]): string | null {
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
