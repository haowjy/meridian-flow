import { useEffect, useRef, useCallback } from 'react'
import { useLatestRef } from './useLatestRef'
import { useOnlineStatus } from './useOnlineStatus'
import { isAbortError } from '@/core/lib/errors'

/**
 * Options for the useResourcePolling hook.
 *
 * @template T - The type of resource being polled
 */
export interface UseResourcePollingOptions<T> {
  /** Enable/disable polling. When false, no requests are made. */
  enabled: boolean
  /** Polling interval in milliseconds. Default: 5000 */
  intervalMs?: number
  /** Maximum interval after exponential backoff. Default: 60000 (1 minute) */
  maxIntervalMs?: number
  /** Fetch function. Receives AbortSignal for cancellation. */
  fetch: (signal: AbortSignal) => Promise<T>
  /** Predicate to determine if resource changed. Return true to trigger onUpdate. */
  shouldUpdate: (resource: T) => boolean
  /** Called when shouldUpdate returns true. */
  onUpdate: (resource: T) => void
  /** Called on fetch errors (excluding abort errors). */
  onError?: (error: Error) => void
}

/**
 * Generic resource polling hook - handles polling lifecycle with robustness features.
 *
 * Designed for extension:
 * - Document polling (ai_version changes)
 * - Turn status polling (tool execution progress)
 * - Any versioned resource
 *
 * Key features:
 * - Fresh AbortController per tick (not reused)
 * - Cleanup aborts in-flight request AND clears interval
 * - Check enabled before each tick (handles race conditions)
 * - Silent abort errors; other errors call onError
 * - Initial tick on mount/enable (don't wait for first interval)
 *
 * Robustness features:
 * - Page Visibility: Skips tick when tab hidden, immediate poll on visible
 * - Online Status: Skips tick when offline, immediate poll on reconnect
 * - Exponential Backoff: On error: 5s → 10s → 20s → 40s → 60s (max). Reset on success.
 *
 * @example
 * ```tsx
 * useResourcePolling({
 *   enabled: !!documentId && !hasUserEdit,
 *   intervalMs: 5000,
 *   fetch: (signal) => api.documents.getAIStatus(docId, { signal }),
 *   shouldUpdate: (status) => status.aiVersionRev !== currentRev,
 *   onUpdate: (status) => fetchFullDocumentAndHydrate(),
 *   onError: (error) => console.warn('Poll error:', error),
 * })
 * ```
 */
export function useResourcePolling<T>(options: UseResourcePollingOptions<T>): void {
  const {
    enabled,
    intervalMs = 5000,
    maxIntervalMs = 60000,
    fetch,
    shouldUpdate,
    onUpdate,
    onError,
  } = options

  // Track online status for reconnection handling
  const isOnline = useOnlineStatus()

  // Keep refs for values that change frequently but shouldn't restart interval
  // This prevents stale closures in the tick function
  const fetchRef = useLatestRef(fetch)
  const shouldUpdateRef = useLatestRef(shouldUpdate)
  const onUpdateRef = useLatestRef(onUpdate)
  const onErrorRef = useLatestRef(onError)
  const enabledRef = useLatestRef(enabled)
  const intervalMsRef = useLatestRef(intervalMs)

  // Track current abort controller for cleanup
  const abortControllerRef = useRef<AbortController | null>(null)

  // Exponential backoff state
  const errorCountRef = useRef(0)
  const currentIntervalRef = useRef(intervalMs)

  // isActive flag to prevent operations after cleanup
  const isActiveRef = useRef(false)

  // Tick function wrapped in useCallback so it can be called from multiple effects
  // Note: Refs are stable identities - including them in deps is safe and makes ESLint happy
  const tick = useCallback(async () => {
    // Check enabled and active before proceeding
    if (!isActiveRef.current || !enabledRef.current) {
      return
    }

    // Skip if tab is hidden (save battery, reduce server load)
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }

    // Skip if offline (request would fail anyway)
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return
    }

    // Create fresh abort controller per tick
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const resource = await fetchRef.current(controller.signal)

      // Success: reset backoff
      errorCountRef.current = 0
      currentIntervalRef.current = intervalMsRef.current

      // Check if we should update (version changed, etc.)
      if (isActiveRef.current && shouldUpdateRef.current(resource)) {
        onUpdateRef.current(resource)
      }
    } catch (error) {
      // Silent handling of abort errors (expected during cleanup)
      if (isAbortError(error)) {
        return
      }

      // Exponential backoff on error: 5s → 10s → 20s → 40s → 60s (max)
      errorCountRef.current++
      currentIntervalRef.current = Math.min(
        intervalMsRef.current * Math.pow(2, errorCountRef.current),
        maxIntervalMs
      )

      // Call error handler for real errors
      if (isActiveRef.current && onErrorRef.current) {
        onErrorRef.current(error as Error)
      }
    }
  }, [maxIntervalMs, enabledRef, fetchRef, intervalMsRef, onErrorRef, onUpdateRef, shouldUpdateRef])

  // Main polling effect
  useEffect(() => {
    // Don't start polling if disabled
    if (!enabled) {
      return
    }

    isActiveRef.current = true
    let intervalId: ReturnType<typeof setInterval> | null = null

    // Reset backoff state when starting fresh
    errorCountRef.current = 0
    currentIntervalRef.current = intervalMs

    // Initial tick immediately (don't wait for first interval)
    void tick()

    // Set up interval for subsequent ticks
    // Note: Uses currentIntervalRef which may change due to backoff
    const scheduleNextTick = () => {
      intervalId = setInterval(() => {
        void tick()
        // Reschedule if interval changed due to backoff
        if (intervalId && currentIntervalRef.current !== intervalMs) {
          clearInterval(intervalId)
          intervalId = setInterval(() => void tick(), currentIntervalRef.current)
        }
      }, currentIntervalRef.current)
    }
    scheduleNextTick()

    // Cleanup: abort any in-flight request and clear interval
    return () => {
      isActiveRef.current = false

      if (intervalId) {
        clearInterval(intervalId)
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
    // Note: We intentionally don't include fetch, shouldUpdate, onUpdate, onError in deps
    // because they're accessed via refs. This prevents interval restart on callback changes.
    // The refs are stable and always point to latest values.
  }, [enabled, intervalMs, tick])

  // Poll immediately when tab becomes visible
  useEffect(() => {
    if (typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && enabledRef.current && isActiveRef.current) {
        void tick()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [tick, enabledRef])

  // Poll immediately when coming back online
  useEffect(() => {
    // Only trigger on transition to online (not on initial mount)
    // The main effect handles initial poll
    if (isOnline && enabledRef.current && isActiveRef.current) {
      void tick()
    }
  }, [isOnline, tick, enabledRef])
}
