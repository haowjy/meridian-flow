import { useEffect, useRef, useCallback } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { editorCache } from './editorCache'

interface UseEditorCacheOptions {
  documentId: string
  initialContent: string
  extensions: Extension[]
  onChange?: (content: string) => void
}

interface UseEditorCacheReturn {
  containerRef: React.RefObject<HTMLDivElement | null>
  viewRef: React.MutableRefObject<EditorView | null>
  getContent: () => string
  setContent: (content: string) => void
}

/**
 * Hook for managing cached CodeMirror editors.
 * Handles state preservation across document switches.
 *
 * SRP:
 * - Owns EditorView lifecycle + caching mechanics
 * - Does NOT know about auto-save, AI, or higher-level flows
 *   (those stay in feature hooks/components like EditorPanel)
 */
export function useEditorCache({
  documentId,
  initialContent,
  extensions,
  onChange,
}: UseEditorCacheOptions): UseEditorCacheReturn {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const documentIdRef = useRef(documentId)

  // Keep refs updated without causing re-renders
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    documentIdRef.current = documentId
  }, [documentId])

  // Create or restore editor
  useEffect(() => {
    if (!containerRef.current) return

    // Check for cached state
    const cached = editorCache.get(documentId)

    let state: EditorState

    if (cached) {
      // Use cached state (preserves undo history, cursor)
      // But we need to reconfigure with current extensions
      state = cached.state.update({}).state
    } else {
      // Create new state
      state = EditorState.create({
        doc: initialContent,
        extensions: [
          ...extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && onChangeRef.current) {
              onChangeRef.current(update.state.doc.toString())
              // Update cached state
              editorCache.updateState(documentIdRef.current, update.state)
            }
          }),
        ],
      })
    }

    // Create view
    const view = new EditorView({
      state,
      parent: containerRef.current,
    })

    viewRef.current = view

    // Restore scroll position
    if (cached) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = cached.scrollTop
        view.scrollDOM.scrollLeft = cached.scrollLeft
      })
    }

    // Initial cache (if not already cached)
    if (!cached) {
      editorCache.set(documentId, state, 0, 0)
    }

    // Save scroll position on scroll
    const handleScroll = () => {
      editorCache.updateScroll(
        documentIdRef.current,
        view.scrollDOM.scrollTop,
        view.scrollDOM.scrollLeft
      )
    }

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)

      // Save state before destroying
      editorCache.set(
        documentIdRef.current,
        view.state,
        view.scrollDOM.scrollTop,
        view.scrollDOM.scrollLeft
      )

      view.destroy()
      viewRef.current = null
    }
    // Note: extensions should be memoized by caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  // Handle external content changes (e.g., from API sync)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentContent = view.state.doc.toString()
    if (currentContent !== initialContent && initialContent !== '') {
      // Content changed externally - update editor
      // This preserves cursor position if possible
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: initialContent,
        },
      })
    }
  }, [initialContent])

  // Helper to get content
  const getContent = useCallback(() => {
    return viewRef.current?.state.doc.toString() ?? ''
  }, [])

  // Helper to set content
  const setContent = useCallback((content: string) => {
    const view = viewRef.current
    if (!view) return

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    })
  }, [])

  return { containerRef, viewRef, getContent, setContent }
}
