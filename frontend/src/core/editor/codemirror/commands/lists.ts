/**
 * List Commands (Bullet & Ordered Lists)
 *
 * SOLID: Single Responsibility - Only handles list operations
 */

import type { EditorView } from '@codemirror/view'

// ============================================================================
// PATTERNS
// ============================================================================

const BULLET_PATTERN = /^(\s*)[-*+]\s/
const ORDERED_PATTERN = /^(\s*)\d+\.\s/

// ============================================================================
// LIST COMMANDS
// ============================================================================

/**
 * Toggle bullet list for selected lines
 */
export function toggleBulletList(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main

  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)

  const changes: { from: number; to: number; insert?: string }[] = []
  let allHaveBullets = true

  // Check if all lines have bullets
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = state.doc.line(i)
    if (!BULLET_PATTERN.test(line.text)) {
      allHaveBullets = false
      break
    }
  }

  // Toggle
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = state.doc.line(i)
    const match = BULLET_PATTERN.exec(line.text)

    if (allHaveBullets && match) {
      // Remove bullet
      changes.push({ from: line.from, to: line.from + match[0].length })
    } else if (!allHaveBullets) {
      // Add bullet (remove existing ordered if present)
      const orderedMatch = ORDERED_PATTERN.exec(line.text)
      if (orderedMatch) {
        const indent = orderedMatch[1] ?? ''
        changes.push({
          from: line.from,
          to: line.from + orderedMatch[0].length,
          insert: indent + '- ',
        })
      } else if (!BULLET_PATTERN.test(line.text)) {
        // Find leading whitespace
        const indentMatch = /^(\s*)/.exec(line.text)
        const indent = indentMatch?.[1] ?? ''
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length,
          insert: '- ',
        })
      }
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }

  return true
}

/**
 * Toggle ordered list for selected lines
 */
export function toggleOrderedList(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main

  const startLine = state.doc.lineAt(from)
  const endLine = state.doc.lineAt(to)

  const changes: { from: number; to: number; insert?: string }[] = []
  let allHaveNumbers = true

  // Check if all lines have numbers
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = state.doc.line(i)
    if (!ORDERED_PATTERN.test(line.text)) {
      allHaveNumbers = false
      break
    }
  }

  // Toggle
  let num = 1
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = state.doc.line(i)
    const match = ORDERED_PATTERN.exec(line.text)

    if (allHaveNumbers && match) {
      // Remove number
      changes.push({ from: line.from, to: line.from + match[0].length })
    } else if (!allHaveNumbers) {
      // Add number (remove existing bullet if present)
      const bulletMatch = BULLET_PATTERN.exec(line.text)
      if (bulletMatch) {
        const indent = bulletMatch[1] ?? ''
        changes.push({
          from: line.from,
          to: line.from + bulletMatch[0].length,
          insert: indent + `${num}. `,
        })
      } else if (!ORDERED_PATTERN.test(line.text)) {
        // Find leading whitespace
        const indentMatch = /^(\s*)/.exec(line.text)
        const indent = indentMatch?.[1] ?? ''
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length,
          insert: `${num}. `,
        })
      }
      num++
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }

  return true
}
