import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { makeLogger } from '@/core/lib/logger'

/**
 * Feature-level hook for loading turns for a given thread.
 *
 * For now this wraps useThreadStore.loadTurns(threadId, signal) and exposes
 * a turn-view slice + loading state. Later it will operate directly on
 * the richer Turn model (with blocks/metadata).
 */
export function useTurnsForThread(threadId: string | null) {
  const { turns, isLoadingTurns, error, loadTurns } = useThreadStore(useShallow((s) => ({
    turns: s.turns,
    isLoadingTurns: s.isLoadingTurns,
    error: s.error,
    loadTurns: s.loadTurns,
  })))

  const abortRef = useRef<AbortController | null>(null)
  // Keep a ref to loadTurns to avoid stale closures
  const loadTurnsRef = useRef(loadTurns)

  // Update the ref when loadTurns changes
  useEffect(() => {
    loadTurnsRef.current = loadTurns
  }, [loadTurns])

  useEffect(() => {
    if (!threadId) return

    const log = makeLogger('useTurnsForThread')
    log.debug('effect:start', { threadId })

    // If we already have turns for this thread (or a load is already in-flight),
    // don't re-fetch on remount / tab switches. This prevents "progressive reload"
    // when navigating away and back.
    const state = useThreadStore.getState()
    if (state.threadId === threadId && (state.turns.length > 0 || state.isLoadingTurns)) {
      log.debug('effect:skip', {
        threadId,
        turns: state.turns.length,
        isLoadingTurns: state.isLoadingTurns,
      })
      return
    }

    // Cancel any in-flight request before starting a new one
    if (abortRef.current) {
      abortRef.current.abort()
    }

    const controller = new AbortController()
    abortRef.current = controller

    // Use the ref to call loadTurns, avoiding stale closures
    void loadTurnsRef.current(threadId, controller.signal)

    return () => {
      controller.abort()
      log.debug('effect:cleanup', { threadId })
    }
  }, [threadId])

  useEffect(() => {
    const log = makeLogger('useTurnsForThread')
    log.debug('state:update', { threadId, turns: turns.length, isLoadingTurns, error })
  }, [threadId, turns.length, isLoadingTurns, error])

  // Filter turns client-side to prevent showing stale data during thread transitions
  // (store may briefly contain turns from previous threadId before new data loads)
  const scoped = threadId ? turns.filter((t) => t.threadId === threadId) : []

  return {
    turns: scoped,
    isLoading: isLoadingTurns,
    error,
  }
}
