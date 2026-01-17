import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
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

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!projectId) return

    // Cancel any in-flight request before starting a new one to prevent race condition:
    // If projectId changes rapidly, previous request should not overwrite newer data
    if (abortRef.current) {
      abortRef.current.abort()
    }

    const abortController = new AbortController()
    abortRef.current = abortController

    void loadThreads(projectId, abortController.signal)

    return () => {
      abortController.abort()
    }
    // loadThreads is stable from Zustand; we intentionally avoid adding it
    // as a dependency to prevent effect churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

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

