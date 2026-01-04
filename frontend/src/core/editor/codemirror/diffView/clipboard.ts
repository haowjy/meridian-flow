/**
 * Diff View Clipboard Handling
 *
 * SRP: Handles clipboard operations with diff formatting.
 * - Copy/cut: Converts PUA markers to markdown strikethrough + HTML <del>
 * - Paste: Strips PUA markers (safety)
 */

import { EditorView } from '@codemirror/view'
import { stripMarkers, MARKERS } from '@/core/lib/mergedDocument'
import { markdownToHtml } from '@/core/lib/clipboard'

// =============================================================================
// FORMATTING
// =============================================================================

/**
 * Format diff text for clipboard.
 * Converts PUA markers to markdown strikethrough.
 *
 * Input:  "\uE000old\uE001\uE002new\uE003"
 * Output: "~~old~~new"
 */
export function formatDiffForClipboard(text: string): string {
  return text
    .replace(new RegExp(MARKERS.DEL_START, 'g'), '~~')
    .replace(new RegExp(MARKERS.DEL_END, 'g'), '~~')
    .replace(new RegExp(MARKERS.INS_START, 'g'), '')
    .replace(new RegExp(MARKERS.INS_END, 'g'), '')
}

// =============================================================================
// DOM HANDLERS
// =============================================================================

/**
 * DOM handler for copy/cut events.
 * Outputs both text/plain (markdown) and text/html (rich text).
 */
const copyHandler = EditorView.domEventHandlers({
  copy(event: ClipboardEvent, view: EditorView) {
    const clipboard = event.clipboardData
    if (!clipboard) return false

    const { from, to } = view.state.selection.main
    if (from === to) return false

    // Get selected text and format for clipboard
    const raw = view.state.sliceDoc(from, to)
    const markdown = formatDiffForClipboard(raw)
    const html = markdownToHtml(markdown)

    clipboard.setData('text/plain', markdown)
    clipboard.setData('text/html', html)

    event.preventDefault()
    return true
  },

  cut(event: ClipboardEvent, view: EditorView) {
    const clipboard = event.clipboardData
    if (!clipboard) return false

    const { from, to } = view.state.selection.main
    if (from === to) return false

    const raw = view.state.sliceDoc(from, to)
    const markdown = formatDiffForClipboard(raw)
    const html = markdownToHtml(markdown)

    clipboard.setData('text/plain', markdown)
    clipboard.setData('text/html', html)

    // Delete selection (respects edit filter - won't delete DEL regions)
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
    })

    event.preventDefault()
    return true
  },
})

// =============================================================================
// INPUT FILTER
// =============================================================================

/**
 * Input filter strips all markers on paste.
 * Prevents PUA markers from spreading.
 */
export const clipboardInputFilter = EditorView.clipboardInputFilter.of((text) =>
  stripMarkers(text)
)

// =============================================================================
// COMBINED EXTENSION
// =============================================================================

/**
 * Combined clipboard extension for the diff view.
 */
export const clipboardExtension = [copyHandler, clipboardInputFilter]
