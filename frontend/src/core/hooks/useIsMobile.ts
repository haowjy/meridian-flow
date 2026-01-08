import { useState, useEffect } from 'react'

/** Mobile breakpoint - phones only (<768px) */
const MOBILE_BREAKPOINT = 768

/**
 * Hook to detect if viewport is mobile-sized.
 * Uses viewport width as primary detection (not touch capability).
 *
 * @returns true if viewport width < 768px
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    // SSR-safe: default to false, will be corrected on mount
    if (typeof window === 'undefined') return false
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }

    // Check immediately in case SSR default was wrong
    checkMobile()

    // Listen for resize
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  return isMobile
}
