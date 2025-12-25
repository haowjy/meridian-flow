import { useEffect, useRef, useState, useCallback } from 'react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { CodeMirrorEditor, EditorContextMenu, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useDebounce } from '@/core/hooks/useDebounce'
import { documentSyncService } from '@/core/services/documentSyncService'
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
import { useAIDiff } from '../hooks/useAIDiff'
import { AIToolbar } from './AIToolbar'
import { OriginalOverlay } from './OriginalOverlay'

interface EditorPanelProps {
  documentId: string
}

/**
 * CodeMirror 6 markdown editor panel.
 * Integrates: Document loading, auto-save.
 * Uses two-state pattern for instant typing + debounced auto-save.
 */
export function EditorPanel({ documentId }: EditorPanelProps) {
  const {
    activeDocument,
    _activeDocumentId,
    isLoading,
    error,
    status,
    lastSaved,
    loadDocument,
    saveDocument,
    aiEditorMode,
  } = useEditorStore()

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents)
  const documentMetadata = documents.find((doc) => doc.id === documentId)

  // Two-state pattern: local state for instant updates, debounced for saves
  const [localContent, setLocalContent] = useState('')
  const [hasUserEdit, setHasUserEdit] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const initializedRef = useRef(false)
  useEffect(() => {
    initializedRef.current = isInitialized
  }, [isInitialized])
  const debouncedContent = useDebounce(localContent, 1000) // 1 second trailing edge

  // CodeMirror editor ref
  const editorRef = useRef<CodeMirrorEditorRef | null>(null)

  // Refs for "flush on navigate/unmount" without stale closures
  const localContentRef = useRef(localContent)
  const hasUserEditRef = useRef(hasUserEdit)
  const activeDocumentRef = useRef(activeDocument)
  useEffect(() => {
    localContentRef.current = localContent
  }, [localContent])
  useEffect(() => {
    hasUserEditRef.current = hasUserEdit
  }, [hasUserEdit])
  useEffect(() => {
    activeDocumentRef.current = activeDocument
  }, [activeDocument])

  // Flag to track programmatic content changes (e.g., setContent during mode switch)
  // Prevents triggering hasUserEdit and auto-save for non-user changes
  const isProgrammaticChange = useRef(false)

  // AI diff computation - compute hunks between user content and AI suggestion
  // (hunks used by future floating pill for navigation)
  const aiVersion = activeDocument?.aiVersion
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _hunks = useAIDiff(localContent, aiVersion)

  // AI suggestions state (for custom diff solution - to be implemented)
  const hasAISuggestions = !!aiVersion
  const baseline = activeDocument?.content ?? ''

  // Handle content changes from the editor (unified for normal and merge modes)
  // In both modes, changes trigger debounced auto-save
  // In merge mode, this allows per-hunk accept/reject to persist
  const handleChange = useCallback((content: string) => {
    // Ignore changes before initialization
    if (!initializedRef.current) {
      return
    }
    // Ignore programmatic content changes (e.g., setContent during mode switch)
    // These shouldn't trigger hasUserEdit or auto-save
    if (isProgrammaticChange.current) {
      setLocalContent(content) // Still update local state for consistency
      return
    }
    setLocalContent(content)
    setHasUserEdit(true)
  }, [])

  // Handle editor ready
  const handleReady = useCallback((ref: CodeMirrorEditorRef) => {
    editorRef.current = ref
  }, [])

  // Load document on mount or when documentId changes
  useEffect(() => {
    // Prevent duplicate loads from React Strict Mode double-mounting
    // Skip if we're already loading this exact document
    if (_activeDocumentId === documentId && isLoading) {
      return
    }

    // Create AbortController for this load operation
    const abortController = new AbortController()

    // Reset local editor state on document change
    const resetEditorState = () => {
      setIsInitialized(false)
      initializedRef.current = false
      setHasUserEdit(false)
    }
    resetEditorState()

    loadDocument(documentId, abortController.signal)

    // Cleanup: abort request if component unmounts or documentId changes
    return () => {
      // Flush any unsaved edits when navigating away or switching documents.
      // We don't block navigation—this is best-effort and relies on the existing
      // optimistic IndexedDB update + retry-on-network-failure behavior.
      if (initializedRef.current && hasUserEditRef.current) {
        const doc = activeDocumentRef.current
        const docId = doc?.id ?? documentId
        const serverContent = doc?.content ?? ''
        const editorContent = editorRef.current?.getContent() ?? localContentRef.current

        // Treat empty string "" as valid content
        if (editorContent !== serverContent) {
          void documentSyncService.save(docId, editorContent, doc ?? undefined)
        }
      }
      abortController.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, loadDocument])

  // Initialize local content when document loads
  useEffect(() => {
    if (activeDocument && activeDocument.id === documentId) {
      const serverContent = activeDocument.content ?? ''
      setLocalContent(serverContent)
      setHasUserEdit(false)

      // Update editor content if ref is available and content differs
      // Skip if content is identical (e.g., after auto-save) to preserve cursor position
      if (editorRef.current) {
        const currentContent = editorRef.current.getContent()
        if (currentContent !== serverContent) {
          // Mark as programmatic to prevent triggering auto-save
          isProgrammaticChange.current = true
          editorRef.current.setContent(serverContent)
          setTimeout(() => {
            isProgrammaticChange.current = false
          }, 0)
        }
      }

      setIsInitialized(true)
    }
  }, [activeDocument, documentId])

  // TODO: Custom diff solution - mode switching and auto-clear will be implemented here

  // Auto-save when debounced content changes (only in edit mode AFTER init)
  // Treat empty string "" as valid content (do not use falsy checks)
  // Note: ai_version is auto-cleared when all chunks resolved (effect above)
  // or manually via Accept All / Reject All buttons
  useEffect(() => {
    // Only save if debounce has "settled" (caught up to localContent)
    // This prevents saving stale debounced values during initialization
    if (debouncedContent !== localContent) return

    if (isInitialized && hasUserEdit && debouncedContent !== activeDocument?.content) {
      // Save the document content
      saveDocument(documentId, debouncedContent)
    }
  }, [isInitialized, hasUserEdit, debouncedContent, localContent, documentId, activeDocument?.content, saveDocument])

  // Determine the best available source for header metadata
  const headerDocument =
    documentMetadata || (activeDocument?.id === documentId ? activeDocument : null)

  const handleBackClick = () => {
    // Only swap the right panel back to the tree view without changing URL.
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  // Get word count from editor ref (updates on re-render)
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

  // No inline rename handler here; breadcrumb rename to be added later.

  // Error state - keep workspace header so user can navigate away
  // Note: onRetry doesn't pass signal, which is fine for manual retries
  // The AbortController in the useEffect will handle cleanup if user navigates away
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

  // If we don't yet have header metadata or the active document, show a lightweight skeleton
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

  // Show header and title immediately (metadata available from tree)
  // Show skeleton only for editor content while loading
  // Editor is ready when we have activeDocument for this documentId
  const isContentLoading = activeDocument?.id !== documentId || !isInitialized

  // Determine editable state: editable once initialized
  const isEditable = isInitialized && activeDocument?.id === documentId && !isLoading

  return (
    <div className="flex h-full flex-col">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Sticky Header + AI Toolbar */}
        <div className="sticky top-0 z-20 bg-background relative">
          {header}
          {hasAISuggestions && <AIToolbar />}
          <HeaderGradientFade />
        </div>

        {/* Content area - shows skeleton while loading */}
        <div className="relative flex-1">
          {/* Original mode overlay - shows read-only baseline content */}
          {/* Keeps main editor mounted underneath to preserve state */}
          {aiEditorMode === 'original' && hasAISuggestions && (
            <OriginalOverlay content={baseline} />
          )}

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
                  initialContent={localContent}
                  editable={isEditable}
                  placeholder="Start writing..."
                  onChange={handleChange}
                  onReady={handleReady}
                  className="min-h-full"
                />
              </div>
            </EditorContextMenu>
          )}
        </div>
      </div>
    </div>
  )
}
