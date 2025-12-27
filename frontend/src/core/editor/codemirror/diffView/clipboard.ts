/**
 * Clipboard Sanitization
 *
 * SRP: Strips PUA markers from clipboard operations.
 * Prevents markers from spreading via copy/paste.
 */

import { EditorView } from '@codemirror/view'
import { stripMarkers } from '@/features/documents/utils/mergedDocument'

// =============================================================================
// CLIPBOARD FILTERS
// =============================================================================

/**
 * Clipboard output filter - strips markers when copying/cutting.
 */
export const clipboardOutputFilter = EditorView.clipboardOutputFilter.of(
  (text) => stripMarkers(text)
)

/**
 * Clipboard input filter - strips markers when pasting.
 */
export const clipboardInputFilter = EditorView.clipboardInputFilter.of(
  (text) => stripMarkers(text)
)

// =============================================================================
// COMBINED EXTENSION
// =============================================================================

/**
 * Combined clipboard extension for the diff view.
 */
export const clipboardExtension = [
  clipboardOutputFilter,
  clipboardInputFilter,
]
