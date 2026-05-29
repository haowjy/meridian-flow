/**
 * TanStack Query keys — shared with notify-handler invalidation.
 */

export const queryKeys = {
  projects: {
    all: ["projects"] as const,
    detail: (projectId: string) => ["projects", projectId] as const,
    documentTree: (projectId: string) =>
      ["projects", projectId, "tree"] as const,
    threads: (projectId: string) =>
      ["projects", projectId, "threads"] as const,
  },
  documents: {
    detail: (documentId: string) => ["documents", documentId] as const,
  },
  threads: {
    detail: (threadId: string) => ["threads", threadId] as const,
    turns: (
      threadId: string,
      params?: {
        fromTurnId?: string
        direction?: string
        limit?: number
      },
    ) =>
      params
        ? (["threads", threadId, "turns", params] as const)
        : (["threads", threadId, "turns"] as const),
    spawns: (threadId: string) => ["threads", threadId, "spawns"] as const,
  },
  turns: {
    detail: (turnId: string) => ["turns", turnId] as const,
    blocks: (turnId: string) => ["turns", turnId, "blocks"] as const,
  },
} as const

/** Predicate helpers for broad invalidation from WS notify (no project id on resource). */
export function isDocumentTreeQueryKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === "projects" && key[2] === "tree"
}

export function isProjectThreadsListQueryKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === "projects" && key[2] === "threads"
}
