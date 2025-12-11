import { useEffect, useRef, useState, useCallback } from 'react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { CodeMirrorEditor, EditorContextMenu, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useDebounce } from '@/core/hooks/useDebounce'
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
import { api } from '@/core/lib/api'
import { useAIDiff, applyAccept, applyReject, type DiffHunk } from '../hooks/useAIDiff'
import { AIToolbar } from './AIToolbar'
import { handleApiError } from '@/core/lib/errors'

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
  } = useEditorStore()

  // Get document metadata from tree (available immediately, no need to wait for content)
  const documents = useTreeStore((state) => state.documents)
  const documentMetadata = documents.find((doc) => doc.id === documentId)

  // AI suggestion state
  const [aiActionLoading, setAiActionLoading] = useState(false)

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

  // AI diff computation - compute hunks between user content and AI suggestion
  const aiVersion = activeDocument?.aiVersion
  const hunks = useAIDiff(localContent, aiVersion)

  // AI suggestion handlers for individual hunks (used by future inline per-hunk buttons)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleAccept = useCallback(async (hunk: DiffHunk) => {
    if (!editorRef.current || !aiVersion) return
    setAiActionLoading(true)
    try {
      // Apply AI change to content (replace userText with aiText)
      const newContent = applyAccept(localContent, hunk)
      editorRef.current.setContent(newContent)
      setLocalContent(newContent)
      setHasUserEdit(true) // Trigger auto-save
    } finally {
      setAiActionLoading(false)
    }
  }, [localContent, aiVersion])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleReject = useCallback(async (hunk: DiffHunk) => {
    if (!aiVersion) return
    setAiActionLoading(true)
    try {
      // Revert AI change in ai_version (replace aiText with userText)
      const newAIVersion = applyReject(aiVersion, hunk)
      const updatedDoc = await api.documents.patchAIVersion(documentId, newAIVersion)
      useEditorStore.getState().updateActiveDocument(updatedDoc)
    } catch (error) {
      handleApiError(error, 'Failed to update AI suggestion')
    } finally {
      setAiActionLoading(false)
    }
  }, [documentId, aiVersion])

  const handleAcceptAll = useCallback(async () => {
    if (!editorRef.current || !aiVersion) return
    setAiActionLoading(true)
    try {
      // 1. Set editor to merged content (UI updates immediately)
      editorRef.current.setContent(aiVersion)
      setLocalContent(aiVersion)

      // 2. Save merged content to server FIRST (direct API call)
      // This ensures server has the new content before we clear ai_version
      await api.documents.update(documentId, aiVersion)

      // 3. Then clear AI version - server now has correct content
      // so the returned doc won't trigger a revert in the effect
      const finalDoc = await api.documents.deleteAIVersion(documentId)

      // 4. Update store with final state (content matches, no aiVersion)
      useEditorStore.getState().updateActiveDocument(finalDoc)
    } catch (error) {
      handleApiError(error, 'Failed to accept all suggestions')
    } finally {
      setAiActionLoading(false)
    }
  }, [documentId, aiVersion])

  const handleRejectAll = useCallback(async () => {
    setAiActionLoading(true)
    try {
      // Clear ai_version (user keeps their content)
      const updatedDoc = await api.documents.deleteAIVersion(documentId)
      useEditorStore.getState().updateActiveDocument(updatedDoc)
    } catch (error) {
      handleApiError(error, 'Failed to reject all suggestions')
    } finally {
      setAiActionLoading(false)
    }
  }, [documentId])

  // Handle content changes from the editor
  const handleChange = useCallback((content: string) => {
    // Ignore changes before initialization
    if (!initializedRef.current) {
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
          editorRef.current.setContent(serverContent)
        }
      }

      setIsInitialized(true)
    }
  }, [activeDocument, documentId])

  // Auto-save when debounced content changes (only in edit mode AFTER init)
  // Treat empty string "" as valid content (do not use falsy checks)
  useEffect(() => {
    // Only save if debounce has "settled" (caught up to localContent)
    // This prevents saving stale debounced values during initialization
    if (debouncedContent !== localContent) return

    if (isInitialized && hasUserEdit && debouncedContent !== activeDocument?.content) {
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
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background relative">
          {header}
          <HeaderGradientFade />
        </div>

        {/* AI Suggestion Toolbar - shows when there are pending suggestions */}
        {hunks.length > 0 && (
          <AIToolbar
            hunkCount={hunks.length}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
            isLoading={aiActionLoading}
          />
        )}

        {/* Content area - shows skeleton while loading */}
        {isContentLoading ? (
          <div className="p-8 space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-5/6" />
          </div>
        ) : (
          /* Editor Content - CodeMirror 6 with right-click context menu */
          <EditorContextMenu editorRef={editorRef.current}>
            <div className="relative pt-1 flex-1">
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
  )
}
