/**
 * Format Detection
 *
 * SOLID: Single Responsibility - Only detects active formats
 */

import type { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { FormatType } from '../types'

// ============================================================================
// FORMAT DETECTION
// ============================================================================

/**
 * Check if a format is active at the current cursor position
 */
export function isFormatActive(view: EditorView, format: FormatType): boolean {
  const { state } = view
  const { from, to } = state.selection.main

  switch (format) {
    case 'bold': {
      // Check if cursor is inside StrongEmphasis node
      let found = false
      syntaxTree(state).iterate({
        from,
        to: to + 1,
        enter(node) {
          if (node.name === 'StrongEmphasis') {
            if (node.from <= from && node.to >= to) {
              found = true
            }
          }
        },
      })
      return found
    }

    case 'italic': {
      let found = false
      syntaxTree(state).iterate({
        from,
        to: to + 1,
        enter(node) {
          if (node.name === 'Emphasis') {
            if (node.from <= from && node.to >= to) {
              found = true
            }
          }
        },
      })
      return found
    }

    case 'inlineCode': {
      let found = false
      syntaxTree(state).iterate({
        from,
        to: to + 1,
        enter(node) {
          if (node.name === 'InlineCode') {
            if (node.from <= from && node.to >= to) {
              found = true
            }
          }
        },
      })
      return found
    }

    case 'heading1':
    case 'heading2':
    case 'heading3': {
      const level = parseInt(format.replace('heading', ''))
      const line = state.doc.lineAt(from)
      const pattern = new RegExp(`^#{${level}}\\s`)
      return pattern.test(line.text)
    }

    case 'bulletList': {
      const line = state.doc.lineAt(from)
      return /^(\s*)[-*+]\s/.test(line.text)
    }

    case 'orderedList': {
      const line = state.doc.lineAt(from)
      return /^(\s*)\d+\.\s/.test(line.text)
    }

    case 'link': {
      let found = false
      syntaxTree(state).iterate({
        from,
        to: to + 1,
        enter(node) {
          if (node.name === 'Link') {
            if (node.from <= from && node.to >= to) {
              found = true
            }
          }
        },
      })
      return found
    }

    default:
      return false
  }
}
