'use client'

import { useEffect, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Typography from '@tiptap/extension-typography'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useAbortController } from '@/core/hooks/useAbortController'
import { useDebounce } from '@/core/hooks/useDebounce'
import { cn } from '@/lib/utils'
import { EditorHeader } from './EditorHeader'
import { EditorToolbar } from './EditorToolbar'
import { EditorStatusBar } from './EditorStatusBar'
import { CardSkeleton } from '@/shared/components/ui/card'
import { ErrorPanel } from '@/shared/components/ErrorPanel'

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
    isLoading,
    error,
    status,
    lastSaved,
    loadDocument,
    saveDocument,
  } = useEditorStore()

  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const signal = useAbortController([documentId])

  // Two-state pattern: local state for instant updates, debounced for saves
  const [localContent, setLocalContent] = useState('')
  const debouncedContent = useDebounce(localContent, 1000) // 1 second trailing edge

  // Load document on mount or when documentId changes
  useEffect(() => {
    loadDocument(documentId, signal)
  }, [documentId, loadDocument, signal])

  // Initialize local content when document loads
  useEffect(() => {
    if (activeDocument?.content) {
      setLocalContent(activeDocument.content)
    }
  }, [activeDocument?.id]) // Only reset when switching documents

  // Auto-save when debounced content changes (only in edit mode)
  useEffect(() => {
    if (!editorReadOnly && debouncedContent && debouncedContent !== activeDocument?.content) {
      saveDocument(documentId, debouncedContent)
    }
  }, [editorReadOnly, debouncedContent, documentId, activeDocument?.content, saveDocument])

  // TipTap editor instance with minimal extensions
  const editor = useEditor({
    extensions: [StarterKit, Highlight, Typography],
    content: localContent,
    editable: !editorReadOnly,
    immediatelyRender: false, // Fix SSR hydration mismatch
    editorProps: {
      attributes: {
        class: cn('tiptap', editorReadOnly && 'read-only'),
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      setLocalContent(html)
    },
  })

  // Update editor content when document loads or switches
  useEffect(() => {
    if (editor && localContent) {
      const currentContent = editor.getHTML()
      if (currentContent !== localContent) {
        // Use emitUpdate: false to prevent circular updates
        editor.commands.setContent(localContent, { emitUpdate: false })
      }
    }
  }, [localContent, editor]) // Guard prevents unnecessary updates on keystroke

  // Update editor editable state when read-only mode changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!editorReadOnly)
    }
  }, [editorReadOnly, editor])

  // Loading state
  if (isLoading || !activeDocument) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b px-4 py-3">
          <CardSkeleton className="h-6" />
        </div>
        <div className="flex-1 p-8">
          <CardSkeleton className="mb-4 h-8" />
          <CardSkeleton className="mb-4 h-6" />
          <CardSkeleton className="h-6" />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <ErrorPanel
        title="Failed to load document"
        message={error}
        onRetry={() => loadDocument(documentId)}
      />
    )
  }

  // Don't render toolbar until editor is ready (prevents null editor prop)
  if (!editor) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b px-4 py-3">
          <CardSkeleton className="h-6" />
        </div>
        <div className="flex-1 p-8">
          <CardSkeleton className="mb-4 h-8" />
          <CardSkeleton className="mb-4 h-6" />
          <CardSkeleton className="h-6" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with navigation and breadcrumbs */}
      <EditorHeader document={activeDocument} />

      {/* Toolbar (only in edit mode) */}
      {!editorReadOnly && <EditorToolbar editor={editor} />}

      {/* Editor Content */}
      <div className="flex-1 overflow-auto relative">
        <EditorContent editor={editor} />

        {/* Floating Status Bar */}
        <EditorStatusBar
          content={localContent}
          status={status}
          lastSaved={lastSaved}
          className="fixed bottom-4 right-4"
        />
      </div>
    </div>
  )
}
