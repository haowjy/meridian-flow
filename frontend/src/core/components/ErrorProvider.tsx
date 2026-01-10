import { useEffect } from 'react'
import { useErrorStore } from '@/core/stores/useErrorStore'

/**
 * Provider component that initializes global error handling.
 *
 * Currently sets up:
 * - Network status listeners (online/offline events)
 *
 * Mount once at app root to enable network status monitoring.
 */
export function ErrorProvider() {
  useEffect(() => {
    // Initialize network listeners
    const cleanup = useErrorStore.getState().initNetworkListeners()

    return cleanup
  }, [])

  // This component doesn't render anything
  return null
}
