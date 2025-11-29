import { useEffect } from 'react'
import { initializeRetryProcessor, cleanupRetryProcessor } from '@/core/lib/sync'

/**
 * Provider component that initializes the retry processor.
 *
 * The retry processor is the only background sync mechanism in the new system.
 * It checks for failed sync operations every 5 seconds and retries them.
 *
 * Unlike the old queue-based system, there are no event listeners racing
 * with each other, making the sync behavior predictable and debuggable.
 */
export function SyncProvider() {
  useEffect(() => {
    // Initialize retry processor when component mounts
    initializeRetryProcessor()

    // Cleanup on unmount
    return () => {
      cleanupRetryProcessor()
    }
  }, [])

  // This component doesn't render anything
  return null
}
