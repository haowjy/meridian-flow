/**
 * useDocumentSync - Debounced save, CAS token management, flush on unmount.
 *
 * This is a pure effect hook (returns nothing) that handles:
 * - Debounced save (1s after user stops typing)
 * - CAS token handling for AI version updates
 * - Flush on unmount (save pending changes when navigating away)
 * - Corruption repair (rehydrate if markers are corrupted)
 *
 * Designed for composition with useDocumentContent.
 * Receives syncContext from useDocumentContent for state coordination.
 */

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/core/stores/useEditorStore";
import { documentSyncService } from "@/core/services/documentSyncService";
import { saveMergedDocument } from "@/core/services/saveMergedDocument";
import { getAdapter } from "@/core/editor/adapters";
import { detectEditorType } from "@/core/editor/types/editorRegistry";
import type { DocumentSyncContext } from "./useDocumentContent";
import type { BaseEditorRef } from "@/core/editor/types/editorRegistry";

// =============================================================================
// TYPES
// =============================================================================

interface HydrationInput {
  content: string;
  aiVersion: string | null | undefined;
  aiVersionRev: number | null | undefined;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Document sync hook - Adapter-based multi-editor support.
 *
 * @template TEditor - Editor content type (inferred from extension)
 * @param documentId - Document ID to sync
 * @param extension - File extension (used to determine adapter)
 * @param syncContext - Sync context from useDocumentContent
 * @param localDocument - Local editor content
 * @param hasUserEdit - Whether user has made edits
 * @param editorRef - Editor reference for programmatic access
 * @param hydrateDocument - Hydration function for corruption repair
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDocumentSync<TEditor = any>(
  documentId: string,
  extension: string,
  syncContext: DocumentSyncContext<TEditor>,
  localDocument: TEditor,
  hasUserEdit: boolean,
  editorRef: React.MutableRefObject<BaseEditorRef<TEditor> | null>,
  hydrateDocument: (doc: HydrationInput) => void,
  enabled = true,
): void {
  // Detect editor type and get adapter
  const editorType = detectEditorType(extension);
  const adapter = getAdapter(editorType);
  const {
    aiVersionBaseRevRef,
    serverHasAIVersionRef,
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
      const baseRev = aiVersionBaseRevRef.current;

      // Use adapter to convert editor format → storage format
      let storageContent: string;

      try {
        // Type assertion safe: all current text-based adapters expect string
        const storageData = adapter.toStorage(localDoc as string);
        storageContent = storageData.content as string;
      } catch (err) {
        // Log error for debugging - this indicates a bug in our transaction logic
        console.error(
          "[useDocumentSync] BUG: Adapter conversion failed. Auto-repairing.",
          {
            error: err instanceof Error ? err.message : String(err),
            documentId: activeDocument.id,
          },
        );

        // Repair using shared hydration logic
        hydrateDocument({
          content: activeDocument.content ?? "",
          aiVersion: activeDocument.aiVersion,
          aiVersionRev: activeDocument.aiVersionRev,
        });

        return; // Don't continue with save
      }

      // Decide save type
      // Type assertion safe: all current text-based adapters expect string
      const hasAISuggestions = adapter.hasAISuggestions(localDoc as string);
      const serverHasAIVersion =
        activeDocument.aiVersion !== null &&
        activeDocument.aiVersion !== undefined;

      if (!hasAISuggestions && !serverHasAIVersion) {
        // Content-only save (no AI suggestions, server has no aiVersion)
        documentSyncService.save(
          saveDocumentId,
          storageContent,
          activeDocument,
          {
            onServerSaved: (doc) => {
              const currentDocId = useEditorStore.getState()._activeDocumentId;
              if (currentDocId !== saveDocumentId) return;

              // A newer local edit landed while this request was in-flight.
              // Ignore this stale snapshot to avoid triggering false
              // pendingServerSnapshot conflicts in useDocumentContent.
              if (editVersionRef.current !== saveVersion) return;

              useEditorStore.getState().updateActiveDocument(doc);
              resetEditVersion(saveVersion);
            },
          },
        );
        return;
      }

      // Need to save with ai_version handling
      if (baseRev === null) {
        // No base rev known - require refresh
        setPendingServerSnapshot({
          content: activeDocument.content ?? "",
          aiVersion: activeDocument.aiVersion,
          aiVersionRev: activeDocument.aiVersionRev,
        });
        return;
      }

      // Merged save with CAS
      documentSyncService.saveMerged(
        saveDocumentId,
        localDoc as string, // saveMergedDocument expects merged string (PUA markers)
        {
          aiVersionBaseRev: baseRev,
          serverHasAIVersion,
        },
        {
          onServerSaved: (result) => {
            const currentDocId = useEditorStore.getState()._activeDocumentId;
            if (currentDocId !== saveDocumentId) return;

            // If newer local edits exist, treat this as a stale ack: update CAS refs
            // for future saves, but don't publish the server snapshot into activeDocument.
            if (editVersionRef.current !== saveVersion) {
              aiVersionBaseRevRef.current = result.document.aiVersionRev ?? null;
              serverHasAIVersionRef.current = result.document.aiVersion != null;
              return;
            }

            useEditorStore.getState().updateActiveDocument(result.document);
            aiVersionBaseRevRef.current = result.document.aiVersionRev ?? null;
            resetEditVersion(saveVersion);
          },
          onAIVersionConflict: (serverDocument) => {
            const latest =
              serverDocument ?? useEditorStore.getState().activeDocument;
            if (!latest) return;

            setPendingServerSnapshot({
              content: latest.content ?? "",
              aiVersion: latest.aiVersion,
              aiVersionRev: latest.aiVersionRev,
            });
          },
        },
      );
    }, 1000);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [
    activeDocument,
    localDocument,
    hasUserEdit,
    pendingServerSnapshot,
    hydrateDocument,
    aiVersionBaseRevRef,
    setPendingServerSnapshot,
    resetEditVersion,
    editVersionRef,
    serverHasAIVersionRef,
    adapter,
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
        const docId = doc?.id ?? documentId;
        const editorContent =
          editorRef.current?.getContent() ?? localDocumentRef.current;

        // Check if editor content has AI suggestions using adapter
        // Type assertion safe: all current text-based adapters expect string
        const hasAISuggestions = adapter.hasAISuggestions(
          editorContent as string,
        );

        // For documents with AI suggestions, use saveMergedDocument to preserve aiVersion
        // This fixes the bug where quick navigation after accept/reject would lose AI state
        if (hasAISuggestions) {
          const baseRev = aiVersionBaseRevRef.current;
          if (baseRev != null) {
            // Best-effort save - don't block navigation
            void saveMergedDocument(docId, editorContent as string, {
              aiVersionBaseRev: baseRev,
              serverHasAIVersion: serverHasAIVersionRef.current,
            }).catch(() => {
              // On error (corrupted markers, etc), fallback to content-only save
              // Use adapter to convert editor → storage format
              // Type assertion safe: all current text-based adapters expect string
              try {
                const storageData = adapter.toStorage(editorContent as string);
                void documentSyncService.save(
                  docId,
                  storageData.content as string,
                  doc ?? undefined,
                );
              } catch {
                // If adapter fails, save raw content as fallback
                void documentSyncService.save(
                  docId,
                  editorContent as string,
                  doc ?? undefined,
                );
              }
            });
          } else {
            // No CAS token - can't save aiVersion, fall back to content-only
            // Type assertion safe: all current text-based adapters expect string
            try {
              const storageData = adapter.toStorage(editorContent as string);
              void documentSyncService.save(
                docId,
                storageData.content as string,
                doc ?? undefined,
              );
            } catch {
              void documentSyncService.save(
                docId,
                editorContent as string,
                doc ?? undefined,
              );
            }
          }
        } else {
          // No AI suggestions - simple content-only save
          // Type assertion safe: all current text-based adapters expect string
          try {
            const storageData = adapter.toStorage(editorContent as string);
            void documentSyncService.save(
              docId,
              storageData.content as string,
              doc ?? undefined,
            );
          } catch {
            void documentSyncService.save(
              docId,
              editorContent as string,
              doc ?? undefined,
            );
          }
        }
      }
    };
    /* eslint-enable react-hooks/exhaustive-deps */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, documentId/adapter trigger re-subscription
  }, [documentId, adapter, enabled]);
}
