import { useEffect } from 'react'

/**
 * Component that removes the "preload" class from body after hydration.
 * This prevents unwanted animations during initial page load.
 */
export function PreloadRemover() {
  useEffect(() => {
    // Remove preload class after hydration is complete
    document.body.classList.remove('preload')
  }, [])

  return null
}
