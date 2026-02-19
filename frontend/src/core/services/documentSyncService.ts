import type { Document } from "@/features/documents/types/document";
import { db } from "@/core/lib/db";
import { syncDocument } from "@/core/lib/sync";
import { isNetworkError, isAbortError } from "@/core/lib/errors";
import { makeLogger } from "@/core/lib/logger";

const log = makeLogger("doc-sync-service");

export type SaveCallbacks = {
  onServerSaved?: (doc: Document) => void;
  onRetryScheduled?: () => void;
  onPermanentFailure?: (error: unknown) => void;
};

export class DocumentSyncService {
  /**
   * Save with optimistic local update and retry-on-network-failure.
   * UI concerns are surfaced via callbacks; no direct store/toast usage here.
   *
   * On network/5xx failure the save is persisted to the `pendingDocumentSaves`
   * Dexie table so it survives page reload. The persistent drain (see
   * `persistentSaveDrain.ts`) picks it up on next startup / online event.
   */
  async save(
    documentId: string,
    content: string,
    currentDoc?: Document,
    cbs?: SaveCallbacks,
  ): Promise<void> {
    // Remove any stale pending save for this document (newer content wins)
    await db.pendingDocumentSaves.delete(documentId);

    const now = new Date();

    // Optimistic update in IndexedDB
    const updated = await db.documents.update(documentId, {
      content,
      updatedAt: now,
    });

    if (updated === 0 && currentDoc && currentDoc.id === documentId) {
      await db.documents.put({ ...currentDoc, content, updatedAt: now });
    }

    try {
      const serverDoc = await syncDocument(documentId, content);
      cbs?.onServerSaved?.(serverDoc);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      if (isNetworkError(error)) {
        // Persist the failed save to IndexedDB for cross-session retry.
        // Uses documentId as key → last-write-wins (put overwrites).
        log.info("Persisting failed save for retry", documentId);
        try {
          await db.pendingDocumentSaves.put({
            documentId,
            content,
            createdAt: new Date().toISOString(),
          });
        } catch (dbError) {
          // Keep network failure handling predictable if IndexedDB persistence fails.
          // Optimistic content still exists in the local `documents` table.
          log.warn(
            "Failed to persist pending save to IndexedDB",
            documentId,
            dbError,
          );
        }
        cbs?.onRetryScheduled?.();
        return;
      }

      // Client/validation errors bubble to caller
      throw error;
    }
  }

  /**
   * Cancel any pending persistent retry for a document.
   * Called when a newer save supersedes a pending one.
   */
  async cancelRetry(documentId: string): Promise<void> {
    await db.pendingDocumentSaves.delete(documentId);
  }
}

export const documentSyncService = new DocumentSyncService();
