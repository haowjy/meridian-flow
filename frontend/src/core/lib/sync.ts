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
import { RetryScheduler, SyncOp } from './retry'

/**
 * Retry operation stored in memory (not persisted).
 * Lost on page reload, but IndexedDB still has the content.
 */
// Retry scheduler (policy-based)
let scheduler: RetryScheduler<string, string, Document> | null = null

function ensureScheduler(): RetryScheduler<string, string, Document> {
  if (!scheduler) {
    scheduler = new RetryScheduler<string, string, Document>({
      sync: async (op: SyncOp<string, string>) => {
        // Reuse syncDocument for actual API+IDB write
        return await syncDocument(op.id, op.payload)
      },
      // jittered backoff default inside scheduler
      maxAttempts: 3,
      tickMs: 1000,
    })
  }
  return scheduler
}

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
export function addRetryOperation(op: { entityType: 'document'; entityId: string; content: string; attemptCount: number }) {
  const sched = ensureScheduler()
  console.log(`[Sync] Queued retry for document ${op.entityId} (attempt ${op.attemptCount + 1}/3)`)

  sched.add({ id: op.entityId, payload: op.content }, {
    onSuccess: (updatedDoc) => {
      const store = useEditorStore.getState()
      if (store.activeDocument?.id === op.entityId) {
        if (store.activeDocument.content === op.content) {
          store.setStatus('saved')
          store.updateActiveDocument(updatedDoc)
          toast.success('Changes synced successfully')
        } else {
          console.log(`[Sync] Skipping store update - content changed since retry was queued`)
        }
      }
    },
    onPermanentFailure: () => {
      toast.error(
        `Failed to sync document after retries. ` +
        `Changes are saved locally and will be synced when connection is restored.`,
        { duration: 10000 }
      )
    },
  })
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
  const sched = ensureScheduler()
  console.log(`[Sync] Cancelled pending retry for document ${documentId}`)
  sched.cancel(documentId)
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
  // No-op: kept for backward compatibility; scheduler ticks internally.
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
  if (typeof window === 'undefined') return
  const sched = ensureScheduler()
  console.log('[Sync] Starting retry scheduler')
  sched.start()
}

/**
 * Clean up the retry processor.
 * Should be called when the app unmounts.
 */
export function cleanupRetryProcessor(): void {
  console.log('[Sync] Stopping retry scheduler')
  scheduler?.stop()
}

/**
 * Get current retry queue state (for debugging).
 */
export function getRetryQueueState() {
  return undefined
}
