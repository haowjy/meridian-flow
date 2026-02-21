import { create } from "zustand";
import type { Document } from "@/features/documents/types/document";
import type { SaveStatus } from "@/shared/components/ui/StatusBadge";
import { api } from "@/core/lib/api";
import { db } from "@/core/lib/db";
import {
  loadWithPolicy,
  ReconcileNewestPolicy,
  ICacheRepo,
  IRemoteRepo,
} from "@/core/lib/cache";
import { documentSyncService } from "@/core/services/documentSyncService";
import { purgeDeletedDocumentLocalState } from "@/core/services/documentCleanupService";
import { shouldPruneLocalEntity } from "@/core/retrieval";
import { getErrorMessageWithFallback, isAbortError } from "@/core/lib/errors";
import { makeLogger } from "@/core/lib/logger";
import { useRecentDocumentsStore } from "./useRecentDocumentsStore";

const logger = makeLogger("editor-store");

interface EditorStore {
  activeDocument: Document | null;
  _activeDocumentId: string | null; // Internal: track which doc SHOULD be active (race prevention)
  status: SaveStatus;
  lastSaved: Date | null;
  isLoading: boolean;
  error: string | null;

  loadDocument: (documentId: string, signal?: AbortSignal) => Promise<void>;
  saveDocument: (documentId: string, content: string) => Promise<void>;
  setStatus: (status: SaveStatus) => void;
  updateActiveDocument: (document: Document) => void;
  /** Force refresh document from server (e.g., after AI edit tool) */
  refreshDocument: (documentId: string) => Promise<void>;
  /** Clear the error state */
  clearError: () => void;
}

export const useEditorStore = create<EditorStore>()((set, get) => ({
  activeDocument: null,
  _activeDocumentId: null,
  status: "saved",
  lastSaved: null,
  isLoading: false,
  error: null,

  loadDocument: async (documentId: string, signal?: AbortSignal) => {
    // CRITICAL: Set expected document ID FIRST (synchronous, before any await)
    // This prevents race conditions when user rapidly switches documents
    set({
      _activeDocumentId: documentId,
      isLoading: true,
      error: null,
    });

    logger.debug(`Starting load for document ${documentId}`);

    const cacheRepo: ICacheRepo<Document> = {
      get: async () => {
        const d = await db.documents.get(documentId);
        return d && d.content !== undefined ? d : undefined;
      },
      put: async (doc) => {
        const withContent = doc as Document & { content?: unknown };
        if (withContent.content !== undefined) {
          await db.documents.put(withContent as Document & { content: string });
        }
      },
    };

    const remoteRepo: IRemoteRepo<Document> = {
      fetch: () => api.documents.get(documentId, { signal }),
    };

    try {
      const final = await loadWithPolicy<Document>(
        new ReconcileNewestPolicy<Document>(),
        {
          cacheRepo,
          remoteRepo,
          signal,
          onIntermediate: (r) => {
            if (get()._activeDocumentId !== documentId) return;
            // Show cached content immediately and allow UI to render
            set({ activeDocument: r.data, isLoading: false });
          },
        },
      );

      if (get()._activeDocumentId !== documentId) return;

      set({
        activeDocument: final.data,
        status: "saved",
        isLoading: false,
      });
      // Track recent document access (document has projectId from API response)
      useRecentDocumentsStore
        .getState()
        .addRecent(final.data.projectId, documentId);
    } catch (error) {
      // Handle AbortError silently (expected when user switches documents)
      if (isAbortError(error)) {
        if (get()._activeDocumentId === documentId) {
          set({ isLoading: false });
        }
        logger.debug(`Aborted load for ${documentId}`);
        return;
      }

      if (shouldPruneLocalEntity("document:getById", error)) {
        await purgeDeletedDocumentLocalState(documentId);
        if (get()._activeDocumentId !== documentId) return;
        set((state) => ({
          activeDocument:
            state.activeDocument?.id === documentId
              ? null
              : state.activeDocument,
          error: getErrorMessageWithFallback(error, "Document not found"),
          isLoading: false,
        }));
        return;
      }

      // Ignore stale request failures that no longer match the active doc.
      if (get()._activeDocumentId !== documentId) return;

      // Real errors: set error state for inline display
      const message = getErrorMessageWithFallback(
        error,
        "Failed to load document",
      );
      logger.error(`Failed to load document ${documentId}:`, error);
      set({ error: message, isLoading: false });
    }
  },

  saveDocument: async (documentId: string, content: string) => {
    logger.info("saveDocument called", {
      documentId,
      contentLength: content.length,
    });
    set({ status: "saving", error: null });
    const currentDoc = get().activeDocument;
    try {
      await documentSyncService.save(
        documentId,
        content,
        currentDoc ?? undefined,
        {
          onServerSaved: (serverDoc) => {
            if (get()._activeDocumentId === documentId) {
              set({
                activeDocument: serverDoc,
                status: "saved",
                lastSaved: serverDoc.updatedAt,
                error: null,
              });
            }
          },
          onRetryScheduled: () => {
            // Keep showing "saving" status while retry is pending
            // Status badge will show 'saving' state
            logger.debug("Save retry scheduled, keeping saving status");
          },
          onPermanentFailure: (err) => {
            const message =
              err instanceof Error
                ? err.message
                : "Failed to sync after retries";
            set({ status: "error", error: message });
          },
        },
      );
    } catch (error) {
      // Client/validation errors (no retry)
      const message = getErrorMessageWithFallback(
        error,
        "Failed to save document",
      );
      set({ status: "error", error: message });
    }
  },

  setStatus: (status) => set({ status }),

  updateActiveDocument: (document) =>
    set({
      activeDocument: document,
      lastSaved: document.updatedAt,
    }),

  refreshDocument: async (documentId: string) => {
    // Skip if this isn't the active document
    if (get()._activeDocumentId !== documentId) return;

    logger.debug(`Force refreshing document ${documentId}`);

    try {
      // Fetch fresh from server, bypassing cache comparison
      const doc = await api.documents.get(documentId);

      // Only update if still the active document
      if (get()._activeDocumentId !== documentId) return;

      // Update state
      set({
        activeDocument: doc,
        status: "saved",
        lastSaved: doc.updatedAt,
      });

      // Update cache with fresh data (ensure content is defined for IndexedDB)
      if (doc.content !== undefined) {
        await db.documents.put(doc as Document & { content: string });
      }

      logger.info(`Refreshed document ${documentId}`);
    } catch (error) {
      // Silent fail - this is a background refresh, not a user action
      logger.warn(`Failed to refresh document ${documentId}:`, error);
    }
  },

  clearError: () => set({ error: null }),
}));
