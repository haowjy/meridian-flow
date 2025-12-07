import { StateField, StateEffect } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import type { WordCount } from '../types'

/**
 * StateField for tracking word count statistics.
 * Recalculates on document changes.
 *
 * Design: Uses StateField (not Facet) because:
 * 1. Computed from document content (not config)
 * 2. Should update reactively on doc changes
 * 3. Needs to be efficiently cached between updates
 */

// Effect to force recalculation (if needed)
export const recalculateWordCount = StateEffect.define<void>()

/**
 * Calculate word count from text.
 */
function calculateWordCount(text: string): WordCount {
  // Words: split by whitespace, filter empty
  const words = text.split(/\s+/).filter((w) => w.length > 0).length

  // Characters: total length
  const characters = text.length

  // Paragraphs: split by double newline
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length

  return { words, characters, paragraphs }
}

/**
 * StateField that tracks word count.
 */
export const wordCountField = StateField.define<WordCount>({
  create(state: EditorState): WordCount {
    return calculateWordCount(state.doc.toString())
  },

  update(value: WordCount, tr): WordCount {
    // Only recalculate if document changed
    if (tr.docChanged) {
      return calculateWordCount(tr.newDoc.toString())
    }
    return value
  },
})

/**
 * Get word count from editor state.
 * Returns { words: 0, characters: 0, paragraphs: 0 } if field not present.
 */
export function getWordCount(state: EditorState): WordCount {
  return state.field(wordCountField, false) ?? { words: 0, characters: 0, paragraphs: 0 }
}
