import * as React from "react"

import type { ThreadTurn } from "@/features/threads"
import { useThreadTurns } from "@/lib/queries"

import { isLiveProjectId } from "./data-mappers"
import { MOCK_THREAD_TURNS } from "./mock-data"

/**
 * Thread turns for layout shells: live paginated turns when projectId is real,
 * mock walkthrough otherwise (and on fetch error so dev without backend still works).
 */
export function useShellThreadTurns(
  projectId: string | undefined,
  threadId: string | undefined,
) {
  const live = isLiveProjectId(projectId)
  const isRealThread = Boolean(threadId) && threadId !== "new"
  const turnsQuery = useThreadTurns(threadId, {
    enabled: live && isRealThread,
  })

  const turns: ThreadTurn[] = React.useMemo(() => {
    if (!live) return MOCK_THREAD_TURNS
    if (turnsQuery.isError) return MOCK_THREAD_TURNS
    if (turnsQuery.isSuccess) return turnsQuery.data.turns
    return []
  }, [live, turnsQuery.isError, turnsQuery.isSuccess, turnsQuery.data?.turns])

  return {
    turns,
    isLoading: live && turnsQuery.isLoading,
    isLive: live,
    refetch: turnsQuery.refetch,
  }
}
