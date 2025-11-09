import { useLayoutEffect, useState, type RefObject } from 'react'

interface ThumbRect {
  x: number
  w: number
}

/**
 * Hook to track and follow a target element with a moving thumb/highlight.
 *
 * Measures the position and width of a target element relative to a container,
 * updating on resize, zoom, or target size changes.
 *
 * @param containerRef - The reference container element (for relative positioning)
 * @param targetRef - The target element to track
 * @returns Position and width for the thumb, or null if refs aren't ready
 */
export function useThumbFollow<C extends HTMLElement = HTMLElement, T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<C | null>,
  targetRef: RefObject<T | null>
): ThumbRect | null {
  const [rect, setRect] = useState<ThumbRect | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const target = targetRef.current

    if (!container || !target) {
      setRect(null)
      return
    }

    const updateRect = () => {
      const containerBounds = container.getBoundingClientRect()
      const targetBounds = target.getBoundingClientRect()

      const newRect = {
        x: targetBounds.left - containerBounds.left,
        w: targetBounds.width,
      }

      // Only update state if values actually changed (prevents unnecessary re-renders)
      setRect(prev => {
        if (prev && prev.x === newRect.x && prev.w === newRect.w) {
          return prev
        }
        return newRect
      })
    }

    // Initial measurement
    updateRect()

    // Observe size changes on both elements
    const resizeObserver = new ResizeObserver(updateRect)
    resizeObserver.observe(container)
    resizeObserver.observe(target)

    // Listen to window resize (handles zoom, viewport changes)
    window.addEventListener('resize', updateRect)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateRect)
    }
  }, [containerRef, targetRef])

  return rect
}
