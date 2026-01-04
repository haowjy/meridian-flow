import type { Document } from '@/features/documents/types/document'
import { db } from '@/core/lib/db'
import { addRetryOperation, cancelRetry, syncDocument } from '@/core/lib/sync'
import { isNetworkError, isAbortError, isConflictError, extractDocumentFromConflict } from '@/core/lib/errors'
import type { RetryCallbacks } from '@/core/lib/retry'
import { saveMergedDocument, type SaveMergedResult } from '@/core/services/saveMergedDocument'

export type SaveCallbacks = {
  onServerSaved?: (doc: Document) => void
  onRetryScheduled?: () => void
  onPermanentFailure?: (error: unknown) => void
}

export type SaveMergedCallbacks = {
  onServerSaved?: (result: SaveMergedResult) => void
  onAIVersionConflict?: (serverDocument?: Document) => void
  onRetryScheduled?: () => void
  onError?: (error: Error) => void
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

  queueRetry(documentId: string, content: string, cbs?: RetryCallbacks<Document>) {
    addRetryOperation({ entityType: 'document', entityId: documentId, content, attemptCount: 0 }, cbs)
  }

  cancelRetry(documentId: string) {
    cancelRetry(documentId)
  }

  /**
   * Save a merged document (with PUA markers).
   *
   * Parses the document to extract content/aiVersion and saves both.
   * If no markers remain, clears aiVersion (AI session complete).
   *
   * Error handling:
   * - Abort errors: silent (user cancelled)
   * - Network errors: callback (for retry UI)
   * - Conflict errors: callback (ai_version_rev mismatch, user must refresh)
   * - Other errors: callback + rethrow
   */
  async saveMerged(
    documentId: string,
    merged: string,
    options: { aiVersionBaseRev: number; serverHasAIVersion: boolean },
    cbs?: SaveMergedCallbacks
  ): Promise<void> {
    // Cancel any pending retries (newer content wins)
    cancelRetry(documentId)

    try {
      const result = await saveMergedDocument(documentId, merged, options)
      cbs?.onServerSaved?.(result)
    } catch (error) {
      if (isAbortError(error)) {
        // Cancelled by user (e.g., switched documents), no action needed
        return
      }

      if (isNetworkError(error)) {
        // For now, just report error. Full retry support can be added later.
        // The merged document is already in IndexedDB for recovery.
        cbs?.onRetryScheduled?.()
        return
      }

      if (isConflictError(error)) {
        // ai_version_rev mismatch: server has a newer ai_version than the client saw.
        // Do not retry blindly; surface to UI so user can refresh from server.
        cbs?.onAIVersionConflict?.(extractDocumentFromConflict(error))
        return
      }

      cbs?.onError?.(error as Error)
      throw error
    }
  }
}

export const documentSyncService = new DocumentSyncService()

