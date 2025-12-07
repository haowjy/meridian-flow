import type { Extension } from '@codemirror/state'
import { keymap, EditorView, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { placeholder as placeholderExtension } from '@codemirror/view'

import { getLanguageExtension } from '../compartments/language'
import { getThemeExtension } from '../compartments/theme'
import { getLivePreviewCompartment } from '../compartments/livePreview'
import { getEditableExtension } from '../compartments/editable'
import { wordCountField } from './wordCount'
import { clipboard } from '../../clipboard'

/**
 * Options for the markdown editor bundle.
 */
export interface MarkdownEditorOptions {
  /** Placeholder text when empty */
  placeholder?: string
  /** Whether editor is editable */
  editable?: boolean
  /** Enable live preview mode */
  livePreview?: boolean
}

/**
 * Create a full-featured markdown editor extension bundle.
 * This is the primary editor configuration for document editing.
 *
 * Follows SRP - each concern is handled by a separate compartment/extension.
 */
export function markdownEditor(options: MarkdownEditorOptions = {}): Extension[] {
  const {
    placeholder = 'Start writing...',
    editable = true,
    livePreview = true, // Enable by default for Obsidian-style WYSIWYG
  } = options

  return [
    // Core functionality
    EditorView.lineWrapping,
    drawSelection(), // Custom selection rendering for consistent styling
    history(),
    highlightSelectionMatches(),

    // Keymaps
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),

    // Compartmentalized extensions (can be reconfigured at runtime)
    getLanguageExtension(),
    getThemeExtension(),
    getEditableExtension(editable),
    getLivePreviewCompartment(livePreview),

    // Word count tracking
    wordCountField,

    // Smart clipboard (rich text ↔ markdown)
    clipboard(),

    // Placeholder
    placeholderExtension(placeholder),
  ]
}

/**
 * Options for the minimal editor bundle.
 */
export interface MinimalEditorOptions {
  /** Placeholder text when empty */
  placeholder?: string
  /** Whether editor is editable */
  editable?: boolean
}

/**
 * Create a minimal editor extension bundle.
 * Used for simple text input (e.g., titles, descriptions).
 * No syntax highlighting or live preview.
 *
 * Follows SRP - minimal concerns for simple use cases.
 */
export function minimalEditor(options: MinimalEditorOptions = {}): Extension[] {
  const {
    placeholder = '',
    editable = true,
  } = options

  return [
    // Core functionality only
    EditorView.lineWrapping,
    history(),

    // Basic keymaps
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
    ]),

    // Compartmentalized extensions
    getThemeExtension(),
    getEditableExtension(editable),

    // Placeholder (if provided)
    ...(placeholder ? [placeholderExtension(placeholder)] : []),
  ]
}

/**
 * Options for the readonly viewer bundle.
 */
export interface ReadonlyViewerOptions {
  /** Enable live preview mode */
  livePreview?: boolean
}

/**
 * Create a readonly viewer extension bundle.
 * Used for displaying markdown content without editing.
 *
 * Follows SRP - optimized for viewing, not editing.
 */
export function readonlyViewer(options: ReadonlyViewerOptions = {}): Extension[] {
  const { livePreview = true } = options

  return [
    // No history needed for readonly
    EditorView.lineWrapping,
    highlightSelectionMatches(),

    // Minimal keymaps (search only)
    keymap.of([
      ...searchKeymap,
    ]),

    // Compartmentalized extensions
    getLanguageExtension(),
    getThemeExtension(),
    getEditableExtension(false),
    getLivePreviewCompartment(livePreview),
  ]
}
