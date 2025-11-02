import { useEffect, useState } from 'react'

/**
 * Hook to track online/offline status.
 * Updates immediately when browser detects connectivity changes.
 *
 * @returns Current online status (true = online, false = offline)
 *
 * @example
 * ```tsx
 * function NetworkIndicator() {
 *   const isOnline = useOnlineStatus()
 *
 *   if (isOnline) return null
 *
 *   return (
 *     <div className="bg-orange-500 text-white px-4 py-2">
 *       You're offline. Changes will sync when you're back online.
 *     </div>
 *   )
 * }
 * ```
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}
