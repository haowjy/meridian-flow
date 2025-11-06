'use client'

import { useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Typography from '@tiptap/extension-typography'
import CharacterCount from '@tiptap/extension-character-count'
import Placeholder from '@tiptap/extension-placeholder'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useDebounce } from '@/core/hooks/useDebounce'
import { useEditorCache } from '@/core/hooks/useEditorCache'
import { cn } from '@/lib/utils'
import { EditorHeader } from './EditorHeader'
import { EditorTitle } from './EditorTitle'
import { EditorToolbar } from './EditorToolbar'
import { EditorStatusBar } from './EditorStatusBar'
import { CardSkeleton } from '@/shared/components/ui/card'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { api } from '@/core/lib/api'
import { toast } from 'sonner'

interface EditorPanelProps {
  documentId: string
}

/**
 * Minimal TipTap editor with markdown shortcuts.
 * Integrates: Document loading, auto-save, read-only mode.
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

  const editorReadOnly = useUIStore((state) => state.editorReadOnly)

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
    extensions: [
      StarterKit,
      Highlight,
      Typography,
      CharacterCount,
      Placeholder.configure({
        placeholder: 'Start writing...',
      }),
    ],
    // Keep editor read-only until initialization completes for this document
    editable: !editorReadOnly && !!activeDocument && activeDocument.id === documentId && !isLoading && isInitialized,
    immediatelyRender: false, // Fix SSR hydration mismatch
    editorProps: {
      attributes: {
        class: cn('tiptap', editorReadOnly && 'read-only'),
      },
    },
    onUpdate: ({ editor }) => {
      // Ignore TipTap's early updates before we finish initializing content
      if (!initializedRef.current) return
      const html = editor.getHTML()
      setLocalContent(html)
      setHasUserEdit(true) // Mark that user has edited
    },
  })

  // Load document on mount or when documentId changes
  useEffect(() => {
    // Prevent duplicate loads from React Strict Mode double-mounting
    // Skip if we're already loading this exact document
    if (_activeDocumentId === documentId && isLoading) {
      console.log('[EditorPanel] Skipping duplicate load for', documentId)
      return
    }

    // Create AbortController for this load operation
    const abortController = new AbortController()

    // Reset local editor state on document change
    setIsInitialized(false)
    initializedRef.current = false
    setHasUserEdit(false)
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
  }, [documentId, loadDocument])

  // Initialize local content when document loads
  // BUT: Skip if we're using a cached editor (it has the correct content already)
  useEffect(() => {
    if (activeDocument && activeDocument.id === documentId && !isFromCache) {
      // New editor: Initialize with document content from DB
      setLocalContent(activeDocument.content ?? '')
      setHasUserEdit(false) // Reset flag when switching documents
      if (editor) {
        editor.commands.setContent(activeDocument.content ?? '', { emitUpdate: false })
      }
      setIsInitialized(true)
    } else if (activeDocument && activeDocument.id === documentId && isFromCache) {
      // Cached editor: Preserve its content (may have unsaved changes)
      // UNLESS the cached editor is empty AND server has content
      // (This handles incomplete initialization race condition)
      const cachedContent = editor?.getHTML() ?? ''
      const serverContent = activeDocument.content ?? ''
      const cachedIsEmpty = cachedContent === '' || cachedContent === '<p></p>'
      const serverHasContent = serverContent !== '' && serverContent !== '<p></p>'

      if (cachedIsEmpty && serverHasContent) {
        // Cached editor never got initialized properly, use server content
        console.log('[Editor] Cached editor is empty, initializing from server')
        setLocalContent(serverContent)
        if (editor) {
          editor.commands.setContent(serverContent, { emitUpdate: false })
        }
        setIsInitialized(true)
      } else {
        // Trust the cached editor (it has either the correct content or unsaved changes)
        console.log('[Editor] Using cached editor content')
        setLocalContent(cachedContent)
        setIsInitialized(true)
      }

      setHasUserEdit(false) // Reset flag when switching documents
    }
  }, [activeDocument?.id, activeDocument?.content, isFromCache, editor, documentId]) // Check content updates too

  // Auto-save when debounced content changes (only in edit mode AFTER init)
  // Treat empty string "" as valid content (do not use falsy checks)
  useEffect(() => {
    if (!editorReadOnly && isInitialized && hasUserEdit && debouncedContent !== activeDocument?.content) {
      saveDocument(documentId, debouncedContent)
    }
  }, [editorReadOnly, isInitialized, hasUserEdit, debouncedContent, documentId, activeDocument?.content, saveDocument])

  // Sync content: cached editor → localContent OR localContent → new editor
  useEffect(() => {
    if (!editor) return

    const currentContent = editor.getHTML()

    if (isFromCache) {
      // Cached editor is source of truth - preserve its content (may have unsaved changes)
      // Sync localContent FROM editor to prevent loadDocument from overwriting it
      if (currentContent !== localContent) {
        console.log('[Editor] Syncing localContent from cached editor')
        setLocalContent(currentContent)
        // Important: Don't set hasUserEdit here - this is just state sync, not a user action
      }
    } else {
      // New editor - initialize it with current localContent from store
      if (localContent !== undefined && currentContent !== localContent) {
        console.log('[Editor] Initializing new editor with localContent')
        editor.commands.setContent(localContent, { emitUpdate: false })
      }
    }
  }, [editor, isFromCache, localContent, documentId])

  // Handle document rename
  const handleRename = async (newName: string) => {
    try {
      await api.documents.rename(documentId, newName)
      toast.success('Document renamed')

      // Update tree store to reflect the change
      // TODO: Add a method to update document name in tree store
      // For now, the tree will update on next reload
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename document'
      toast.error(message)
      throw error // Re-throw so EditorTitle stays in edit mode
    }
  }

  // Error state - show error panel without header
  // Note: onRetry doesn't pass signal, which is fine for manual retries
  // The AbortController in the useEffect will handle cleanup if user navigates away
  if (error) {
    return (
      <ErrorPanel
        title="Failed to load document"
        message={error}
        onRetry={() => loadDocument(documentId)}
      />
    )
  }

  // No metadata available - shouldn't happen but handle gracefully
  if (!documentMetadata) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex-1 p-8">
          <p className="text-muted-foreground">Document not found in tree</p>
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
      {/* Header with navigation and folder breadcrumbs - shows immediately */}
      <EditorHeader document={documentMetadata} />

      {/* Editable title - shows immediately */}
      <EditorTitle
        title={activeDocument?.name || documentMetadata.name}
        onRename={handleRename}
        readOnly={editorReadOnly}
      />

      {/* Content area - shows skeleton while loading */}
      {isContentLoading ? (
        <div className="flex-1 p-8">
          <CardSkeleton className="mb-4 h-8" />
          <CardSkeleton className="mb-4 h-6" />
          <CardSkeleton className="h-6" />
        </div>
      ) : (
        <>
          {/* Toolbar (only in edit mode) */}
          {!editorReadOnly && <EditorToolbar editor={editor} />}

          {/* Editor Content */}
          <div className="flex-1 overflow-auto relative">
            <EditorContent editor={editor} />

            {/* Floating Status Bar */}
            <EditorStatusBar
              editor={editor}
              status={status}
              lastSaved={lastSaved}
              className="fixed bottom-4 right-4"
            />
          </div>
        </>
      )}
    </div>
  )
}
