/**
 * EditorPanel - CodeMirror 6 markdown editor with AI diff view support.
 *
 * Key architecture:
 * - Merged document is source of truth (content + aiVersion combined with PUA markers)
 * - Accept/reject are CM6 transactions (undoable via Cmd+Z)
 * - Compartment-based diff extension for dynamic enable/disable
 * - Debounced save parses merged doc back to content + aiVersion
 *
 * @see `_docs/plans/ai-editing/inline-suggestions-impl-2/06-integration.md`
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { CodeMirrorEditor, EditorContextMenu, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useLatestRef } from '@/core/hooks'
import { documentSyncService } from '@/core/services/documentSyncService'
import { saveMergedDocument } from '@/core/services/saveMergedDocument'
import { EditorHeader } from './EditorHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { CompactBreadcrumb } from '@/shared/components/ui/CompactBreadcrumb'
import { Button } from '@/shared/components/ui/button'
import { ChevronLeft } from 'lucide-react'
import { AIHunkNavigator } from './AIHunkNavigator'
import {
  buildMergedDocument,
  extractHunks,
  hasAnyMarker,
  parseMergedDocument,
  DiffMarkersCorruptedError,
} from '@/core/lib/mergedDocument'
import {
  createDiffViewExtension,
  acceptAll,
  rejectAll,
  setFocusedHunkIndexEffect,
} from '@/core/editor/codemirror/diffView'

// =============================================================================
// TYPES
// =============================================================================

interface EditorPanelProps {
  documentId: string
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * CodeMirror 6 markdown editor panel with AI diff view support.
 *
 * Uses merged document pattern:
 * - On load: buildMergedDocument(content, aiVersion) → editor
 * - During editing: editor shows merged document with diff decorations
 * - On save: parseMergedDocument() → API (content + aiVersion)
 */
export function EditorPanel({ documentId }: EditorPanelProps) {
  // ---------------------------------------------------------------------------
  // STORE STATE
  // ---------------------------------------------------------------------------
  const {
    activeDocument,
    _activeDocumentId,
    isLoading,
    error,
    status,
    lastSaved,
    loadDocument,
    focusedHunkIndex,
    setFocusedHunkIndex,
    navigateHunk,
  } = useEditorStore()

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents)
  const documentMetadata = documents.find((doc) => doc.id === documentId)

  // ---------------------------------------------------------------------------
  // LOCAL STATE
  // ---------------------------------------------------------------------------

  // Single merged document (source of truth)
  const [localDocument, setLocalDocument] = useState('')
  const [hasUserEdit, setHasUserEdit] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

  // CAS token for ai_version updates
  const lastHydratedDocIdRef = useRef<string | null>(null)
  const aiVersionBaseRevRef = useRef<number | null>(null)
  // Track if server had an AI version (for flush-on-unmount)
  const serverHasAIVersionRef = useRef(false)

  /**
   * Pending server snapshot - stashed when server update arrives while user has edits.
   *
   * State machine:
   * - null: No pending update (normal state)
   * - {content, aiVersion, aiVersionRev}: Server update waiting to be applied
   *
   * Transitions:
   * - Server update arrives + hasUserEdit=true → store snapshot, don't apply
   * - User saves document → clear pendingServerSnapshot after save succeeds
   * - User switches to different document → flush changes, clear snapshot
   *
   * TODO: Add UI for conflict resolution (show diff, let user choose).
   * Currently, pending snapshots are silently overwritten when user saves.
   */
  const [pendingServerSnapshot, setPendingServerSnapshot] = useState<{
    content: string
    aiVersion: string | null | undefined
    aiVersionRev: number | null | undefined
  } | null>(null)

  // CodeMirror editor ref
  const editorRef = useRef<CodeMirrorEditorRef | null>(null)

  // Editor ready state (for compartment effects)
  const [isEditorReady, setIsEditorReady] = useState(false)

  // Compartment for diff view extension
  const diffCompartmentRef = useRef<Compartment | null>(null)
  if (!diffCompartmentRef.current) {
    diffCompartmentRef.current = new Compartment()
  }
  const diffCompartment = diffCompartmentRef.current
  const diffEnabledRef = useRef(false)

  // Refs for "flush on navigate/unmount" without stale closures
  const initializedRef = useLatestRef(isInitialized)
  const localDocumentRef = useLatestRef(localDocument)
  const hasUserEditRef = useLatestRef(hasUserEdit)
  const activeDocumentRef = useLatestRef(activeDocument)

  // Save timer ref
  const saveTimerRef = useRef<number | null>(null)

  // ---------------------------------------------------------------------------
  // DERIVED STATE
  // ---------------------------------------------------------------------------

  // Computed hunks from current document
  const hunks = useMemo(() => extractHunks(localDocument), [localDocument])

  // Diff mode active = markers exist (NOT based on aiVersion from server)
  const hasAISuggestions = hasAnyMarker(localDocument)

  // Determine editable state early (needed by sync effect below)
  const isEditable = isInitialized && activeDocument?.id === documentId && !isLoading

  // Initial extension array (empty diff compartment)
  const initialExtensions = useMemo(() => [diffCompartment.of([])], [diffCompartment])

  // ---------------------------------------------------------------------------
  // CALLBACKS
  // ---------------------------------------------------------------------------

  // Handle content changes from the editor
  const handleContentChange = useCallback(
    (content: string) => {
      // Ignore changes before initialization
      if (!initializedRef.current) {
        return
      }
      setLocalDocument(content)
      setHasUserEdit(true)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initializedRef is stable
    []
  )

  // Handle editor ready
  const handleEditorReady = useCallback((ref: CodeMirrorEditorRef) => {
    editorRef.current = ref
    setIsEditorReady(true)

    // Enable diff view if needed (initial load with aiVersion)
    const view = ref.getView()
    if (!view) return

    // Check if we should enable diff mode based on current localDocument
    // This handles the case where document is loaded before editor is ready
    const shouldEnable = hasAnyMarker(localDocumentRef.current)
    if (shouldEnable && !diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure(createDiffViewExtension()),
      })
      diffEnabledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffCompartment])

  // Navigation callbacks
  const handlePrevHunk = useCallback(() => {
    navigateHunk('prev', hunks.length)
  }, [navigateHunk, hunks.length])

  const handleNextHunk = useCallback(() => {
    navigateHunk('next', hunks.length)
  }, [navigateHunk, hunks.length])

  // Bulk operations (via CM6 transactions)
  const handleAcceptAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    acceptAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [setFocusedHunkIndex])

  const handleRejectAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    rejectAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [setFocusedHunkIndex])

  /**
   * Hydrate editor with document data from server.
   * Used by both initialization and corruption repair.
   * SRP: Single function for all hydration logic.
   */
  const hydrateDocument = useCallback(
    (doc: {
      content: string
      aiVersion: string | null | undefined
      aiVersionRev: number | null | undefined
    }) => {
      const content = doc.content
      const aiVersion = doc.aiVersion
      const merged = aiVersion ? buildMergedDocument(content, aiVersion) : content

      setLocalDocument(merged)
      aiVersionBaseRevRef.current = doc.aiVersionRev ?? null
      serverHasAIVersionRef.current = aiVersion != null
      setHasUserEdit(false)

      if (editorRef.current) {
        editorRef.current.setContent(merged, { addToHistory: false, emitChange: false })
      }
    },
    []
  )

  // Handle back button click
  const handleBackClick = () => {
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  // ---------------------------------------------------------------------------
  // EFFECTS
  // ---------------------------------------------------------------------------

  // Load document on mount or when documentId changes
  useEffect(() => {
    // Prevent duplicate loads from React Strict Mode double-mounting
    if (_activeDocumentId === documentId && isLoading) {
      return
    }

    // Create AbortController for this load operation
    const abortController = new AbortController()

    // Reset local editor state on document change
    setIsInitialized(false)
    setHasUserEdit(false)
    setPendingServerSnapshot(null)

    loadDocument(documentId, abortController.signal)

    // Cleanup: abort request if component unmounts or documentId changes
    // Flush any unsaved edits when navigating away
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
      abortController.abort()
    }
    /* eslint-enable react-hooks/exhaustive-deps */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, loadDocument])

  // Initialize local document when activeDocument loads
  useEffect(() => {
    if (!activeDocument) return
    if (activeDocument.id !== documentId) return

    const docChanged = lastHydratedDocIdRef.current !== activeDocument.id

    // If not a new doc and we have user edits, stash incoming update
    if (!docChanged && hasUserEdit) {
      setPendingServerSnapshot({
        content: activeDocument.content ?? '',
        aiVersion: activeDocument.aiVersion,
        aiVersionRev: activeDocument.aiVersionRev,
      })
      return
    }

    // If we already have a pending snapshot and this isn't a new doc, skip
    if (!docChanged && pendingServerSnapshot) {
      return
    }

    // Initialize the document
    lastHydratedDocIdRef.current = activeDocument.id
    setPendingServerSnapshot(null)

    hydrateDocument({
      content: activeDocument.content ?? '',
      aiVersion: activeDocument.aiVersion,
      aiVersionRev: activeDocument.aiVersionRev,
    })

    setIsInitialized(true)
  }, [activeDocument, documentId, hasUserEdit, hydrateDocument, pendingServerSnapshot])

  // Enable/disable diff extension when hasAISuggestions changes
  useEffect(() => {
    if (!isEditorReady) return
    const view = editorRef.current?.getView()
    if (!view) return

    const shouldEnable = hasAISuggestions

    if (shouldEnable && !diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure(createDiffViewExtension()),
      })
      diffEnabledRef.current = true
    } else if (!shouldEnable && diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure([]),
      })
      diffEnabledRef.current = false
    }
  }, [isEditorReady, hasAISuggestions, diffCompartment])

  // Sync focused hunk index to CM6 for decoration highlighting.
  // This SHOULD run on hunks change (decorations need current hunk positions).
  useEffect(() => {
    if (!isEditorReady || hunks.length === 0) return
    const view = editorRef.current?.getView()
    if (!view) return

    view.dispatch({
      effects: setFocusedHunkIndexEffect.of(focusedHunkIndex),
    })
  }, [focusedHunkIndex, hunks, isEditorReady])

  // Navigate cursor to focused hunk (only on index change, not on typing).
  // Intentionally omits hunks from deps to prevent cursor jump on every keystroke.
  useEffect(() => {
    if (!isEditorReady) return
    const view = editorRef.current?.getView()
    if (!view) return

    const hunk = hunks[focusedHunkIndex]
    if (hunk) {
      view.dispatch({
        selection: { anchor: hunk.from },
        effects: EditorView.scrollIntoView(hunk.from, { y: 'center' }),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit hunks to prevent cursor jump on typing
  }, [focusedHunkIndex, isEditorReady])

  // Clamp focusedHunkIndex when hunks are removed
  useEffect(() => {
    if (hunks.length === 0) {
      if (focusedHunkIndex !== 0) {
        setFocusedHunkIndex(0)
      }
    } else if (focusedHunkIndex >= hunks.length) {
      setFocusedHunkIndex(hunks.length - 1)
    }
  }, [hunks.length, focusedHunkIndex, setFocusedHunkIndex])

  // Debounced save effect
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

    saveTimerRef.current = window.setTimeout(() => {
      const baseRev = aiVersionBaseRevRef.current

      // Validate marker structure before saving
      try {
        void parseMergedDocument(localDocument)
      } catch (err) {
        if (err instanceof DiffMarkersCorruptedError) {
          // Log error for debugging - this indicates a bug in our transaction logic
          console.error('[EditorPanel] BUG: Marker structure corrupted. Auto-repairing.', {
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
      const hasMarkers = hasAnyMarker(localDocument)
      const serverHasAIVersion =
        activeDocument.aiVersion !== null && activeDocument.aiVersion !== undefined

      if (!hasMarkers && !serverHasAIVersion) {
        // Content-only save (no AI markers, server has no aiVersion)
        documentSyncService.save(saveDocumentId, localDocument, activeDocument, {
          onServerSaved: (doc) => {
            const currentDocId = useEditorStore.getState()._activeDocumentId
            if (currentDocId !== saveDocumentId) return
            useEditorStore.getState().updateActiveDocument(doc)
            setHasUserEdit(false)
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
        localDocument,
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
            setHasUserEdit(false)
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
  }, [activeDocument, hasUserEdit, hydrateDocument, localDocument, pendingServerSnapshot])

  // Sync editable state to editor when it changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.setEditable(isEditable)
    }
  }, [isEditable])

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  // Determine the best available source for header metadata
  const headerDocument =
    documentMetadata || (activeDocument?.id === documentId ? activeDocument : null)

  // Get word count from editor ref
  const wordCount = editorRef.current?.getWordCount().words ?? 0

  const header = headerDocument ? (
    <EditorHeader
      document={headerDocument}
      wordCount={wordCount}
      status={status}
      lastSaved={lastSaved}
    />
  ) : (
    <DocumentHeaderBar
      leading={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 -ml-1"
          onClick={handleBackClick}
          aria-label="Back to documents"
        >
          <ChevronLeft className="size-3" />
        </Button>
      }
      title={<CompactBreadcrumb segments={[{ label: 'Document' }]} />}
      ariaLabel="Document header"
      showDivider={false}
      trailing={<SidebarToggle side="right" />}
    />
  )

  // ---------------------------------------------------------------------------
  // ERROR STATE
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex-1 p-8 flex items-center justify-center">
          <ErrorPanel
            title="Failed to load document"
            message={error}
            onRetry={() => loadDocument(documentId)}
          />
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // LOADING STATE
  // ---------------------------------------------------------------------------

  if (!headerDocument) {
    return (
      <div className="flex h-full flex-col">
        <div className="px-3 py-2">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="flex-1 p-8 space-y-4">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
        </div>
      </div>
    )
  }

  const isContentLoading = activeDocument?.id !== documentId || !isInitialized

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background relative">
          {header}
          <HeaderGradientFade />
        </div>

        {/* Content area */}
        <div className="relative flex-1">
          {isContentLoading ? (
            <div className="p-8 space-y-4">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-5/6" />
            </div>
          ) : (
            <EditorContextMenu editorRef={editorRef.current}>
              <div className={`relative pt-1 flex-1 ${hasAISuggestions ? 'ai-editor-container' : ''}`}>
                <CodeMirrorEditor
                  key={documentId}
                  initialContent={localDocument}
                  editable={isEditable}
                  placeholder="Start writing..."
                  onChange={handleContentChange}
                  onReady={handleEditorReady}
                  extensions={initialExtensions}
                  className="min-h-full"
                />
                {/* Floating navigator pill - positioned relative to this container */}
                {hasAISuggestions && hunks.length > 0 && (
                  <AIHunkNavigator
                    hunks={hunks}
                    currentIndex={focusedHunkIndex}
                    onPrevious={handlePrevHunk}
                    onNext={handleNextHunk}
                    onAcceptAll={handleAcceptAll}
                    onRejectAll={handleRejectAll}
                  />
                )}
              </div>
            </EditorContextMenu>
          )}
        </div>
      </div>
    </div>
  )
}
