import { useEffect, useRef } from 'react'

/**
 * Hook to manage AbortController for cancellable fetch requests.
 * Automatically aborts on component unmount or when dependencies change.
 *
 * @param deps - Optional dependencies array. When any dependency changes, the previous request is aborted and a new AbortController is created.
 * @returns AbortSignal to pass to fetch requests
 *
 * @example
 * ```tsx
 * function MessageList({ chatId }: { chatId: string }) {
 *   const signal = useAbortController([chatId])
 *   const [messages, setMessages] = useState([])
 *
 *   useEffect(() => {
 *     // Fetch will be aborted if component unmounts or chatId changes
 *     fetch(`/api/chats/${chatId}/messages`, { signal })
 *       .then(res => res.json())
 *       .then(setMessages)
 *       .catch(err => {
 *         if (err.name !== 'AbortError') {
 *           console.error('Fetch failed:', err)
 *         }
 *       })
 *   }, [chatId, signal])
 *
 *   return <div>{messages.map(...)}</div>
 * }
 * ```
 */
export function useAbortController(deps?: React.DependencyList): AbortSignal {
  const controllerRef = useRef<AbortController>(new AbortController())

  useEffect(() => {
    // Create new controller on dependency change (abort previous)
    const previousController = controllerRef.current
    previousController.abort()

    controllerRef.current = new AbortController()

    // Abort on unmount
    return () => {
      controllerRef.current.abort()
    }
  }, deps || [])

  return controllerRef.current.signal
}
