/**
 * Simplified direct sync system for local-first architecture.
 *
 * Design Philosophy:
 * - Direct sync on save (no persistent queue)
 * - Optimistic updates to IndexedDB first (instant feedback)
 * - Always apply server responses (source of truth for timestamps)
 * - Simple retry mechanism for network failures only (3 attempts, 5s delay)
 * - In-memory retry queue (cleared on page reload)
 *
 * This eliminates race conditions from the old queue-based system while maintaining
 * reliability through automatic retries and proper error handling.
 */

import { api } from './api'
import { db } from './db'
import { useEditorStore } from '@/core/stores/useEditorStore'
import type { Document } from '@/features/documents/types/document'
import { toast } from 'sonner'

/**
 * Retry operation stored in memory (not persisted).
 * Lost on page reload, but IndexedDB still has the content.
 */
interface RetryOperation {
  entityType: 'document'
  entityId: string
  content: string
  attemptCount: number
  nextRetryAt: Date
}

// In-memory retry queue (key = documentId)
const retryQueue = new Map<string, RetryOperation>()

// Track active sync operations to prevent duplicates
const activeSyncs = new Set<string>()

// Retry processor interval reference
let retryInterval: NodeJS.Timeout | null = null

/**
 * Sync a document directly to the backend.
 *
 * This is the core sync function. It:
 * 1. Calls the API to update the document
 * 2. Returns the server's response (includes server timestamp)
 *
 * The caller is responsible for applying the response to local state.
 *
 * @param documentId - Document ID to sync
 * @param content - Document content to sync
 * @returns Updated document from server (with server's timestamp)
 * @throws Error if API call fails
 */
export async function syncDocument(
  documentId: string,
  content: string
): Promise<Document> {
  console.log(`[Sync] Syncing document ${documentId}`)

  // Call API - this returns the updated document from the server
  const updatedDoc = await api.documents.update(documentId, content)

  // Update IndexedDB with server's response
  // This ensures our cache has the authoritative timestamp from the server
  if (updatedDoc.content !== undefined) {
    await db.documents.put(updatedDoc as Document & { content: string })
  }

  console.log(`[Sync] Successfully synced document ${documentId}`)
  return updatedDoc
}

/**
 * Add a failed sync operation to the retry queue.
 *
 * This is called when a sync fails due to network errors (not client errors).
 * The operation will be retried automatically by the retry processor.
 *
 * NOTE: If the user keeps typing and triggers a new save, the new save will
 * automatically supersede this retry (newer content wins).
 *
 * @param op - Retry operation to queue
 */
export function addRetryOperation(op: Omit<RetryOperation, 'nextRetryAt'>) {
  const operation: RetryOperation = {
    ...op,
    nextRetryAt: new Date(Date.now() + 5000), // Retry after 5 seconds
  }

  retryQueue.set(op.entityId, operation)
  console.log(`[Sync] Queued retry for document ${op.entityId} (attempt ${op.attemptCount + 1}/3)`)
}

/**
 * Cancel any pending retry for a document.
 *
 * This is called when:
 * 1. A new save is triggered (user kept typing) → abandon old retry
 * 2. A retry succeeds → remove from queue
 * 3. Max retries reached → remove from queue
 *
 * This prevents stale retries from overwriting newer content.
 */
export function cancelRetry(documentId: string) {
  if (retryQueue.has(documentId)) {
    console.log(`[Sync] Cancelled pending retry for document ${documentId}`)
    retryQueue.delete(documentId)
  }
}

/**
 * Process all pending retry operations.
 *
 * This runs in the background (every 5 seconds) to retry failed sync operations.
 * It's the only "background" processing in the new sync system.
 *
 * For each retry:
 * - Check if enough time has passed since last attempt (5s delay)
 * - Attempt to sync to backend
 * - On success: Remove from queue, update store status
 * - On failure: Increment attempt count, schedule next retry
 * - After 3 attempts: Give up, show error to user
 */
export async function processRetryQueue() {
  if (retryQueue.size === 0) return

  const now = new Date()
  console.log(`[Sync] Processing ${retryQueue.size} retry operations`)

  for (const [documentId, op] of retryQueue.entries()) {
    // Check if ready to retry (5s delay between attempts)
    if (op.nextRetryAt > now) {
      continue
    }

    // Skip if already syncing (prevents duplicate concurrent syncs)
    if (activeSyncs.has(documentId)) {
      console.log(`[Sync] Skipping retry for ${documentId} - sync already in progress`)
      continue
    }

    try {
      activeSyncs.add(documentId)

      // Attempt to sync
      const updatedDoc = await syncDocument(documentId, op.content)

      // Success! Remove from retry queue
      retryQueue.delete(documentId)

      // Update store if this is the active document
      const store = useEditorStore.getState()
      if (store.activeDocument?.id === documentId) {
        // Only update if content hasn't changed (avoid overwriting newer edits)
        if (store.activeDocument.content === op.content) {
          store.setStatus('saved')
          store.updateActiveDocument(updatedDoc)
          toast.success('Changes synced successfully')
        } else {
          console.log(`[Sync] Skipping store update - content has changed since retry was queued`)
        }
      }
    } catch (error) {
      // Retry failed
      console.error(`[Sync] Retry attempt ${op.attemptCount + 1} failed for ${documentId}:`, error)

      if (op.attemptCount >= 2) {
        // Max retries (3 total attempts: initial + 2 retries)
        retryQueue.delete(documentId)
        toast.error(
          `Failed to sync document after 3 attempts. ` +
          `Changes are saved locally and will be synced when connection is restored.`,
          { duration: 10000 }
        )
      } else {
        // Schedule next retry
        op.attemptCount++
        op.nextRetryAt = new Date(Date.now() + 5000)
      }
    } finally {
      activeSyncs.delete(documentId)
    }
  }
}

/**
 * Check if an error is a network error (should retry).
 *
 * Network errors: Connection failed, timeout, 5xx server errors
 * Client errors: 400, 404, validation errors (should NOT retry)
 *
 * @param error - Error to check
 * @returns true if this is a network error
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // Check for common network error patterns
  const message = error.message.toLowerCase()

  // Fetch API network errors
  if (message.includes('network') || message.includes('fetch')) return true

  // Timeout errors
  if (message.includes('timeout')) return true

  // Check if it's an HTTP error response
  // In our API layer, 5xx errors should throw with status code
  if ('status' in error) {
    const status = (error as any).status
    // 5xx server errors: retry
    if (status >= 500) return true
    // 4xx client errors: don't retry
    if (status >= 400) return false
  }

  // Default: treat as network error to be safe
  return true
}

/**
 * Initialize the retry processor.
 *
 * This starts a background interval that checks for pending retries every 5 seconds.
 * Should be called once when the app starts (in SyncProvider or root layout).
 *
 * Note: This is the ONLY background processing in the new sync system.
 * Unlike the old system, we don't have online/visibility listeners racing with each other.
 */
export function initializeRetryProcessor(): void {
  if (typeof window === 'undefined') return // Skip in SSR
  if (retryInterval) return // Already initialized

  console.log('[Sync] Initializing retry processor (5s interval)')

  retryInterval = setInterval(() => {
    processRetryQueue().catch((error) => {
      console.error('[Sync] Error processing retry queue:', error)
    })
  }, 5000)
}

/**
 * Clean up the retry processor.
 * Should be called when the app unmounts.
 */
export function cleanupRetryProcessor(): void {
  console.log('[Sync] Cleaning up retry processor')

  if (retryInterval) {
    clearInterval(retryInterval)
    retryInterval = null
  }
}

/**
 * Get current retry queue state (for debugging).
 */
export function getRetryQueueState() {
  return {
    size: retryQueue.size,
    operations: Array.from(retryQueue.entries()).map(([id, op]) => ({
      documentId: id,
      attemptCount: op.attemptCount,
      nextRetryAt: op.nextRetryAt,
    })),
  }
}
