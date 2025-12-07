import { useCallback, useEffect, useState, useRef } from 'react'

interface UseIsNearBottomParams {
  scrollContainer: HTMLElement | null // Direct element reference (use useState + callback ref)
  threshold?: number // pixels from bottom to consider "near bottom" (default 50)
}

interface UseIsNearBottomReturn {
  isNearBottom: boolean
  scrollToBottom: () => void
}

/**
 * Reusable hook for tracking scroll position relative to bottom.
 *
 * Use cases:
 * - Chat auto-scroll during streaming
 * - "New messages" indicator
 * - Infinite scroll pagination
 */
export function useIsNearBottom({
  scrollContainer,
  threshold = 50,
}: UseIsNearBottomParams): UseIsNearBottomReturn {
  const [isNearBottom, setIsNearBottom] = useState(true)
  const lastScrollTopRef = useRef(0)

  useEffect(() => {
    if (!scrollContainer) return

    const checkPosition = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const nearBottom = distanceFromBottom <= threshold

      // Only update state if it actually changed (prevents unnecessary re-renders)
      setIsNearBottom((prev) => (prev !== nearBottom ? nearBottom : prev))
      lastScrollTopRef.current = scrollTop
    }

    // Check initial position
    checkPosition()

    // Passive listener for performance
    scrollContainer.addEventListener('scroll', checkPosition, { passive: true })

    return () => scrollContainer.removeEventListener('scroll', checkPosition)
  }, [scrollContainer, threshold]) // scrollContainer change triggers re-run (callback ref pattern)

  const scrollToBottom = useCallback(() => {
    if (!scrollContainer) return

    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth',
    })
  }, [scrollContainer])

  return { isNearBottom, scrollToBottom }
}
