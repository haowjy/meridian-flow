import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdownEditor } from './extensions/bundle'
import { setEditable } from './compartments/editable'
import { createEditorState } from './setup'
import type { CodeMirrorEditorRef, CodeMirrorEditorOptions, WordCount } from './types'
import { cn } from '@/lib/utils'
import {
  toggleBold as toggleBoldCmd,
  toggleItalic as toggleItalicCmd,
  toggleHeading as toggleHeadingCmd,
  toggleBulletList as toggleBulletListCmd,
  toggleOrderedList as toggleOrderedListCmd,
  isFormatActive as isFormatActiveCmd,
} from './commands'
import { getWordCount } from './extensions/wordCount'

/**
 * CodeMirror 6 editor component for markdown editing.
 *
 * This is the core editor shell (Phase 0.1). It provides:
 * - Basic markdown editing with syntax highlighting
 * - Undo/redo via CM6 history
 * - Content load/save via ref methods
 * - Editable toggle for "edit before init" race prevention
 *
 * The editor is controlled via the ref, not props. Content changes
 * are reported via onChange callback, but setting content is done
 * via ref.setContent().
 *
 * @example
 * ```tsx
 * const editorRef = useRef<CodeMirrorEditorRef>(null)
 *
 * // Load content
 * editorRef.current?.setContent(markdown)
 *
 * // Get content
 * const content = editorRef.current?.getContent()
 * ```
 */
export const CodeMirrorEditor = forwardRef<CodeMirrorEditorRef, CodeMirrorEditorOptions>(
  function CodeMirrorEditor(
    {
      initialContent = '',
      editable = true,
      placeholder = 'Start writing...',
      extensions: additionalExtensions = [],
      onChange,
      onReady,
      className,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)

    // Keep onChange ref up to date without causing effect re-runs
    useEffect(() => {
      onChangeRef.current = onChange
    }, [onChange])

    // Create the editor ref interface
    const editorRef: CodeMirrorEditorRef = {
      getContent() {
        return viewRef.current?.state.doc.toString() ?? ''
      },
      setContent(content: string, cursorPos?: number) {
        const view = viewRef.current
        if (!view) return

        // Determine cursor position:
        // - If provided: use it (AI edits specify where cursor should go)
        // - If not provided: preserve current position, clamped to new content length
        const newCursorPos = cursorPos ?? Math.min(
          view.state.selection.main.head,
          content.length
        )

        // Replace entire document content
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: content,
          },
          selection: { anchor: newCursorPos },
          // Don't add to undo history when setting content externally
          annotations: [],
        })
      },
      getState() {
        return viewRef.current?.state ?? EditorState.create({ doc: '' })
      },
      getView() {
        return viewRef.current
      },
      focus() {
        viewRef.current?.focus()
      },

      // Formatting commands
      toggleBold() {
        const view = viewRef.current
        if (!view) return false
        return toggleBoldCmd(view)
      },
      toggleItalic() {
        const view = viewRef.current
        if (!view) return false
        return toggleItalicCmd(view)
      },
      toggleHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
        const view = viewRef.current
        if (!view) return false
        return toggleHeadingCmd(view, level)
      },
      toggleBulletList() {
        const view = viewRef.current
        if (!view) return false
        return toggleBulletListCmd(view)
      },
      toggleOrderedList() {
        const view = viewRef.current
        if (!view) return false
        return toggleOrderedListCmd(view)
      },

      // Format detection
      isFormatActive(format: 'bold' | 'italic' | 'heading' | 'bulletList' | 'orderedList', level?: number) {
        const view = viewRef.current
        if (!view) return false
        return isFormatActiveCmd(view, format, level)
      },

      // Word count
      getWordCount(): WordCount {
        const view = viewRef.current
        if (!view) return { words: 0, characters: 0, paragraphs: 0 }
        return getWordCount(view.state)
      },
    }

    // Expose the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editorRef is stable (uses refs internally)
    useImperativeHandle(ref, () => editorRef, [])

    // Create editor on mount
    useEffect(() => {
      if (!containerRef.current) return

      // Build extensions using SOLID-compliant bundle
      const baseExtensions = markdownEditor({
        placeholder,
        editable,
      })

      // Add update listener for onChange
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          console.log('[CM] docChanged, calling onChange')
          if (onChangeRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }
      })

      // Create state and view
      const state = createEditorState(initialContent, [
        ...baseExtensions,
        ...additionalExtensions,
        updateListener,
      ])

      const view = new EditorView({
        state,
        parent: containerRef.current,
      })

      viewRef.current = view

      // Notify that editor is ready
      onReady?.(editorRef)

      // Cleanup on unmount
      return () => {
        view.destroy()
        viewRef.current = null
      }
      // Only run on mount - content updates happen via ref
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Update editable state when prop changes
    useEffect(() => {
      if (viewRef.current) {
        setEditable(viewRef.current, editable)
      }
    }, [editable])

    return (
      <div
        ref={containerRef}
        className={cn(
          'codemirror-editor',
          'min-h-full flex-1',
          className
        )}
      />
    )
  }
)
