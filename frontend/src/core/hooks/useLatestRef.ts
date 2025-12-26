import { useRef, useEffect } from 'react'

/**
 * Hook that keeps a ref always in sync with the latest value.
 * Useful for accessing current values in callbacks/effects without stale closures.
 *
 * @example
 * const [count, setCount] = useState(0)
 * const countRef = useLatestRef(count)
 *
 * useEffect(() => {
 *   return () => {
 *     // countRef.current always has the latest value
 *     console.log('Cleanup with count:', countRef.current)
 *   }
 * }, []) // No need to include count in deps
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value)

  useEffect(() => {
    ref.current = value
  }, [value])

  return ref
}
