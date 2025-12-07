/**
 * CodeMirror Editor Component
 *
 * SOLID: Single Responsibility - Only handles React lifecycle and ref binding
 */

import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { EditorState, Prec, Compartment, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'

import type { CodeMirrorEditorRef, CodeMirrorEditorOptions, FormatType } from './types'
import { markdownLanguage, editorTheme, getWordCount } from './extensions'
import { livePreviewPlugin, registerBuiltinRenderers } from './livePreview'
import {
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  toggleHeading,
  insertLink,
  toggleBulletList,
  toggleOrderedList,
  isFormatActive,
} from './commands'
import { markdownEnterKeymap, autoPairsExtension, formattingKeymap } from './keyHandlers'

// ============================================================================
// COMPARTMENTS (CM6 best practice for dynamic reconfiguration)
// ============================================================================

/**
 * Compartment for editable state.
 * Allows toggling read-only mode without recreating the editor.
 */
const editableCompartment = new Compartment()

/**
 * Compartment for theme.
 * Allows runtime theme switching without recreating the editor.
 */
const themeCompartment = new Compartment()

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize renderers once (deferred from module load to component init)
 * This improves testability and initialization order control.
 */
let renderersInitialized = false

function initializeRenderers() {
  if (!renderersInitialized) {
    registerBuiltinRenderers()
    renderersInitialized = true
  }
}

// ============================================================================
// COMPONENT
// ============================================================================

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorRef, CodeMirrorEditorOptions>(
  function CodeMirrorEditor(
    { initialContent = '', onChange, onReady, editable = true, placeholder, autoFocus, className },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)

    // Expose ref API
    useImperativeHandle(
      ref,
      () => ({
        // EditorRef
        getContent() {
          return viewRef.current?.state.doc.toString() ?? ''
        },
        setContent(content: string) {
          const view = viewRef.current
          if (view) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
            })
          }
        },
        focus() {
          viewRef.current?.focus()
        },
        getView() {
          return viewRef.current
        },

        // FormattingRef
        toggleBold() {
          if (viewRef.current) toggleBold(viewRef.current)
        },
        toggleItalic() {
          if (viewRef.current) toggleItalic(viewRef.current)
        },
        toggleInlineCode() {
          if (viewRef.current) toggleInlineCode(viewRef.current)
        },
        toggleHeading(level: 1 | 2 | 3) {
          if (viewRef.current) toggleHeading(viewRef.current, level)
        },
        insertLink(url: string, text?: string) {
          if (viewRef.current) insertLink(viewRef.current, url, text)
        },

        // ListRef
        toggleBulletList() {
          if (viewRef.current) toggleBulletList(viewRef.current)
        },
        toggleOrderedList() {
          if (viewRef.current) toggleOrderedList(viewRef.current)
        },

        // FormatDetectionRef
        isFormatActive(format: FormatType) {
          if (viewRef.current) return isFormatActive(viewRef.current, format)
          return false
        },

        // WordCountRef
        getWordCount() {
          if (viewRef.current) return getWordCount(viewRef.current.state)
          return { words: 0, characters: 0, paragraphs: 0 }
        },

        // ConfigurationRef - dynamic reconfiguration via compartments
        setEditable(value: boolean) {
          viewRef.current?.dispatch({
            effects: editableCompartment.reconfigure(EditorView.editable.of(value)),
          })
        },
        setTheme(theme: Extension) {
          viewRef.current?.dispatch({
            effects: themeCompartment.reconfigure(theme),
          })
        },
      }),
      []
    )

    // Initialize editor
    useEffect(() => {
      if (!containerRef.current) return

      // Initialize renderers once (moved from module level for better control)
      initializeRenderers()

      const updateListener = EditorView.updateListener.of(update => {
        if (update.docChanged && onChange) {
          onChange(update.state.doc.toString())
        }
      })

      const extensions = [
        // Core
        history(),

        // Key handling (high priority)
        Prec.highest(markdownEnterKeymap),
        autoPairsExtension,
        Prec.high(formattingKeymap),

        // Default keymaps
        keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),

        // For quotes only (brackets handled by autoPairs)
        closeBrackets(),

        // Markdown
        markdownLanguage,

        // Live preview
        livePreviewPlugin,

        // Theming (wrapped in compartment for runtime switching)
        themeCompartment.of(editorTheme),

        // Line wrapping
        EditorView.lineWrapping,

        // Editable state (wrapped in compartment for dynamic toggling)
        editableCompartment.of(EditorView.editable.of(editable)),

        // Update listener
        updateListener,
      ]

      // Add placeholder if provided
      if (placeholder) {
        extensions.push(placeholderExtension(placeholder))
      }

      const state = EditorState.create({
        doc: initialContent,
        extensions,
      })

      const view = new EditorView({
        state,
        parent: containerRef.current,
      })

      viewRef.current = view

      // Auto-focus if requested
      if (autoFocus) {
        view.focus()
      }

      // Notify ready
      if (onReady) {
        onReady({
          getContent: () => view.state.doc.toString(),
          setContent: (content: string) => {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
            })
          },
          focus: () => view.focus(),
          getView: () => view,
          toggleBold: () => toggleBold(view),
          toggleItalic: () => toggleItalic(view),
          toggleInlineCode: () => toggleInlineCode(view),
          toggleHeading: (level: 1 | 2 | 3) => toggleHeading(view, level),
          insertLink: (url: string, text?: string) => insertLink(view, url, text),
          toggleBulletList: () => toggleBulletList(view),
          toggleOrderedList: () => toggleOrderedList(view),
          isFormatActive: (format: FormatType) => isFormatActive(view, format),
          getWordCount: () => getWordCount(view.state),
          setEditable: (value: boolean) => {
            view.dispatch({
              effects: editableCompartment.reconfigure(EditorView.editable.of(value)),
            })
          },
          setTheme: (theme: Extension) => {
            view.dispatch({
              effects: themeCompartment.reconfigure(theme),
            })
          },
        })
      }

      return () => {
        view.destroy()
        viewRef.current = null
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []) // Only run on mount - intentionally omit deps to avoid recreating editor

    // Note: editable and theme can now be changed dynamically via ref.setEditable() and ref.setTheme()
    // thanks to compartments - no need to recreate the editor

    return <div ref={containerRef} className={className ?? 'h-full w-full'} />
  }
)
