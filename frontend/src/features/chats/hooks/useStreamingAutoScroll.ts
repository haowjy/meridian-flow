import { useCallback, useEffect, useRef } from 'react'
import { useIsNearBottom } from '@/core/hooks/useIsNearBottom'

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

  const { isNearBottom, scrollToBottom: scrollToBottomBase } = useIsNearBottom({
    scrollContainer,
    threshold: 50,
  })

  // Reset userDisabled when streaming ends (handled in effect setup/cleanup)
  // and initialize lastScrollTop when streaming starts
  useEffect(() => {
    if (isStreaming && !prevIsStreamingRef.current) {
      // Streaming just started - reset state for new stream
      userDisabledRef.current = false
      if (scrollContainer) {
        lastScrollTopRef.current = scrollContainer.scrollTop
      }
    }

    prevIsStreamingRef.current = isStreaming

    // Cleanup when streaming ends
    return () => {
      if (!isStreaming) {
        userDisabledRef.current = false
      }
    }
  }, [isStreaming, scrollContainer])

  // Detect manual scroll up to disable auto-scroll
  useEffect(() => {
    if (!scrollContainer || !isStreaming) return

    const handleScroll = () => {
      const { scrollTop } = scrollContainer

      // User scrolled UP significantly - disable auto-scroll
      if (scrollTop < lastScrollTopRef.current - 10) {
        userDisabledRef.current = true
      }

      lastScrollTopRef.current = scrollTop
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })

    return () => scrollContainer.removeEventListener('scroll', handleScroll)
  }, [scrollContainer, isStreaming])

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

    rafId = requestAnimationFrame(tick)

    return () => {
      active = false
      cancelAnimationFrame(rafId)
    }
  }, [isStreaming, scrollContainer])

  // Button click: scroll to bottom and re-enable auto-scroll
  const scrollToBottom = useCallback(() => {
    scrollToBottomBase()
    userDisabledRef.current = false
    onScrollToBottom?.() // Notify parent (e.g., to update currentTurnId)
    // Update lastScrollTop after smooth scroll animation
    setTimeout(() => {
      if (scrollContainer) {
        lastScrollTopRef.current = scrollContainer.scrollTop
      }
    }, 100)
  }, [scrollToBottomBase, scrollContainer, onScrollToBottom])

  // Show button when not at bottom (anytime, not just during streaming)
  // isNearBottom changes will trigger re-render from useIsNearBottom's useState
  const showScrollButton = !isNearBottom

  return { showScrollButton, scrollToBottom }
}
