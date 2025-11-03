/**
 * Sync queue infrastructure for local-first architecture.
 * Handles background sync of local changes to backend with retry logic.
 */

import { db } from './db'
import type { Document } from '@/features/documents/types/document'
import type { Chat, Message } from '@/features/chats/types/chat'

/**
 * Payload types for sync operations.
 * Create operations exclude server-generated fields.
 * Update operations allow partial updates.
 * Delete operations don't need data payload.
 */
type CreateDocumentData = Omit<Document, 'id' | 'updatedAt'>
type UpdateDocumentData = Partial<Omit<Document, 'id' | 'projectId'>>
type CreateChatData = Omit<Chat, 'id' | 'createdAt' | 'updatedAt'>
type UpdateChatData = Partial<Omit<Chat, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>
type CreateMessageData = Omit<Message, 'id' | 'createdAt'>
type UpdateMessageData = Partial<Omit<Message, 'id' | 'chatId' | 'createdAt'>>

/**
 * Sync operation stored in IndexedDB queue.
 * Discriminated union ensures type-safe data payloads based on operation and entity type.
 */
export type SyncOperation =
  | {
      id?: number
      operation: 'create'
      entityType: 'document'
      entityId: string
      data: CreateDocumentData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'update'
      entityType: 'document'
      entityId: string
      data: UpdateDocumentData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'delete'
      entityType: 'document'
      entityId: string
      data: undefined
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'create'
      entityType: 'chat'
      entityId: string
      data: CreateChatData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'update'
      entityType: 'chat'
      entityId: string
      data: UpdateChatData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'delete'
      entityType: 'chat'
      entityId: string
      data: undefined
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'create'
      entityType: 'message'
      entityId: string
      data: CreateMessageData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'update'
      entityType: 'message'
      entityId: string
      data: UpdateMessageData
      timestamp: Date
      retryCount: number
    }
  | {
      id?: number
      operation: 'delete'
      entityType: 'message'
      entityId: string
      data: undefined
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
export async function queueSync<
  T extends Omit<SyncOperation, 'id' | 'timestamp' | 'retryCount'>
>(operation: T): Promise<void> {
  // Type assertion is safe here: we take a valid partial SyncOperation,
  // add back the omitted fields, and the result is guaranteed to be a valid SyncOperation
  const syncOp = {
    ...operation,
    timestamp: new Date(),
    retryCount: 0,
  } as SyncOperation

  await db.syncQueue.add(syncOp)

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
