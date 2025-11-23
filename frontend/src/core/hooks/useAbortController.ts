import { useEffect, useMemo } from 'react'

/**
 * Hook to manage AbortController for cancellable fetch requests.
 * Automatically aborts on component unmount or when dependencies change.
 *
 * @param deps - Optional dependencies array. When any dependency changes, the previous request is aborted and a new AbortController is created.
 * @returns AbortSignal to pass to fetch requests
 *
 * @example
 * ```tsx
 * function TurnList({ chatId }: { chatId: string }) {
 *   const signal = useAbortController([chatId])
 *   const [turns, setTurns] = useState([])
 *
 *   useEffect(() => {
 *     // Fetch will be aborted if component unmounts or chatId changes
 *     fetch(`/api/chats/${chatId}/turns`, { signal })
 *       .then(res => res.json())
 *       .then(setTurns)
 *       .catch(err => {
 *         if (err.name !== 'AbortError') {
 *           console.error('Fetch failed:', err)
 *         }
 *       })
 *   }, [chatId, signal])
 *
 *   return <div>{turns.map(...)}</div>
 * }
 * ```
 */
export function useAbortController(deps?: React.DependencyList): AbortSignal {
  // Use a serialized dependency key so React's hook rules can statically
  // validate the dependency array while still allowing a dynamic list.
  const depsKey = JSON.stringify(deps ?? [])

  // Create controller synchronously during render when deps change
  // This ensures the signal is fresh and not aborted when returned
  const controller = useMemo(() => {
    // Depend on depsKey so the controller resets when dependencies change.
    void depsKey
    return new AbortController()
  }, [depsKey])

  // Abort controller on unmount or when deps change (creating new controller)
  useEffect(() => {
    return () => {
      controller.abort()
    }
  }, [controller])

  return controller.signal
}
