"use client"

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Turn } from '@/features/chats/types'

interface UseTurnListAutoScrollParams {
  containerRef: RefObject<HTMLDivElement | null>
  turns: Turn[]
  scrollToTurnId?: string | null
  isLoading?: boolean
}

/**
 * Encapsulates auto-scroll behavior for the chat turn list.
 *
 * Responsibilities:
 * - Wait for initial turn load to complete (isLoading === false)
 * - Wait for the layout to stabilize (container.scrollHeight unchanged for several frames)
 * - Scroll to the bookmarked turn using conversation structure:
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
}: UseTurnListAutoScrollParams) {
  const hasScrolledRef = useRef(false)

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
        const viewport = container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')

        // Determine whether this turn has a child (continuation) in the
        // current window. If it does, we scroll to the TOP of the turn so
        // the user can read it from the beginning. If it does not, we treat
        // it as a leaf and scroll the entire chat to the bottom so there is
        // no tiny remaining scroll.
        const targetIndex = turns.findIndex((t) => t.id === scrollToTurnId)
        const hasChild =
          targetIndex !== -1 &&
          turns.some((t) => t.prevTurnId === scrollToTurnId)

        if (!hasChild && viewport) {
          // Leaf turn → scroll chat all the way to the bottom of the viewport.
          viewport.scrollTop = viewport.scrollHeight
        } else {
          // Parent turn (has child in window) or no viewport found →
          // scroll this turn into view with its top near the top.
          turnElement.scrollIntoView({
            behavior: 'auto',
            block: 'start',
            inline: 'nearest',
          })
        }

        hasScrolledRef.current = true
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
