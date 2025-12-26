/**
 * CodeMirror Editor Types
 *
 * SOLID: Interface Segregation - Small, focused interfaces
 */

import type { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

// ============================================================================
// WORD COUNT
// ============================================================================

export interface WordCount {
  words: number
  characters: number
  paragraphs: number
}

// ============================================================================
// EDITOR REF INTERFACES (ISP: segregated by responsibility)
// ============================================================================

/**
 * Options for setContent() to control history and event behavior.
 * Used for hydration/refresh (server → editor) vs user actions.
 */
export interface SetContentOptions {
  /**
   * If false, don't add to undo history.
   * Use for server hydration/refresh.
   * Default: true
   */
  addToHistory?: boolean

  /**
   * If false, do not call the React onChange callback.
   * Use for hydration/refresh (server → editor), not for user actions.
   * Default: true
   */
  emitChange?: boolean
}

/**
 * Core editor operations
 */
export interface EditorRef {
  getContent(): string
  setContent(content: string, options?: SetContentOptions): void
  focus(): void
  getView(): EditorView | null
}

/**
 * Text formatting operations
 */
export interface FormattingRef {
  toggleBold(): void
  toggleItalic(): void
  toggleInlineCode(): void
  toggleHeading(level: 1 | 2 | 3): void
  insertLink(url: string, text?: string): void
}

/**
 * List operations
 */
export interface ListRef {
  toggleBulletList(): void
  toggleOrderedList(): void
}

/**
 * Format detection for toolbar state
 */
export interface FormatDetectionRef {
  isFormatActive(format: FormatType): boolean
}

/**
 * Word counting
 */
export interface WordCountRef {
  getWordCount(): WordCount
}

/**
 * Dynamic configuration via compartments
 * Allows runtime changes without recreating the editor
 */
export interface ConfigurationRef {
  /** Set editable state dynamically (via compartment reconfiguration) */
  setEditable(editable: boolean): void
  /** Set theme dynamically (via compartment reconfiguration) */
  setTheme(theme: Extension): void
  /** Enable/disable live preview (for diff mode where preview is confusing) */
  setLivePreviewEnabled(enabled: boolean): void
}

/**
 * Combined editor ref - implements all interfaces
 */
export interface CodeMirrorEditorRef
  extends EditorRef,
    FormattingRef,
    ListRef,
    FormatDetectionRef,
    WordCountRef,
    ConfigurationRef {}

// ============================================================================
// FORMAT TYPES
// ============================================================================

export type FormatType =
  | 'bold'
  | 'italic'
  | 'inlineCode'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'link'

// ============================================================================
// EDITOR OPTIONS
// ============================================================================

export interface CodeMirrorEditorOptions {
  /** Initial markdown content */
  initialContent?: string
  /** Called when content changes */
  onChange?: (content: string) => void
  /** Called when editor is ready with ref */
  onReady?: (ref: CodeMirrorEditorRef) => void
  /** Whether editor is editable */
  editable?: boolean
  /** Placeholder text when empty */
  placeholder?: string
  /** Auto-focus on mount */
  autoFocus?: boolean
  /** Additional CSS class for the container */
  className?: string
  /**
   * Extra extensions to append to the base editor configuration.
   * Use this for merge view, additional keymaps, or other extensions.
   *
   * IMPORTANT: These are appended AFTER base extensions. For extensions that
   * need dynamic reconfiguration (e.g., merge view mode switching), wrap them
   * in a Compartment and use reconfigure() to change them.
   *
   * @example
   * ```ts
   * // Static extensions
   * <CodeMirrorEditor extensions={[myExtension]} />
   *
   * // Dynamic extensions with Compartment
   * const compartment = new Compartment()
   * <CodeMirrorEditor extensions={[compartment.of(changesExtensions(baseline))]} />
   * ```
   */
  extensions?: Extension[]
}
