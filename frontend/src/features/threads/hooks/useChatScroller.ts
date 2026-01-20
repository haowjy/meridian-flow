import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const DEBUG_SCROLL = import.meta.env.VITE_DEBUG_SCROLL === '1'

interface UseChatScrollerProps {
  /** Change this to reset initial scroll + content gating (typically activeThreadId). */
  resetKey: string | null
  scrollContainer: HTMLElement | null
  turnIds: string[]
  scrollToTurnId: string | undefined
  isLoading: boolean
  isStreaming: boolean
  onScrollToBottom?: () => void
  /** Distance from bottom (px) to consider "at bottom". Default: 50 */
  nearBottomThreshold?: number
  /** Number of stable frames before revealing content. Default: 10 */
  initialStableFrames?: number
}

interface UseChatScrollerReturn {
  isContentReady: boolean
  showScrollButton: boolean
  scrollToBottom: () => void
  listRef: RefObject<HTMLDivElement | null>
}

/**
 * Simplified scroll controller for chat-style thread view.
 *
 * With a fixed-height composer, we no longer need:
 * - Anchor capture/restore for textarea resize
 * - Typing guards to prevent browser caret adjustments
 * - Complex RAF loops for resize compensation
 *
 * This hook handles:
 * 1. Initial scroll to bookmarked turn (or bottom) with content gating
 * 2. Auto-follow during streaming via ResizeObserver
 * 3. Pause/resume follow based on user scroll intent
 * 4. Scroll-to-bottom button visibility
 */
export function useChatScroller({
  resetKey,
  scrollContainer,
  turnIds,
  scrollToTurnId,
  isLoading,
  isStreaming,
  onScrollToBottom,
  nearBottomThreshold = 50,
  initialStableFrames = 10,
}: UseChatScrollerProps): UseChatScrollerReturn {
  const [isContentReady, setIsContentReady] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Whether we're auto-following streaming output
  const isFollowingOutputRef = useRef(true)
  const prevResetKeyRef = useRef<string | null>(null)
  const initialScrolledRef = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Reset state when thread changes
  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return
    prevResetKeyRef.current = resetKey
    initialScrolledRef.current = false
    isFollowingOutputRef.current = true
    // Hide content during thread switch to prevent flash at wrong scroll position
    // Using queueMicrotask avoids synchronous setState within effect body
    queueMicrotask(() => {
      setIsAtBottom(true)
      setIsContentReady(false)
    })
  }, [resetKey])

  // Calculate distance from bottom
  const distanceFromBottom = useCallback(() => {
    if (!scrollContainer) return Infinity
    return scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
  }, [scrollContainer])

  // Initial scroll to bookmarked turn, then reveal content
  useEffect(() => {
    if (!scrollContainer) return
    if (isLoading) return
    if (initialScrolledRef.current) return
    if (!scrollToTurnId) return
    if (turnIds.length === 0) return

    let cancelled = false
    let frameId: number | null = null

    const MAX_FRAMES = 240
    let lastHeight = 0
    let stableFrames = 0
    let frames = 0

    const tick = () => {
      if (cancelled || initialScrolledRef.current) return
      frames += 1

      const h = scrollContainer.scrollHeight
      if (h !== lastHeight) {
        lastHeight = h
        stableFrames = 0
      } else {
        stableFrames += 1
      }

      const turnElement = scrollContainer.querySelector<HTMLElement>(
        `[data-turn-id="${scrollToTurnId}"]`
      )

      if (turnElement && stableFrames >= initialStableFrames) {
        const isLastTurn = turnIds[turnIds.length - 1] === scrollToTurnId

        if (DEBUG_SCROLL) {
          console.debug('[scroll] useChatScroller:initial', {
            t: Date.now(),
            resetKey,
            scrollToTurnId,
            isLastTurn,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
          })
        }

        if (isLastTurn) {
          // Scroll to bottom for last turn
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight })
          isFollowingOutputRef.current = true
        } else {
          // Scroll to specific turn
          turnElement.scrollIntoView({ behavior: 'auto', block: 'end', inline: 'nearest' })
          isFollowingOutputRef.current = false
        }

        initialScrolledRef.current = true
        queueMicrotask(() => setIsContentReady(true))
        return
      }

      if (frames < MAX_FRAMES) {
        frameId = requestAnimationFrame(tick)
      }
    }

    frameId = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      if (frameId != null) cancelAnimationFrame(frameId)
    }
  }, [resetKey, scrollContainer, isLoading, scrollToTurnId, turnIds, initialStableFrames])

  // Track scroll position to detect when user scrolls away from bottom
  useEffect(() => {
    if (!scrollContainer) return

    const handleScroll = () => {
      const d = distanceFromBottom()
      const atBottom = d <= nearBottomThreshold

      setIsAtBottom(atBottom)

      if (isStreaming) {
        // Resume following when user scrolls back to bottom during streaming
        if (atBottom && !isFollowingOutputRef.current) {
          isFollowingOutputRef.current = true
          onScrollToBottom?.()
        }
        // Pause following when user scrolls up during streaming
        if (!atBottom && isFollowingOutputRef.current) {
          isFollowingOutputRef.current = false
        }
      }
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })
    // Initialize state
    handleScroll()

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
    }
  }, [scrollContainer, isStreaming, distanceFromBottom, nearBottomThreshold, onScrollToBottom])

  // Auto-scroll during streaming when following output
  useEffect(() => {
    if (!isStreaming || !scrollContainer || !listRef.current) return

    const observer = new ResizeObserver(() => {
      if (isFollowingOutputRef.current) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight })
      }
    })

    observer.observe(listRef.current)

    return () => {
      observer.disconnect()
    }
  }, [isStreaming, scrollContainer])

  // Reset follow state when streaming starts
  useEffect(() => {
    if (isStreaming) {
      // If at bottom when streaming starts, follow; otherwise pause
      const atBottom = distanceFromBottom() <= nearBottomThreshold
      isFollowingOutputRef.current = atBottom
    }
  }, [isStreaming, distanceFromBottom, nearBottomThreshold])

  const scrollToBottom = useCallback(() => {
    if (!scrollContainer) return
    // Instant scroll during streaming (content changing too fast for smooth)
    // Smooth scroll when not streaming (better UX for static content)
    const behavior = isStreaming ? 'auto' : 'smooth'
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior })
    isFollowingOutputRef.current = true
    setIsAtBottom(true)
    onScrollToBottom?.()
  }, [scrollContainer, isStreaming, onScrollToBottom])

  // Show button when content is ready and not at bottom
  const isScrollable = scrollContainer
    ? scrollContainer.scrollHeight > scrollContainer.clientHeight
    : false
  const showScrollButton = isContentReady && isScrollable && !isAtBottom

  return { isContentReady, showScrollButton, scrollToBottom, listRef }
}
