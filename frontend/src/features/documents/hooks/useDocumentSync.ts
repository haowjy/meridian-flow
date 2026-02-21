/**
 * useDocumentSync - Debounced save, flush on unmount.
 *
 * This is a pure effect hook (returns nothing) that handles:
 * - Debounced save (1s after user stops typing)
 * - Flush on unmount (save pending changes when navigating away)
 * - Corruption repair (rehydrate if adapter conversion fails)
 *
 * Designed for composition with useDocumentContent.
 * Receives syncContext from useDocumentContent for state coordination.
 *
 * NOTE: Only active for non-collab extensions. When collab is enabled,
 * Yjs owns persistence and this hook is disabled via `enabled=false`.
 */

import { useEffect, useMemo, useRef } from "react";
import { makeLogger } from "@/core/lib/logger";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { documentSyncService } from "@/core/services/documentSyncService";
import type { DocumentSyncContext } from "./useDocumentContent";
import type { BaseEditorRef } from "@/core/editor/types/editorRegistry";
import { createTextDocumentContentDriver } from "./documentContentDriver";

const log = makeLogger("use-document-sync");

// =============================================================================
// TYPES
// =============================================================================

interface HydrationInput {
  content: string;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Document sync hook for text documents.
 *
 * @param documentId - Document ID to sync
 * @param extension - File extension (used to determine adapter)
 * @param syncContext - Sync context from useDocumentContent
 * @param localDocument - Local editor content
 * @param hasUserEdit - Whether user has made edits
 * @param editorRef - Editor reference for programmatic access
 * @param hydrateDocument - Hydration function for corruption repair
 * @param enabled - Whether sync is active (false when collab owns persistence)
 */
export function useDocumentSync(
  documentId: string,
  extension: string,
  syncContext: DocumentSyncContext,
  localDocument: string,
  hasUserEdit: boolean,
  editorRef: React.MutableRefObject<BaseEditorRef<string> | null>,
  hydrateDocument: (doc: HydrationInput) => void,
  enabled = true,
): void {
  const contentDriver = useMemo(
    () => createTextDocumentContentDriver(extension),
    [extension],
  );
  const {
    pendingServerSnapshot,
    setPendingServerSnapshot,
    editVersionRef,
    resetEditVersion,
    localDocumentRef,
    hasUserEditRef,
    initializedRef,
    activeDocumentRef,
  } = syncContext;

  // Get activeDocument from store for save logic
  const activeDocument = useEditorStore((s) => s.activeDocument);

  // Save timer ref
  const saveTimerRef = useRef<number | null>(null);

  // ---------------------------------------------------------------------------
  // DEBOUNCED SAVE EFFECT
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    if (!activeDocument) return;
    // Guard against stale activeDocument after navigation: the store's activeDocument
    // may briefly reference the previous document during a project/document switch.
    if (activeDocument.id !== documentId) return;
    if (!hasUserEdit) return;
    if (pendingServerSnapshot) return; // Don't save if conflict pending

    // Clear existing timer
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    // Capture values for closure
    const saveDocumentId = activeDocument.id;
    const localDoc = localDocument;

    saveTimerRef.current = window.setTimeout(() => {
      // Capture editVersion at save-initiation time so resetEditVersion
      // only clears the flag if no new edits arrived during the network round-trip.
      const saveVersion = editVersionRef.current;

      // Use adapter to convert editor format -> storage format
      let storageContent: string;

      try {
        storageContent = contentDriver.toStorage(localDoc);
      } catch (err) {
        // Log error for debugging - this indicates a bug in our transaction logic
        log.error(
          "[useDocumentSync] BUG: Adapter conversion failed. Auto-repairing.",
          {
            error: err instanceof Error ? err.message : String(err),
            documentId: activeDocument.id,
          },
        );

        // Repair using shared hydration logic
        hydrateDocument({
          content: activeDocument.content ?? "",
        });

        return; // Don't continue with save
      }

      // Content-only save (no AI suggestions in non-collab path)
      documentSyncService.save(saveDocumentId, storageContent, activeDocument, {
        onServerSaved: (doc) => {
          const currentDocId = useEditorStore.getState()._activeDocumentId;
          if (currentDocId !== saveDocumentId) return;

          // A newer local edit landed while this request was in-flight.
          // Ignore this stale snapshot to avoid triggering false
          // pendingServerSnapshot conflicts in useDocumentContent.
          if (editVersionRef.current !== saveVersion) return;

          useEditorStore.getState().updateActiveDocument(doc);
          resetEditVersion(saveVersion);
          // Clear stashed server snapshot so future saves aren't blocked.
          // Without this, pendingServerSnapshot stays non-null forever
          // and the debounced save guard (`if (pendingServerSnapshot) return`)
          // prevents subsequent saves.
          setPendingServerSnapshot(null);
        },
      });
    }, 1000);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [
    documentId,
    activeDocument,
    localDocument,
    hasUserEdit,
    pendingServerSnapshot,
    setPendingServerSnapshot,
    hydrateDocument,
    resetEditVersion,
    editVersionRef,
    contentDriver,
    enabled,
  ]);

  // ---------------------------------------------------------------------------
  // FLUSH ON UNMOUNT / DOCUMENT CHANGE
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    // Return cleanup function that flushes pending changes.
    // Note: We intentionally read refs at cleanup time to get the LATEST values.
    // These refs point to our own data (not React DOM nodes), so they're stable.
    /* eslint-disable react-hooks/exhaustive-deps */
    return () => {
      if (initializedRef.current && hasUserEditRef.current) {
        const doc = activeDocumentRef.current;
        // Use documentId directly (the hook parameter) — activeDocumentRef may
        // point to a stale document if the user navigated away during cleanup.
        const docId = documentId;
        const editorContent =
          editorRef.current?.getContent() ?? localDocumentRef.current;

        // Content-only save (no AI suggestions in non-collab path)
        try {
          const storageContent = contentDriver.toStorage(editorContent);
          void documentSyncService.save(docId, storageContent, doc ?? undefined);
        } catch {
          // If adapter fails, save raw content as fallback
          void documentSyncService.save(docId, editorContent, doc ?? undefined);
        }
      }
    };
    /* eslint-enable react-hooks/exhaustive-deps */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, documentId/adapter trigger re-subscription
  }, [contentDriver, documentId, enabled]);
}
