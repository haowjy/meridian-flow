import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Turn } from '@/features/threads/types'

const DEBUG_SCROLL = import.meta.env.VITE_DEBUG_SCROLL === '1'

interface UseTurnListAutoScrollParams {
  containerRef: RefObject<HTMLDivElement | null>
  turns: Turn[]
  scrollToTurnId?: string | null
  isLoading?: boolean
  /** Called after initial scroll completes - use to reveal content that was rendering invisibly */
  onScrollComplete?: () => void
}

/**
 * Encapsulates auto-scroll behavior for the thread turn list.
 *
 * Responsibilities:
 * - Wait for initial turn load to complete (isLoading === false)
 * - Wait for the layout to stabilize (container.scrollHeight unchanged for several frames)
 * - Scroll to the bookmarked turn using thread structure:
 *   - If the turn has a child (continuation) in the current window → scroll so the turn
 *     starts near the top of the viewport (block='start').
 *   - If the turn is a leaf → treat as end-of-thread and scroll the viewport to the bottom
 *     (no tiny remaining scroll).
 *
 * This hook is view-only: it works entirely from the DOM and turn list props.
 */
export function useTurnListAutoScroll({
  containerRef,
  turns,
  scrollToTurnId,
  isLoading,
  onScrollComplete,
}: UseTurnListAutoScrollParams) {
  const hasScrolledRef = useRef(false)
  // Keep a stable reference to the callback to avoid re-triggering the effect
  const onScrollCompleteRef = useRef(onScrollComplete)

  // Update the ref when callback changes (must be in effect, not during render)
  useEffect(() => {
    onScrollCompleteRef.current = onScrollComplete
  }, [onScrollComplete])

  useEffect(() => {
    if (!scrollToTurnId || hasScrolledRef.current || turns.length === 0 || isLoading) {
      return
    }

    let cancelled = false
    let frameId: number | null = null

    // Require container.scrollHeight to be unchanged for this many frames
    // before treating the layout as "settled". This guards against large
    // turns (multi-block content) that render over several frames.
    const STABLE_FRAMES = 10
    const MAX_FRAMES = 240 // ~4 seconds at 60fps

    let lastHeight = 0
    let stableFrames = 0
    let frameCount = 0

    const tick = () => {
      if (cancelled || hasScrolledRef.current) return
      frameCount += 1

      const container = containerRef.current
      if (!container) {
        frameId = requestAnimationFrame(tick)
        return
      }

      const height = container.scrollHeight
      if (height !== lastHeight) {
        lastHeight = height
        stableFrames = 0
      } else {
        stableFrames += 1
      }

      const turnElement = container.querySelector<HTMLElement>(
        `[data-turn-id="${scrollToTurnId}"]`
      )

      if (turnElement && stableFrames >= STABLE_FRAMES) {
        // This view uses a plain overflow container (not Radix ScrollArea).
        // Prefer the explicit scroll container marker to avoid brittle DOM assumptions.
        const viewport =
          container.closest<HTMLElement>('[data-thread-scroll-container]') ??
          container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')

        // Check if this is the last turn in the current window.
        // If it is, scroll to absolute bottom. Otherwise, scroll so the
        // BOTTOM of the turn is visible (user sees where they left off).
        const isLastTurn = turns[turns.length - 1]?.id === scrollToTurnId

        if (DEBUG_SCROLL) {
          console.debug('[scroll] useTurnListAutoScroll:execute', {
            t: Date.now(),
            scrollToTurnId,
            isLastTurn,
            hasViewport: Boolean(viewport),
            containerScrollHeight: container.scrollHeight,
            containerClientHeight: container.clientHeight,
          })
        }

        if (isLastTurn && viewport) {
          // Last turn → scroll to absolute bottom to eliminate any remaining scroll
          const isScrollable = viewport.scrollHeight > viewport.clientHeight
          if (isScrollable) {
            viewport.scrollTop = viewport.scrollHeight
          }
          // If not scrollable: scrollTop stays at 0, justify-end aligns content to bottom
        } else {
          // Non-last turn → scroll so bottom of turn is at viewport bottom.
          // User sees where they left off and can scroll up to re-read.
          turnElement.scrollIntoView({
            behavior: 'auto',
            block: 'end',
            inline: 'nearest',
          })
        }

        hasScrolledRef.current = true
        // Notify that scroll is complete - content can now be revealed
        onScrollCompleteRef.current?.()
        return
      }

      if (frameCount < MAX_FRAMES) {
        frameId = requestAnimationFrame(tick)
      }
    }

    frameId = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      if (frameId != null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [containerRef, scrollToTurnId, turns, isLoading])

  // Reset scroll flag when target turn changes so the new bookmark is used.
  useEffect(() => {
    hasScrolledRef.current = false
  }, [scrollToTurnId])
}
