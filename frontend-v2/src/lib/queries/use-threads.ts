import { useQuery } from "@tanstack/react-query"

import { mapTurnsToViewModels } from "@/features/threads/turn-mapper"
import { api } from "@/lib/api"

import { queryKeys } from "./keys"

export function useThreads(
  projectId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: projectId
      ? queryKeys.projects.threads(projectId)
      : ["projects", "__none__", "threads"],
    queryFn: ({ signal }) => {
      if (!projectId) throw new Error("projectId is required")
      return api.threads.list(projectId, { signal })
    },
    enabled: (options?.enabled ?? true) && !!projectId,
  })
}

export function useThread(
  threadId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: threadId
      ? queryKeys.threads.detail(threadId)
      : ["threads", "__none__"],
    queryFn: ({ signal }) => {
      if (!threadId) throw new Error("threadId is required")
      return api.threads.get(threadId, { signal })
    },
    enabled: (options?.enabled ?? true) && !!threadId,
  })
}

export function useThreadTurns(
  threadId: string | undefined,
  options?: {
    enabled?: boolean
    fromTurnId?: string
    direction?: "before" | "after" | "both" | ""
    limit?: number
    updateLastViewed?: boolean
  },
) {
  const hasPagination =
    options?.fromTurnId !== undefined ||
    options?.direction !== undefined ||
    options?.limit !== undefined
  const pagination = hasPagination
    ? {
        fromTurnId: options?.fromTurnId,
        direction: options?.direction,
        limit: options?.limit,
      }
    : undefined

  return useQuery({
    queryKey: threadId
      ? queryKeys.threads.turns(threadId, pagination)
      : ["threads", "__none__", "turns"],
    queryFn: async ({ signal }) => {
      if (!threadId) throw new Error("threadId is required")
      const page = await api.turns.paginate(threadId, {
        fromTurnId: options?.fromTurnId,
        direction: options?.direction,
        limit: options?.limit,
        updateLastViewed: options?.updateLastViewed,
        signal,
      })
      return {
        turns: mapTurnsToViewModels(page.turns),
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
      }
    },
    enabled: (options?.enabled ?? true) && !!threadId,
  })
}
