import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAbortableEffect } from '@/core/hooks'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { Thread } from '@/features/threads/types'

type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface UseThreadsForProjectResult {
  threads: Thread[]
  status: LoadStatus
  isLoading: boolean
  error: string | null
}

/**
 * Feature-level hook for loading threads for a given project.
 *
 * Responsibilities:
 * - Orchestrate calling useThreadStore.loadThreads(projectId, signal)
 * - Manage AbortController lifecycle when projectId changes or component unmounts
 * - Signal left panel readiness to useUIStore when data is loaded
 *
 * It does NOT:
 * - Decide which thread is active (owned by useUIStore)
 * - Create / rename / delete threads (call store methods directly where needed)
 */
export function useThreadsForProject(projectId: string): UseThreadsForProjectResult {
  const { threads, statusThreads, isLoadingThreads, error, loadThreads } = useThreadStore(useShallow((s) => ({
    threads: s.threads,
    statusThreads: s.statusThreads,
    isLoadingThreads: s.isLoadingThreads,
    error: s.error,
    loadThreads: s.loadThreads,
  })))

  useAbortableEffect(
    (signal) => {
      if (!projectId) return
      void loadThreads(projectId, signal)
    },
    [projectId, loadThreads]
  )

  // Signal left panel readiness when thread data is loaded or errors
  // This allows the layout to auto-expand the panel when data is ready
  useEffect(() => {
    const isReady = statusThreads === 'success' || statusThreads === 'error'
    useUIStore.getState().setLeftPanelReady(isReady)
  }, [statusThreads])

  return {
    threads,
    status: statusThreads,
    isLoading: isLoadingThreads,
    error,
  }
}

