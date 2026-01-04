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

import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { documentSyncService } from '@/core/services/documentSyncService'
import { saveMergedDocument } from '@/core/services/saveMergedDocument'
import {
  hasAnyMarker,
  parseMergedDocument,
  DiffMarkersCorruptedError,
} from '@/core/lib/mergedDocument'
import type { DocumentSyncContext } from './useDocumentContent'
import type { CodeMirrorEditorRef } from '@/core/editor/codemirror'

// =============================================================================
// TYPES
// =============================================================================

interface HydrationInput {
  content: string
  aiVersion: string | null | undefined
  aiVersionRev: number | null | undefined
}

// =============================================================================
// HOOK
// =============================================================================

export function useDocumentSync(
  documentId: string,
  syncContext: DocumentSyncContext,
  localDocument: string,
  hasUserEdit: boolean,
  editorRef: React.MutableRefObject<CodeMirrorEditorRef | null>,
  hydrateDocument: (doc: HydrationInput) => void
): void {
  const {
    aiVersionBaseRevRef,
    serverHasAIVersionRef,
    pendingServerSnapshot,
    setPendingServerSnapshot,
    localDocumentRef,
    hasUserEditRef,
    initializedRef,
    activeDocumentRef,
  } = syncContext

  // Get activeDocument from store for save logic
  const activeDocument = useEditorStore((s) => s.activeDocument)

  // Save timer ref
  const saveTimerRef = useRef<number | null>(null)

  // ---------------------------------------------------------------------------
  // DEBOUNCED SAVE EFFECT
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!activeDocument) return
    if (!hasUserEdit) return
    if (pendingServerSnapshot) return // Don't save if conflict pending

    // Clear existing timer
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }

    // Capture values for closure
    const saveDocumentId = activeDocument.id
    const localDoc = localDocument

    saveTimerRef.current = window.setTimeout(() => {
      const baseRev = aiVersionBaseRevRef.current

      // Validate marker structure before saving
      try {
        void parseMergedDocument(localDoc)
      } catch (err) {
        if (err instanceof DiffMarkersCorruptedError) {
          // Log error for debugging - this indicates a bug in our transaction logic
          console.error('[useDocumentSync] BUG: Marker structure corrupted. Auto-repairing.', {
            error: err.message,
            documentId: activeDocument.id,
          })

          // Repair using shared hydration logic
          hydrateDocument({
            content: activeDocument.content ?? '',
            aiVersion: activeDocument.aiVersion,
            aiVersionRev: activeDocument.aiVersionRev,
          })

          return // Don't continue with save
        }
        throw err
      }

      // Decide save type
      const hasMarkers = hasAnyMarker(localDoc)
      const serverHasAIVersion =
        activeDocument.aiVersion !== null && activeDocument.aiVersion !== undefined

      if (!hasMarkers && !serverHasAIVersion) {
        // Content-only save (no AI markers, server has no aiVersion)
        documentSyncService.save(saveDocumentId, localDoc, activeDocument, {
          onServerSaved: (doc) => {
            const currentDocId = useEditorStore.getState()._activeDocumentId
            if (currentDocId !== saveDocumentId) return
            useEditorStore.getState().updateActiveDocument(doc)
            // Note: hasUserEdit is reset by the component/content hook
          },
        })
        return
      }

      // Need to save with ai_version handling
      if (baseRev === null) {
        // No base rev known - require refresh
        setPendingServerSnapshot({
          content: activeDocument.content ?? '',
          aiVersion: activeDocument.aiVersion,
          aiVersionRev: activeDocument.aiVersionRev,
        })
        return
      }

      // Merged save with CAS
      documentSyncService.saveMerged(
        saveDocumentId,
        localDoc,
        {
          aiVersionBaseRev: baseRev,
          serverHasAIVersion,
        },
        {
          onServerSaved: (result) => {
            const currentDocId = useEditorStore.getState()._activeDocumentId
            if (currentDocId !== saveDocumentId) return

            useEditorStore.getState().updateActiveDocument(result.document)
            aiVersionBaseRevRef.current = result.document.aiVersionRev ?? null
            // Note: hasUserEdit is reset by the component/content hook
          },
          onAIVersionConflict: (serverDocument) => {
            const latest = serverDocument ?? useEditorStore.getState().activeDocument
            if (!latest) return

            setPendingServerSnapshot({
              content: latest.content ?? '',
              aiVersion: latest.aiVersion,
              aiVersionRev: latest.aiVersionRev,
            })
          },
        }
      )
    }, 1000)

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [
    activeDocument,
    localDocument,
    hasUserEdit,
    pendingServerSnapshot,
    hydrateDocument,
    aiVersionBaseRevRef,
    setPendingServerSnapshot,
  ])

  // ---------------------------------------------------------------------------
  // FLUSH ON UNMOUNT / DOCUMENT CHANGE
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Return cleanup function that flushes pending changes.
    // Note: We intentionally read refs at cleanup time to get the LATEST values.
    // These refs point to our own data (not React DOM nodes), so they're stable.
    /* eslint-disable react-hooks/exhaustive-deps */
    return () => {
      if (initializedRef.current && hasUserEditRef.current) {
        const doc = activeDocumentRef.current
        const docId = doc?.id ?? documentId
        const editorContent = editorRef.current?.getContent() ?? localDocumentRef.current

        // For merged documents, use saveMergedDocument to preserve aiVersion
        // This fixes the bug where quick navigation after accept/reject would lose AI state
        if (hasAnyMarker(editorContent)) {
          const baseRev = aiVersionBaseRevRef.current
          if (baseRev != null) {
            // Best-effort save - don't block navigation
            void saveMergedDocument(docId, editorContent, {
              aiVersionBaseRev: baseRev,
              serverHasAIVersion: serverHasAIVersionRef.current,
            }).catch(() => {
              // On error (corrupted markers, etc), fallback to content-only save
              void documentSyncService.save(docId, editorContent, doc ?? undefined)
            })
          } else {
            // No CAS token - can't save aiVersion, fall back to content-only
            void documentSyncService.save(docId, editorContent, doc ?? undefined)
          }
        } else {
          void documentSyncService.save(docId, editorContent, doc ?? undefined)
        }
      }
    }
    /* eslint-enable react-hooks/exhaustive-deps */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, documentId triggers re-subscription
  }, [documentId])
}
