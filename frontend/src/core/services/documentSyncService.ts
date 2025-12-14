import type { Document } from '@/features/documents/types/document'
import { db } from '@/core/lib/db'
import {
  addRetryOperation,
  cancelRetry,
  syncDocument,
  syncClearAIVersion,
  addAIVersionClearRetry,
  cancelAIVersionClearRetry,
} from '@/core/lib/sync'
import { isNetworkError } from '@/core/lib/errors'
import type { RetryCallbacks } from '@/core/lib/retry'

export type SaveCallbacks = {
  onServerSaved?: (doc: Document) => void
  onRetryScheduled?: () => void
  onPermanentFailure?: (error: unknown) => void
}

export class DocumentSyncService {
  /**
   * Save with optimistic local update and retry-on-network-failure.
   * UI concerns are surfaced via callbacks; no direct store/toast usage here.
   */
  async save(
    documentId: string,
    content: string,
    currentDoc?: Document,
    cbs?: SaveCallbacks
  ): Promise<void> {
    // Cancel pending retry for this document (newer content wins)
    cancelRetry(documentId)

    const now = new Date()

    // Optimistic update in IndexedDB
    const updated = await db.documents.update(documentId, {
      content,
      updatedAt: now,
    })

    if (updated === 0 && currentDoc && currentDoc.id === documentId) {
      await db.documents.put({ ...currentDoc, content, updatedAt: now })
    }

    try {
      const serverDoc = await syncDocument(documentId, content)
      cbs?.onServerSaved?.(serverDoc)
    } catch (error) {
      if (isNetworkError(error)) {
        // Schedule retry with mapped callbacks
        const callbacks: RetryCallbacks<Document> = {
          onSuccess: (doc) => cbs?.onServerSaved?.(doc),
          onPermanentFailure: (err) => cbs?.onPermanentFailure?.(err),
        }
        addRetryOperation(
          { entityType: 'document', entityId: documentId, content, attemptCount: 0 },
          callbacks
        )
        cbs?.onRetryScheduled?.()
        return
      }

      // Client/validation errors bubble to caller
      throw error
    }
  }

  /**
   * Clear ai_version with optimistic local update and retry-on-network-failure.
   *
   * Called when all AI diff chunks have been resolved (accepted/rejected).
   * Uses the same pattern as save(): optimistic IndexedDB → server → retry.
   */
  async clearAIVersion(documentId: string, cbs?: SaveCallbacks): Promise<void> {
    // Cancel any pending retry for this document
    cancelAIVersionClearRetry(documentId)

    // Optimistic update in IndexedDB - clear ai_version locally
    // This provides immediate UI feedback (merge mode disappears)
    await db.documents.update(documentId, { aiVersion: undefined })

    try {
      const serverDoc = await syncClearAIVersion(documentId)
      cbs?.onServerSaved?.(serverDoc)
    } catch (error) {
      if (isNetworkError(error)) {
        // Schedule retry with mapped callbacks
        const callbacks: RetryCallbacks<Document> = {
          onSuccess: (doc) => cbs?.onServerSaved?.(doc),
          onPermanentFailure: (err) => cbs?.onPermanentFailure?.(err),
        }
        addAIVersionClearRetry(documentId, callbacks)
        cbs?.onRetryScheduled?.()
        return
      }

      // Client/validation errors bubble to caller
      throw error
    }
  }

  queueRetry(documentId: string, content: string, cbs?: RetryCallbacks<Document>) {
    addRetryOperation({ entityType: 'document', entityId: documentId, content, attemptCount: 0 }, cbs)
  }

  cancelRetry(documentId: string) {
    cancelRetry(documentId)
  }
}

export const documentSyncService = new DocumentSyncService()

