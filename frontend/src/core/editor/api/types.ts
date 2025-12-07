import type { EditorView } from '@codemirror/view'

/**
 * Attributes for AI decorations.
 */
export interface DecorationAttrs {
  sessionId: string
  editId?: string
  original?: string
  type: 'ai-suggestion' | 'ai-accepted' | 'ai-rejected' | 'custom'
  className?: string
}

/**
 * Handle for managing a decoration.
 */
export interface DecorationHandle {
  id: string
  from: number
  to: number
}

/**
 * Information about a decoration.
 */
export interface DecorationInfo {
  handle: DecorationHandle
  from: number
  to: number
  attrs: DecorationAttrs
}

/**
 * Editor ref interface exposed to parent components.
 * This abstracts CM6 internals (Dependency Inversion).
 *
 * - High-level features call methods on this interface
 * - Only the core editor module constructs EditorView / StateFields
 */
export interface AIEditorRef {
  // Content access
  getContent(): string
  getSelectedText(): string
  getSelection(): { from: number; to: number }

  // Content modification
  replaceRange(from: number, to: number, text: string): void
  insertAt(position: number, text: string): void
  replaceAll(text: string): void

  // Decoration management
  addDecoration(from: number, to: number, attrs: DecorationAttrs): DecorationHandle
  removeDecoration(handle: DecorationHandle): void
  removeDecorations(filter: (attrs: DecorationAttrs) => boolean): void
  getDecorations(filter?: (attrs: DecorationAttrs) => boolean): DecorationInfo[]
  clearAllDecorations(): void

  // Navigation
  scrollToPosition(pos: number): void
  scrollToLine(line: number): void
  focus(): void

  // Internal access (escape hatch)
  getView(): EditorView | null
}
