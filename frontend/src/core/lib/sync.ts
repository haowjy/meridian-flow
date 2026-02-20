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

import { api } from "./api";
import { db } from "./db";
import type { Document } from "@/features/documents/types/document";
import { RetryScheduler, SyncOp } from "./retry";
import { makeLogger } from "@/core/lib/logger";

const log = makeLogger("sync");

/**
 * Retry operation stored in memory (not persisted).
 * Lost on page reload, but IndexedDB still has the content.
 */
// Retry scheduler for document content (policy-based)
let scheduler: RetryScheduler<string, string, Document> | null = null;

function ensureScheduler(): RetryScheduler<string, string, Document> {
  if (!scheduler) {
    scheduler = new RetryScheduler<string, string, Document>({
      sync: async (op: SyncOp<string, string>) => {
        // Reuse syncDocument for actual API+IDB write
        return await syncDocument(op.id, op.payload);
      },
      // jittered backoff default inside scheduler
      maxAttempts: 3,
      tickMs: 1000,
    });
  }
  return scheduler;
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
  content: string,
): Promise<Document> {
  log.debug(`Syncing document`, documentId);

  // Call API - this returns the updated document from the server
  const updatedDoc = await api.documents.update(documentId, { content });

  // Update IndexedDB with server's response
  // This ensures our cache has the authoritative timestamp from the server
  if (updatedDoc.content !== undefined) {
    await db.documents.put(updatedDoc as Document & { content: string });
  }

  log.info(`Synced document`, documentId);
  return updatedDoc;
}

/**
 * Cancel any pending retry for a document.
 *
 * This is called when:
 * 1. A new save is triggered (user kept typing) -> abandon old retry
 * 2. A retry succeeds -> remove from queue
 * 3. Max retries reached -> remove from queue
 *
 * This prevents stale retries from overwriting newer content.
 */
export function cancelRetry(documentId: string) {
  const sched = ensureScheduler();
  log.debug(`Cancelled pending retry`, documentId);
  sched.cancel(documentId);
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
  if (typeof window === "undefined") return;

  const contentSched = ensureScheduler();
  log.info("Starting retry scheduler");
  contentSched.start();
}

/**
 * Clean up the retry processor.
 * Should be called when the app unmounts.
 */
export function cleanupRetryProcessor(): void {
  log.info("Stopping retry scheduler");
  scheduler?.stop();
}
