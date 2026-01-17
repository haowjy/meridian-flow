import { useEffect } from 'react'

/**
 * Component that removes the "preload" class from body after hydration.
 * This prevents unwanted animations during initial page load.
 */
export function PreloadRemover() {
  useEffect(() => {
    // Delay removal to let panels expand without animation during initial load
    // 300ms gives enough buffer for typical API responses (100-200ms)
    const timer = setTimeout(() => {
      document.body.classList.remove('preload')
    }, 300)

    return () => clearTimeout(timer)
  }, [])

  return null
}
