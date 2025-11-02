import { useEffect, useState } from 'react'

/**
 * Debounce a value by delaying updates until after a specified delay.
 * Resets the timer on each value change (trailing edge debounce).
 *
 * @param value - The value to debounce
 * @param delay - Delay in milliseconds
 * @returns The debounced value
 *
 * @example
 * ```tsx
 * const [searchTerm, setSearchTerm] = useState('')
 * const debouncedSearch = useDebounce(searchTerm, 500)
 *
 * useEffect(() => {
 *   // API call only happens 500ms after user stops typing
 *   fetchResults(debouncedSearch)
 * }, [debouncedSearch])
 * ```
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    // Set up timer to update debounced value after delay
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    // Clean up timer on value change or unmount
    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}
