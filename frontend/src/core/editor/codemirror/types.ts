import type { EditorState, Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Reference interface for the CodeMirror editor.
 * This is the DIP boundary - feature code should use this interface,
 * not import @codemirror/* directly.
 */
export interface CodeMirrorEditorRef {
  // Content
  getContent(): string
  /** Set content. Optional cursorPos for AI edits; if omitted, preserves current cursor position. */
  setContent(content: string, cursorPos?: number): void

  // State access (for caching)
  getState(): EditorState
  getView(): EditorView | null

  // Focus
  focus(): void

  // Formatting commands
  toggleBold(): boolean
  toggleItalic(): boolean
  toggleHeading(level: 1 | 2 | 3 | 4 | 5 | 6): boolean
  toggleBulletList(): boolean
  toggleOrderedList(): boolean

  // Format detection (for toolbar active states)
  isFormatActive(format: 'bold' | 'italic' | 'heading' | 'bulletList' | 'orderedList', level?: number): boolean

  // Word count
  getWordCount(): WordCount
}

/**
 * Options for the CodeMirror editor component.
 */
export interface CodeMirrorEditorOptions {
  /** Initial content (markdown) */
  initialContent?: string
  /** Whether the editor is editable */
  editable?: boolean
  /** Placeholder text when empty */
  placeholder?: string
  /** Additional extensions to include */
  extensions?: Extension[]
  /** Called when content changes */
  onChange?: (content: string) => void
  /** Called when the editor is ready */
  onReady?: (ref: CodeMirrorEditorRef) => void
  /** CSS class name for the editor container */
  className?: string
}

/**
 * Word count statistics from the editor.
 */
export interface WordCount {
  words: number
  characters: number
  paragraphs: number
}
