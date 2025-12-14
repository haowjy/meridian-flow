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
import type { Document } from '@/features/documents/types/document'
import { RetryScheduler, SyncOp, RetryCallbacks } from './retry'
import { makeLogger } from '@/core/lib/logger'

const log = makeLogger('sync')

/**
 * Retry operation stored in memory (not persisted).
 * Lost on page reload, but IndexedDB still has the content.
 */
// Retry scheduler for document content (policy-based)
let scheduler: RetryScheduler<string, string, Document> | null = null

// Separate scheduler for ai_version clearing (simpler: no payload needed)
let aiVersionScheduler: RetryScheduler<string, null, Document> | null = null

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

function ensureAIVersionScheduler(): RetryScheduler<string, null, Document> {
  if (!aiVersionScheduler) {
    aiVersionScheduler = new RetryScheduler<string, null, Document>({
      sync: async (op: SyncOp<string, null>) => {
        // Clear ai_version via API
        return await syncClearAIVersion(op.id)
      },
      maxAttempts: 3,
      tickMs: 1000,
    })
  }
  return aiVersionScheduler
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
  log.debug(`Syncing document`, documentId)

  // Call API - this returns the updated document from the server
  const updatedDoc = await api.documents.update(documentId, content)

  // Update IndexedDB with server's response
  // This ensures our cache has the authoritative timestamp from the server
  if (updatedDoc.content !== undefined) {
    await db.documents.put(updatedDoc as Document & { content: string })
  }

  log.info(`Synced document`, documentId)
  return updatedDoc
}

/**
 * Clear ai_version for a document directly to the backend.
 *
 * This is used when all AI diff chunks have been resolved (accepted/rejected).
 * After clearing, the document returns to normal editing mode.
 *
 * @param documentId - Document ID to clear ai_version for
 * @returns Updated document from server (with aiVersion cleared)
 * @throws Error if API call fails
 */
export async function syncClearAIVersion(documentId: string): Promise<Document> {
  log.debug(`Clearing ai_version`, documentId)

  const updatedDoc = await api.documents.deleteAIVersion(documentId)

  // Update IndexedDB with server's response
  if (updatedDoc.content !== undefined) {
    await db.documents.put(updatedDoc as Document & { content: string })
  }

  log.info(`Cleared ai_version`, documentId)
  return updatedDoc
}

/**
 * Add a failed ai_version clear operation to the retry queue.
 *
 * This is called when clearing ai_version fails due to network errors.
 * The operation will be retried automatically by the retry processor.
 *
 * @param documentId - Document ID to retry clearing ai_version for
 * @param cbs - Optional callbacks for success/failure
 */
export function addAIVersionClearRetry(
  documentId: string,
  cbs?: RetryCallbacks<Document>
) {
  const sched = ensureAIVersionScheduler()
  log.info(`Queued ai_version clear retry`, documentId)
  sched.add({ id: documentId, payload: null }, cbs)
}

/**
 * Cancel any pending ai_version clear retry for a document.
 *
 * This prevents duplicate clears if the user triggers another clear
 * while a retry is pending.
 */
export function cancelAIVersionClearRetry(documentId: string) {
  aiVersionScheduler?.cancel(documentId)
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
export function addRetryOperation(
  op: { entityType: 'document'; entityId: string; content: string; attemptCount: number },
  cbs?: RetryCallbacks<Document>
) {
  const sched = ensureScheduler()
  log.info(`Queued retry`, op.entityId, `attempt ${op.attemptCount + 1}/3`)

  sched.add({ id: op.entityId, payload: op.content }, cbs)
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
  log.debug(`Cancelled pending retry`, documentId)
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
// Network error classifier moved to core/lib/errors.ts to avoid duplication

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

  // Start both schedulers
  const contentSched = ensureScheduler()
  const aiVersionSched = ensureAIVersionScheduler()

  log.info('Starting retry schedulers')
  contentSched.start()
  aiVersionSched.start()
}

/**
 * Clean up the retry processor.
 * Should be called when the app unmounts.
 */
export function cleanupRetryProcessor(): void {
  log.info('Stopping retry schedulers')
  scheduler?.stop()
  aiVersionScheduler?.stop()
}

/**
 * Get current retry queue state (for debugging).
 */
export function getRetryQueueState() {
  const sched = ensureScheduler()
  return sched.snapshot()
}
