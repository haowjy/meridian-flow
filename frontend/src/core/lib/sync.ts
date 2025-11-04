/**
 * Sync queue infrastructure for local-first architecture.
 * Handles background sync of local changes to backend with retry logic.
 */

import { db } from './db'
import { api } from './api'
import { useEditorStore } from '@/core/stores/useEditorStore'
import type { Document } from '@/features/documents/types/document'
import type { Chat, Message } from '@/features/chats/types/chat'
import { toast } from 'sonner'

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
 * Attempts to sync each operation, handles retries with exponential backoff.
 */
export async function processSyncQueue(): Promise<void> {
  // Check if online
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.log('[Sync] Offline, skipping sync queue processing')
    return
  }

  const operations = await db.syncQueue.toArray()

  if (operations.length === 0) {
    return
  }

  console.log(`[Sync] Processing ${operations.length} queued operations`)

  for (const op of operations) {
    try {
      // Check if operation is ready to retry (based on backoff delay)
      const backoffDelay = calculateBackoff(op.retryCount)

      if (backoffDelay === Infinity) {
        // Max retries reached, log error and remove from queue
        console.error(`[Sync] Max retries reached for ${op.operation} ${op.entityType}:${op.entityId}`)
        toast.error(`Failed to sync ${op.entityType} after multiple attempts`)
        await db.syncQueue.delete(op.id!)
        continue
      }

      const timeSinceLastAttempt = Date.now() - op.timestamp.getTime()
      if (timeSinceLastAttempt < backoffDelay) {
        // Not ready to retry yet
        continue
      }

      // Attempt to sync based on entity type and operation
      await executeSyncOperation(op)

      // Success! Remove from queue
      await db.syncQueue.delete(op.id!)
      console.log(`[Sync] Successfully synced ${op.operation} ${op.entityType}:${op.entityId}`)

      // Update store status if this was the active document
      if (op.entityType === 'document') {
        const store = useEditorStore.getState()
        if (store.activeDocument?.id === op.entityId && store.status === 'local') {
          store.setStatus('saved')
        }
      }
    } catch (error) {
      // Sync failed, increment retry count and update timestamp
      console.error(`[Sync] Failed to sync ${op.operation} ${op.entityType}:${op.entityId}`, error)

      await db.syncQueue.update(op.id!, {
        retryCount: op.retryCount + 1,
        timestamp: new Date(),
      })
    }
  }
}

/**
 * Execute a single sync operation by calling the appropriate API method.
 */
async function executeSyncOperation(op: SyncOperation): Promise<void> {
  switch (op.entityType) {
    case 'document':
      await syncDocument(op)
      break
    case 'chat':
      await syncChat(op)
      break
    case 'message':
      await syncMessage(op)
      break
    default:
      throw new Error(`Unknown entity type: ${(op as any).entityType}`)
  }
}

/**
 * Sync a document operation to the backend.
 */
async function syncDocument(
  op: Extract<SyncOperation, { entityType: 'document' }>
): Promise<void> {
  switch (op.operation) {
    case 'create':
      // Note: Create operations would need projectId and folderId from the data
      // For now, skipping create sync as it's typically done immediately
      throw new Error('Document create sync not implemented (done synchronously)')
    case 'update':
      if (op.data.content !== undefined) {
        await api.documents.update(op.entityId, op.data.content)
      }
      break
    case 'delete':
      await api.documents.delete(op.entityId)
      break
  }
}

/**
 * Sync a chat operation to the backend.
 */
async function syncChat(
  op: Extract<SyncOperation, { entityType: 'chat' }>
): Promise<void> {
  switch (op.operation) {
    case 'create':
      // Note: Create operations would need projectId from the data
      throw new Error('Chat create sync not implemented (done synchronously)')
    case 'update':
      if (op.data.title !== undefined) {
        await api.chats.update(op.entityId, op.data.title)
      }
      break
    case 'delete':
      await api.chats.delete(op.entityId)
      break
  }
}

/**
 * Sync a message operation to the backend.
 */
async function syncMessage(
  op: Extract<SyncOperation, { entityType: 'message' }>
): Promise<void> {
  switch (op.operation) {
    case 'create':
      // Messages are typically created synchronously via send endpoint
      throw new Error('Message create sync not implemented (done synchronously)')
    case 'update':
      // Message updates are not supported in current API
      throw new Error('Message update not supported')
    case 'delete':
      // Message deletes are not supported in current API
      throw new Error('Message delete not supported')
  }
}

// Global references for cleanup
let syncInterval: NodeJS.Timeout | null = null
let onlineHandler: (() => void) | null = null
let visibilityHandler: (() => void) | null = null

/**
 * Initialize sync listeners (online, visibility, interval).
 * Should be called once when the app starts (e.g., in a root layout or provider).
 */
export function initializeSyncListeners(): void {
  if (typeof window === 'undefined') {
    return // Skip in SSR
  }

  console.log('[Sync] Initializing sync listeners')

  // 1. Listen for online event (user goes back online)
  onlineHandler = () => {
    console.log('[Sync] Network online, processing sync queue')
    processSyncQueue().catch((error) => {
      console.error('[Sync] Error processing sync queue on online event:', error)
    })
  }
  window.addEventListener('online', onlineHandler)

  // 2. Listen for visibility change (tab becomes visible)
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      console.log('[Sync] Tab visible, processing sync queue')
      processSyncQueue().catch((error) => {
        console.error('[Sync] Error processing sync queue on visibility change:', error)
      })
    }
  }
  document.addEventListener('visibilitychange', visibilityHandler)

  // 3. Periodic sync (every 30 seconds while app is running)
  syncInterval = setInterval(() => {
    processSyncQueue().catch((error) => {
      console.error('[Sync] Error processing sync queue on interval:', error)
    })
  }, 30000) // 30 seconds

  // Initial sync on startup
  processSyncQueue().catch((error) => {
    console.error('[Sync] Error processing sync queue on startup:', error)
  })
}

/**
 * Clean up sync listeners and intervals.
 * Should be called when the app is unmounting or cleaning up.
 */
export function cleanupSyncListeners(): void {
  console.log('[Sync] Cleaning up sync listeners')

  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler)
    onlineHandler = null
  }

  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }

  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
