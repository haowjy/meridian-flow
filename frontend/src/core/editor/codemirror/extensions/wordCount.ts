/**
 * Word Count Extension
 *
 * SOLID: Single Responsibility - Only handles word counting
 */

import type { EditorState } from '@codemirror/state'
import type { WordCount } from '../types'

/**
 * Count words, characters, and paragraphs in editor content
 */
export function getWordCount(state: EditorState): WordCount {
  const text = state.doc.toString()

  // Characters (excluding whitespace for meaningful count)
  const characters = text.length

  // Words (split on whitespace, filter empty)
  const words = text
    .split(/\s+/)
    .filter(word => word.length > 0).length

  // Paragraphs (split on double newlines, filter empty)
  const paragraphs = text
    .split(/\n\n+/)
    .filter(para => para.trim().length > 0).length

  return { words, characters, paragraphs }
}
