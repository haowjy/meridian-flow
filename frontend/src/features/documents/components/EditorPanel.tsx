/**
 * EditorPanel - CodeMirror 6 markdown editor with AI diff view support.
 *
 * Key architecture:
 * - Merged document is source of truth (content + aiVersion combined with PUA markers)
 * - Accept/reject are CM6 transactions (undoable via Cmd+Z)
 * - Compartment-based diff extension for dynamic enable/disable
 * - Debounced save parses merged doc back to content + aiVersion
 *
 * Hook composition:
 * - useDocumentContent: Loading, hydration, local state
 * - useDocumentSync: Debounced save, flush on unmount
 * - useDiffView: Diff extension, hunk navigation
 *
 * @see `_docs/plans/ai-editing/inline-suggestions-impl-2/06-integration.md`
 */

import { useRef } from 'react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { CodeMirrorEditor, EditorContextMenu, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { useEditorStore } from '@/core/stores/useEditorStore'
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
import { useDocumentContent, useDocumentSync, useDiffView } from '../hooks'

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
  // REFS
  // ---------------------------------------------------------------------------
  const editorRef = useRef<CodeMirrorEditorRef | null>(null)

  // ---------------------------------------------------------------------------
  // STORE STATE (for UI that's not in hooks)
  // ---------------------------------------------------------------------------
  const { error, status, lastSaved, loadDocument, focusedHunkIndex } = useEditorStore()
  const activeDocument = useEditorStore((s) => s.activeDocument)

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents)
  const documentMetadata = documents.find((doc) => doc.id === documentId)

  // ---------------------------------------------------------------------------
  // HOOKS (composed)
  // ---------------------------------------------------------------------------

  // 1. Document content (loading, hydration, local state)
  const {
    localDocument,
    isInitialized,
    isEditable,
    isEditorReady,
    hasUserEdit,
    setHasUserEdit,
    handleEditorReady,
    handleContentChange,
    hydrateDocument,
    syncContext,
  } = useDocumentContent(documentId, editorRef)

  // 2. Document sync (save, flush) - pure effect, no return
  useDocumentSync(documentId, syncContext, localDocument, hasUserEdit, editorRef, hydrateDocument)

  // 3. Diff view (markers, navigation)
  const {
    hunks,
    hasAISuggestions,
    initialExtensions,
    handlePrevHunk,
    handleNextHunk,
    handleAcceptAll,
    handleRejectAll,
  } = useDiffView({
    localDocument,
    editorRef,
    isEditorReady,
    setHasUserEdit,
  })

  // ---------------------------------------------------------------------------
  // CALLBACKS
  // ---------------------------------------------------------------------------

  // Handle back button click
  const handleBackClick = () => {
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------

  // Determine the best available source for header metadata
  const headerDocument =
    documentMetadata || (activeDocument?.id === documentId ? activeDocument : null)

  // Get word count from editor ref
  // Note: This ref access during render is intentional - wordCount is a display-only value
  // that updates on re-render. The ref is stable and always points to our editor instance.
  // eslint-disable-next-line react-hooks/refs
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
            // eslint-disable-next-line react-hooks/refs -- editorRef is stable, passed for context menu operations
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
