"use client"

import { useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import { getExtensions } from '@/core/editor/extensions'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useDebounce } from '@/core/hooks/useDebounce'
import { useEditorCache } from '@/core/hooks/useEditorCache'
import { cn } from '@/lib/utils'
import { EditorHeader } from './EditorHeader'
import { EditorToolbarContainer } from './EditorToolbarContainer'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { makeLogger } from '@/core/lib/logger'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { CompactBreadcrumb } from '@/shared/components/ui/CompactBreadcrumb'
import { Button } from '@/shared/components/ui/button'
import { ChevronLeft } from 'lucide-react'

const logger = makeLogger('editor-panel')
// Removed inline rename flow for now (EditorTitle deleted)

interface EditorPanelProps {
  documentId: string
}

/**
 * Minimal TipTap editor with markdown shortcuts.
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

  // Two-state pattern: local state for instant updates, debounced for saves
  const [localContent, setLocalContent] = useState('')
  const [hasUserEdit, setHasUserEdit] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const initializedRef = useRef(false)
  useEffect(() => {
    initializedRef.current = isInitialized
  }, [isInitialized])
  const debouncedContent = useDebounce(localContent, 1000) // 1 second trailing edge

  // TipTap editor instance with LRU caching for instant document switching
  const { editor, isFromCache } = useEditorCache({
    documentId,
    content: localContent,
    extensions: getExtensions(),
    // Always editable once initialized
    editable: !!activeDocument && activeDocument.id === documentId && !isLoading && isInitialized,
    immediatelyRender: false, // Fix SSR hydration mismatch
    editorProps: {
      attributes: {
        class: cn('tiptap cursor-text'),
      },
    },
    onUpdate: ({ editor }) => {
      // Ignore TipTap's early updates before we finish initializing content
      if (!initializedRef.current) return
      const markdown = editor.getMarkdown()
      setLocalContent(markdown)
      setHasUserEdit(true) // Mark that user has edited
    },
  })

  // Load document on mount or when documentId changes
  useEffect(() => {
    // Prevent duplicate loads from React Strict Mode double-mounting
    // Skip if we're already loading this exact document
    if (_activeDocumentId === documentId && isLoading) {
      logger.debug('Skipping duplicate load for', documentId)
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

    // Do NOT clear localContent here; allow cached editor to repopulate if present
    loadDocument(documentId, abortController.signal)

    // Cleanup: abort request if component unmounts or documentId changes
    // NOTE: In dev mode with React Strict Mode, this abort() will be called during the
    // intentional double-mount cleanup, causing an AbortError to appear in the Next.js
    // error overlay. This is EXPECTED and HARMLESS - the error is caught and handled
    // silently by useEditorStore. In production (no Strict Mode), this only runs on
    // real unmounts or document changes. The abort is necessary to prevent stale
    // requests from updating state after the component has moved on.
    return () => {
      abortController.abort()
    }
  // Intentionally depend only on documentId and loadDocument.
  // _activeDocumentId and isLoading are read via the store for duplicate-load prevention.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, loadDocument])

  // Note: The tree is loaded by WorkspaceLayout on deep links.

  // Initialize local content when document loads
  // BUT: Skip if we're using a cached editor (it has the correct content already)
  useEffect(() => {
    const initializeFromActiveDocument = () => {
      if (activeDocument && activeDocument.id === documentId && !isFromCache) {
        // New editor: Initialize with document content from DB
        setLocalContent(activeDocument.content ?? '')
        setHasUserEdit(false) // Reset flag when switching documents
        if (editor) {
          editor.commands.setContent(activeDocument.content ?? '', {
            contentType: 'markdown',
            emitUpdate: false
          })
        }
        setIsInitialized(true)
      } else if (activeDocument && activeDocument.id === documentId && isFromCache) {
        // Cached editor: Preserve its content (may have unsaved changes)
        // UNLESS the cached editor is empty AND server has content
        // (This handles incomplete initialization race condition)
        const cachedContent = editor?.getMarkdown() ?? ''
        const serverContent = activeDocument.content ?? ''
        const cachedIsEmpty = cachedContent === ''
        const serverHasContent = serverContent !== ''

        if (cachedIsEmpty && serverHasContent) {
          // Cached editor never got initialized properly, use server content
          logger.debug('Cached editor is empty, initializing from server')
          setLocalContent(serverContent)
          if (editor) {
            editor.commands.setContent(serverContent, {
              contentType: 'markdown',
              emitUpdate: false
            })
          }
          setIsInitialized(true)
        } else {
          // Trust the cached editor (it has either the correct content or unsaved changes)
          logger.debug('Using cached editor content')
          setLocalContent(cachedContent)
          setIsInitialized(true)
        }

        setHasUserEdit(false) // Reset flag when switching documents
      }
    }

    initializeFromActiveDocument()
  }, [activeDocument, isFromCache, editor, documentId]) // Check content updates too

  // Auto-save when debounced content changes (only in edit mode AFTER init)
  // Treat empty string "" as valid content (do not use falsy checks)
  useEffect(() => {
    if (isInitialized && hasUserEdit && debouncedContent !== activeDocument?.content) {
      saveDocument(documentId, debouncedContent)
    }
  }, [isInitialized, hasUserEdit, debouncedContent, documentId, activeDocument?.content, saveDocument])

  // Sync content: cached editor → localContent OR localContent → new editor
  useEffect(() => {
    if (!editor) return

    const syncEditorAndState = () => {
      const currentContent = editor.getMarkdown()

      if (isFromCache) {
        // Cached editor is source of truth - preserve its content (may have unsaved changes)
        // Sync localContent FROM editor to prevent loadDocument from overwriting it
        if (currentContent !== localContent) {
          logger.debug('Syncing localContent from cached editor')
          setLocalContent(currentContent)
          // Important: Don't set hasUserEdit here - this is just state sync, not a user action
        }
      } else {
        // New editor - initialize it with current localContent from store
        if (localContent !== undefined && currentContent !== localContent) {
          logger.debug('Initializing new editor with localContent')
          editor.commands.setContent(localContent, {
            contentType: 'markdown',
            emitUpdate: false
          })
        }
      }
    }

    syncEditorAndState()
  }, [editor, isFromCache, localContent, documentId])

  // Determine the best available source for header metadata
  const headerDocument =
    documentMetadata || (activeDocument?.id === documentId ? activeDocument : null)

  const handleBackClick = () => {
    // Only swap the right panel back to the tree view without changing URL.
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  const header = headerDocument ? (
    <EditorHeader document={headerDocument} />
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
  // Show content as soon as we have an activeDocument and editor instance,
  // even if the store is still reconciling (isLoading=true). Editor remains read-only
  // until initialization finishes.
  const isContentLoading = !editor || activeDocument?.id !== documentId || !isInitialized

  return (
    <div className="flex h-full flex-col">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background">
          {header}
        </div>

        {/* Content area - shows skeleton while loading */}
        {isContentLoading ? (
          <div className="p-8 space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-5/6" />
          </div>
        ) : (
          <>
            {/* Sticky Toolbar */}
            <div className="sticky top-12 z-10 bg-background relative">
              <EditorToolbarContainer
                editor={editor}
                status={status}
                lastSaved={lastSaved}
              />
              {/* Gradient blur fade - extends below the toolbar */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 translate-y-full bg-gradient-to-b from-background via-background/50 to-transparent" />
            </div>

            {/* Editor Content */}
            <div className="relative pt-3">
              <EditorContent editor={editor} className="min-h-full flex flex-col" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
