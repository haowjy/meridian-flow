/**
 * Sync queue infrastructure for local-first architecture.
 * Handles background sync of local changes to backend with retry logic.
 */

import { db } from './db'

/**
 * Sync operation stored in IndexedDB queue.
 */
export interface SyncOperation {
  id?: number
  operation: 'create' | 'update' | 'delete'
  entityType: 'document' | 'chat' | 'message'
  entityId: string
  data: any
  timestamp: Date
  retryCount: number
}

/**
 * Calculate exponential backoff delay for retry attempts.
 * Returns delay in milliseconds: 1s → 2s → 4s → 8s → 16s
 * Returns Infinity after max retries (5).
 *
 * @param retryCount - Current retry attempt (0-based)
 * @returns Delay in milliseconds
 */
export function calculateBackoff(retryCount: number): number {
  const MAX_RETRIES = 5

  if (retryCount >= MAX_RETRIES) {
    return Infinity
  }

  // Exponential backoff: 2^n * 1000ms
  return Math.pow(2, retryCount) * 1000
}

/**
 * Add operation to sync queue for background processing.
 * Non-blocking - actual sync happens via processSyncQueue().
 *
 * @param operation - Sync operation to queue
 */
export async function queueSync(
  operation: Omit<SyncOperation, 'id' | 'timestamp' | 'retryCount'>
): Promise<void> {
  await db.syncQueue.add({
    ...operation,
    timestamp: new Date(),
    retryCount: 0,
  })

  console.log(`[Sync] Queued ${operation.operation} ${operation.entityType}:${operation.entityId}`)
}

/**
 * Process all pending sync operations in the queue.
 * Called by sync listeners (online event, visibility change, interval).
 *
 * Implementation in Phase 4 Task 4.13.
 */
export async function processSyncQueue(): Promise<void> {
  // Skeleton - will be implemented in Phase 4
  console.log('[Sync] processSyncQueue called (not yet implemented)')
}

/**
 * Initialize sync listeners (online, visibility, interval).
 *
 * Implementation in Phase 4 Task 4.14.
 */
export function initializeSyncListeners(): void {
  // Skeleton - will be implemented in Phase 4
  console.log('[Sync] initializeSyncListeners called (not yet implemented)')
}

/**
 * Clean up sync listeners and intervals.
 *
 * Implementation in Phase 4 Task 4.14.
 */
export function cleanupSyncListeners(): void {
  // Skeleton - will be implemented in Phase 4
  console.log('[Sync] cleanupSyncListeners called (not yet implemented)')
}
