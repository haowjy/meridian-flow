import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsNearBottom } from '@/core/hooks/useIsNearBottom'

const DEBUG_SCROLL = import.meta.env.VITE_DEBUG_SCROLL === '1'
if (DEBUG_SCROLL) console.log('[scroll] debug enabled (VITE_DEBUG_SCROLL=1)')

interface UseStreamingAutoScrollParams {
  scrollContainer: HTMLElement | null // Direct element reference (use useState + callback ref)
  isStreaming: boolean
  onScrollToBottom?: () => void // Callback when scrolling to bottom (e.g., to update currentTurnId)
}

interface UseStreamingAutoScrollReturn {
  showScrollButton: boolean
  scrollToBottom: () => void
}

/**
 * Hook for managing auto-scroll behavior during streaming.
 *
 * Behavior:
 * - If user is at bottom when streaming starts → auto-scroll enabled (follows content)
 * - If user is NOT at bottom when streaming starts → show floating button
 * - Clicking button → scroll to bottom + enable auto-scroll
 * - Manual scroll up while auto-scrolling → disable auto-scroll, show button
 * - Streaming ends → reset auto-scroll state
 *
 * Uses refs internally to avoid setState-in-effect issues. Re-renders are driven
 * by the parent's isStreaming prop changes and isNearBottom from useIsNearBottom.
 */
export function useStreamingAutoScroll({
  scrollContainer,
  isStreaming,
  onScrollToBottom,
}: UseStreamingAutoScrollParams): UseStreamingAutoScrollReturn {
  // All mutable state stored in refs to avoid setState-in-effect issues
  const userDisabledRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const prevIsStreamingRef = useRef(false)
  const settleRafIdRef = useRef<number | null>(null)
  const settleCleanupRef = useRef<(() => void) | null>(null)
  const userInteractedRef = useRef(false)
  const userInteractedResetTimerRef = useRef<number | null>(null)
  const lastUserInteractionAtRef = useRef<number>(0)
  const pausedRef = useRef(false)
  const [isPaused, setIsPaused] = useState(false)

  const { isNearBottom, scrollToBottom: scrollToBottomBase } = useIsNearBottom({
    scrollContainer,
    threshold: 50,
  })

  const setPaused = useCallback((next: boolean) => {
    if (pausedRef.current === next) return
    pausedRef.current = next
    setIsPaused(next)
  }, [])

  // Initialize per-stream state, and do a short "settle" after streaming ends.
  // Why: TURN_COMPLETE triggers refreshTurn() + clears streaming state. DOM can shift for a few
  // frames (e.g., processing indicator unmount, blocks replacing streamed content). If we stop
  // auto-scroll immediately, the browser can clamp scrollTop (or other code can scroll) and
  // the user ends up seeing the top of the assistant turn.
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current

    if (settleRafIdRef.current != null && isStreaming) {
      cancelAnimationFrame(settleRafIdRef.current)
      settleRafIdRef.current = null
    }
    if (settleCleanupRef.current && isStreaming) {
      settleCleanupRef.current()
      settleCleanupRef.current = null
    }

    if (isStreaming && !wasStreaming) {
      if (DEBUG_SCROLL) {
        console.log('[scroll] useStreamingAutoScroll:stream_start', {
          t: Date.now(),
          scrollTop: scrollContainer?.scrollTop,
          scrollHeight: scrollContainer?.scrollHeight,
          clientHeight: scrollContainer?.clientHeight,
        })
      }
      // Streaming just started - reset state for new stream
      userDisabledRef.current = false
      setPaused(false)
      if (scrollContainer) {
        lastScrollTopRef.current = scrollContainer.scrollTop
        // If the user is not near the bottom at stream start, don't yank them.
        // Treat as paused until they explicitly return to bottom.
        const distanceFromBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
        if (distanceFromBottom > 50) {
          userDisabledRef.current = true
          setPaused(true)
        }
      }
    }

    if (!isStreaming && wasStreaming) {
      if (DEBUG_SCROLL) {
        console.log('[scroll] useStreamingAutoScroll:stream_end', {
          t: Date.now(),
          scrollTop: scrollContainer?.scrollTop,
          scrollHeight: scrollContainer?.scrollHeight,
          clientHeight: scrollContainer?.clientHeight,
          isNearBottom,
          userDisabled: userDisabledRef.current,
        })
      }

      const shouldSettle = Boolean(scrollContainer && isNearBottom && !userDisabledRef.current)
      // Reset for next run. Keep this after computing shouldSettle.
      userDisabledRef.current = false
      setPaused(false)

      if (shouldSettle && scrollContainer) {
        const viewport = scrollContainer
        const start = performance.now()
        const MAX_MS = 800
        const MAX_FRAMES = 48
        let frames = 0
        let lastHeight = viewport.scrollHeight
        let stableHeightFrames = 0
        const STABLE_HEIGHT_FRAMES = 6

        // During settle, only treat "scrolling away from bottom" as user intent if we
        // observed a user interaction (wheel/pointer/touch). This avoids cancelling
        // when the browser temporarily clamps scrollTop during DOM swaps.
        const markUserInteracted = () => {
          userInteractedRef.current = true
          if (userInteractedResetTimerRef.current != null) {
            window.clearTimeout(userInteractedResetTimerRef.current)
          }
          userInteractedResetTimerRef.current = window.setTimeout(() => {
            userInteractedRef.current = false
            userInteractedResetTimerRef.current = null
          }, 1000)
        }

        const handleScroll = () => {
          if (!userInteractedRef.current) return
          if (viewport.scrollTop < lastScrollTopRef.current - 10) {
            userDisabledRef.current = true
          }
        }

        viewport.addEventListener('wheel', markUserInteracted, { passive: true })
        viewport.addEventListener('pointerdown', markUserInteracted, { passive: true })
        viewport.addEventListener('touchstart', markUserInteracted, { passive: true })
        viewport.addEventListener('scroll', handleScroll, { passive: true })

        settleCleanupRef.current = () => {
          viewport.removeEventListener('wheel', markUserInteracted)
          viewport.removeEventListener('pointerdown', markUserInteracted)
          viewport.removeEventListener('touchstart', markUserInteracted)
          viewport.removeEventListener('scroll', handleScroll)
          if (userInteractedResetTimerRef.current != null) {
            window.clearTimeout(userInteractedResetTimerRef.current)
            userInteractedResetTimerRef.current = null
          }
          userInteractedRef.current = false
        }

        const tick = () => {
          const elapsed = performance.now() - start

          if (userDisabledRef.current) {
            if (DEBUG_SCROLL) {
              console.log('[scroll] useStreamingAutoScroll:settle_cancelled', { t: Date.now() })
            }
            settleRafIdRef.current = null
            settleCleanupRef.current?.()
            settleCleanupRef.current = null
            return
          }

          // Always attempt to pin to bottom first; DOM may have just swapped and temporarily
          // clamped scrollTop, and reading distanceFromBottom before pinning is misleading.
          viewport.scrollTop = viewport.scrollHeight
          lastScrollTopRef.current = viewport.scrollTop
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight

          frames += 1

          // Early exit once layout is stable AND we're pinned to bottom. This reduces
          // visible flicker after stream end while still guarding against late DOM swaps.
          if (viewport.scrollHeight !== lastHeight) {
            lastHeight = viewport.scrollHeight
            stableHeightFrames = 0
          } else {
            stableHeightFrames += 1
          }

          const isPinned = distanceFromBottom <= 1
          const isStable = stableHeightFrames >= STABLE_HEIGHT_FRAMES

          if (isPinned && isStable) {
            if (DEBUG_SCROLL) {
              console.log('[scroll] useStreamingAutoScroll:settle_done', {
                t: Date.now(),
                frames,
                elapsedMs: Math.round(elapsed),
                stableHeightFrames,
              })
            }
            settleRafIdRef.current = null
            settleCleanupRef.current?.()
            settleCleanupRef.current = null
            return
          }

          if (elapsed < MAX_MS && frames < MAX_FRAMES) {
            settleRafIdRef.current = requestAnimationFrame(tick)
          } else {
            if (DEBUG_SCROLL) {
              console.log('[scroll] useStreamingAutoScroll:settle_done', {
                t: Date.now(),
                frames,
                elapsedMs: Math.round(elapsed),
              })
            }
            settleRafIdRef.current = null
            settleCleanupRef.current?.()
            settleCleanupRef.current = null
          }
        }

        if (DEBUG_SCROLL) {
          console.log('[scroll] useStreamingAutoScroll:settle_start', { t: Date.now() })
        }
        settleRafIdRef.current = requestAnimationFrame(tick)
      }
    }

    prevIsStreamingRef.current = isStreaming

    return () => {
      if (settleRafIdRef.current != null) {
        cancelAnimationFrame(settleRafIdRef.current)
        settleRafIdRef.current = null
      }
      if (settleCleanupRef.current) {
        settleCleanupRef.current()
        settleCleanupRef.current = null
      }
    }
  }, [isStreaming, scrollContainer, isNearBottom])

  // Detect user intent to pause/resume auto-scroll during streaming.
  useEffect(() => {
    if (!scrollContainer || !isStreaming) return

    const handleScroll = () => {
      const { scrollTop } = scrollContainer
      const delta = scrollTop - lastScrollTopRef.current

      // User scrolled UP - disable auto-scroll (follow mode).
      // Use a small threshold to avoid fighting at the bottom.
      if (delta < -1) {
        if (!userDisabledRef.current) {
          userDisabledRef.current = true
          setPaused(true)
        }
      }

      // Resume follow when the user scrolls DOWN into the near-bottom zone.
      // This is more robust than a debounced "stop scrolling" timer (trackpad momentum/bounce
      // can cause us to miss the exact bottom and never resume).
      if (userDisabledRef.current) {
        const distanceFromBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
        const isNear = distanceFromBottom <= 50

        // Track interaction timestamp for debugging/telemetry (future use).
        lastUserInteractionAtRef.current = Date.now()

        if (delta > 0 && isNear) {
          userDisabledRef.current = false
          setPaused(false)
          onScrollToBottom?.()
        }
      }

      lastScrollTopRef.current = scrollTop
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
    }
  }, [scrollContainer, isStreaming, onScrollToBottom])

  // RAF loop for continuous auto-scroll
  // Runs while streaming and checks userDisabled on each tick
  useEffect(() => {
    if (!isStreaming || !scrollContainer) return

    let rafId: number
    let active = true

    const tick = () => {
      if (!active) return

      // Only auto-scroll if user hasn't disabled it
      if (!userDisabledRef.current) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
        lastScrollTopRef.current = scrollContainer.scrollTop
      }

      rafId = requestAnimationFrame(tick)
    }

    if (DEBUG_SCROLL) {
      console.debug('[scroll] useStreamingAutoScroll:raf_start', { t: Date.now() })
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      active = false
      cancelAnimationFrame(rafId)
      if (DEBUG_SCROLL) {
        console.debug('[scroll] useStreamingAutoScroll:raf_stop', { t: Date.now() })
      }
    }
  }, [isStreaming, scrollContainer])

  // Button click: scroll to bottom and re-enable auto-scroll
  const scrollToBottom = useCallback(() => {
    scrollToBottomBase()
    userDisabledRef.current = false
    setPaused(false)
    onScrollToBottom?.() // Notify parent (e.g., to update currentTurnId)
    // Update lastScrollTop after smooth scroll animation
    setTimeout(() => {
      if (scrollContainer) {
        lastScrollTopRef.current = scrollContainer.scrollTop
      }
    }, 100)
  }, [scrollToBottomBase, scrollContainer, onScrollToBottom])

  // Show button when not at bottom AND there's scrollable content
  // Check if scroll is needed: scrollHeight > clientHeight
  const isScrollable = scrollContainer
    ? scrollContainer.scrollHeight > scrollContainer.clientHeight
    : false
  const showScrollButton = isScrollable && (isPaused || !isNearBottom)

  return { showScrollButton, scrollToBottom }
}
