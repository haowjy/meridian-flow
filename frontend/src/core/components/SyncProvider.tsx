'use client'

import { useEffect } from 'react'
import { initializeSyncListeners, cleanupSyncListeners } from '@/core/lib/sync'

/**
 * Provider component that initializes background sync listeners.
 * Handles online/offline events, visibility changes, and periodic sync.
 */
export function SyncProvider() {
  useEffect(() => {
    // Initialize sync listeners when component mounts
    initializeSyncListeners()

    // Cleanup on unmount
    return () => {
      cleanupSyncListeners()
    }
  }, [])

  // This component doesn't render anything
  return null
}
