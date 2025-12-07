import type { EditorView } from '@codemirror/view'
import type { EditorState, Transaction } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/**
 * Markdown formatting commands for CodeMirror 6.
 * Each command wraps selected text with markdown syntax.
 *
 * Design: Commands are pure functions that operate on EditorView.
 * They can be used directly or wrapped for React integration.
 */

// Helper: Get the current selection text and range
function getSelection(state: EditorState): { from: number; to: number; text: string } {
  const { from, to } = state.selection.main
  const text = state.sliceDoc(from, to)
  return { from, to, text }
}

// Helper: Apply a text replacement and move cursor
function replaceSelection(
  view: EditorView,
  from: number,
  to: number,
  insert: string,
  cursorOffset?: number
): boolean {
  const transaction: Transaction = view.state.update({
    changes: { from, to, insert },
    selection: cursorOffset !== undefined
      ? { anchor: from + cursorOffset }
      : { anchor: from + insert.length },
  })
  view.dispatch(transaction)
  return true
}

/**
 * Find a bold range (**...**) on the line that contains the given position.
 * Returns the absolute positions of the opening and closing markers.
 */
function findBoldRangeOnLine(
  lineText: string,
  lineFrom: number,
  cursorFrom: number,
  cursorTo: number
): { openStart: number; openEnd: number; closeStart: number; closeEnd: number } | null {
  // Find all ** positions in the line
  const markers: number[] = []
  let idx = 0
  while ((idx = lineText.indexOf('**', idx)) !== -1) {
    markers.push(idx)
    idx += 2
  }

  // Need at least 2 markers to form a pair
  if (markers.length < 2) return null

  // Convert cursor positions to line-relative
  const relFrom = cursorFrom - lineFrom
  const relTo = cursorTo - lineFrom

  // Find pairs and check if cursor is inside
  for (let i = 0; i < markers.length - 1; i += 2) {
    const openIdx = markers[i]
    const closeIdx = markers[i + 1]
    if (openIdx === undefined || closeIdx === undefined) continue

    // Check if cursor/selection is anywhere in the bold range (including markers)
    // This ensures clicking Bold works when cursor is at **hello**| (after closing **)
    if (relFrom >= openIdx && relTo <= closeIdx + 2) {
      return {
        openStart: lineFrom + openIdx,
        openEnd: lineFrom + openIdx + 2,
        closeStart: lineFrom + closeIdx,
        closeEnd: lineFrom + closeIdx + 2,
      }
    }
  }

  return null
}

/**
 * Find an italic range (*...*) on the line that contains the given position.
 * Must distinguish from bold (**).
 */
function findItalicRangeOnLine(
  lineText: string,
  lineFrom: number,
  cursorFrom: number,
  cursorTo: number
): { openStart: number; openEnd: number; closeStart: number; closeEnd: number } | null {
  // Find all single * positions (not part of **)
  const markers: number[] = []
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '*') {
      // Check it's not part of **
      const prevChar = i > 0 ? lineText[i - 1] : ''
      const nextChar = i < lineText.length - 1 ? lineText[i + 1] : ''
      if (prevChar !== '*' && nextChar !== '*') {
        markers.push(i)
      }
    }
  }

  if (markers.length < 2) return null

  const relFrom = cursorFrom - lineFrom
  const relTo = cursorTo - lineFrom

  // Find pairs
  for (let i = 0; i < markers.length - 1; i += 2) {
    const openIdx = markers[i]
    const closeIdx = markers[i + 1]
    if (openIdx === undefined || closeIdx === undefined) continue

    // Check if cursor/selection is anywhere in the italic range (including markers)
    if (relFrom >= openIdx && relTo <= closeIdx + 1) {
      return {
        openStart: lineFrom + openIdx,
        openEnd: lineFrom + openIdx + 1,
        closeStart: lineFrom + closeIdx,
        closeEnd: lineFrom + closeIdx + 1,
      }
    }
  }

  return null
}

/**
 * Toggle bold (**text**).
 * Uses line-based detection to find bold markers.
 * Preserves selection after toggle.
 */
export function toggleBold(view: EditorView): boolean {
  const { from, to, text } = getSelection(view.state)
  const doc = view.state.doc
  const line = doc.lineAt(from)

  // Check if cursor/selection is inside a bold range on this line
  const boldRange = findBoldRangeOnLine(line.text, line.from, from, to)

  if (boldRange) {
    // Remove the bold markers, preserve selection on content
    // Calculate new selection positions after removing opening marker
    const newAnchor = from - 2  // Shift left by 2 (opening ** removed)
    const newHead = to - 2      // Shift left by 2

    view.dispatch({
      changes: [
        { from: boldRange.openStart, to: boldRange.openEnd, insert: '' },
        { from: boldRange.closeStart, to: boldRange.closeEnd, insert: '' },
      ],
      selection: { anchor: newAnchor, head: newHead },
    })
    return true
  }

  // No selection - insert placeholder with cursor inside
  if (text.length === 0) {
    view.dispatch({
      changes: { from, to, insert: '****' },
      selection: { anchor: from + 2 },
    })
    return true
  }

  // Wrap selection in **, keep selection on the content
  view.dispatch({
    changes: { from, to, insert: `**${text}**` },
    selection: { anchor: from + 2, head: from + 2 + text.length },
  })
  return true
}

/**
 * Toggle italic (*text*).
 * Uses line-based detection to find italic markers.
 * Preserves selection after toggle.
 */
export function toggleItalic(view: EditorView): boolean {
  const { from, to, text } = getSelection(view.state)
  const doc = view.state.doc
  const line = doc.lineAt(from)

  // Check if cursor/selection is inside an italic range on this line
  const italicRange = findItalicRangeOnLine(line.text, line.from, from, to)

  if (italicRange) {
    // Remove the italic markers, preserve selection on content
    const newAnchor = from - 1  // Shift left by 1 (opening * removed)
    const newHead = to - 1

    view.dispatch({
      changes: [
        { from: italicRange.openStart, to: italicRange.openEnd, insert: '' },
        { from: italicRange.closeStart, to: italicRange.closeEnd, insert: '' },
      ],
      selection: { anchor: newAnchor, head: newHead },
    })
    return true
  }

  // No selection - insert placeholder with cursor inside
  if (text.length === 0) {
    view.dispatch({
      changes: { from, to, insert: '**' },
      selection: { anchor: from + 1 },
    })
    return true
  }

  // Wrap selection in *, keep selection on the content
  view.dispatch({
    changes: { from, to, insert: `*${text}*` },
    selection: { anchor: from + 1, head: from + 1 + text.length },
  })
  return true
}

/**
 * Toggle heading at the specified level (1-6).
 * Operates on the entire line containing the selection.
 */
export function toggleHeading(view: EditorView, level: 1 | 2 | 3 | 4 | 5 | 6): boolean {
  const { from } = getSelection(view.state)
  const line = view.state.doc.lineAt(from)
  const lineText = line.text

  // Check current heading level
  const headingMatch = lineText.match(/^(#{1,6})\s/)
  const currentLevel = headingMatch && headingMatch[1] ? headingMatch[1].length : 0
  const prefix = '#'.repeat(level) + ' '

  if (currentLevel === level) {
    // Same level: remove heading
    const textWithoutHeading = lineText.replace(/^#{1,6}\s/, '')
    return replaceSelection(view, line.from, line.to, textWithoutHeading)
  } else if (currentLevel > 0) {
    // Different level: replace
    const textWithoutHeading = lineText.replace(/^#{1,6}\s/, '')
    return replaceSelection(view, line.from, line.to, prefix + textWithoutHeading)
  } else {
    // No heading: add
    return replaceSelection(view, line.from, line.to, prefix + lineText)
  }
}

/**
 * Toggle bullet list for selected lines.
 * If all lines have bullets, removes them. Otherwise adds them.
 */
export function toggleBulletList(view: EditorView): boolean {
  const { from, to } = getSelection(view.state)
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)

  // Gather all lines in selection
  const lines: { from: number; to: number; text: string }[] = []
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i)
    lines.push({ from: line.from, to: line.to, text: line.text })
  }

  // Check if all lines have bullet markers
  const bulletPattern = /^(\s*)[-*+]\s/
  const allBulleted = lines.every((l) => bulletPattern.test(l.text))

  // Build changes from end to start (to preserve positions)
  const changes: { from: number; to: number; insert: string }[] = []

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue

    if (allBulleted) {
      // Remove bullet
      const newText = line.text.replace(bulletPattern, '$1')
      changes.push({ from: line.from, to: line.to, insert: newText })
    } else {
      // Add bullet if not already present
      if (!bulletPattern.test(line.text)) {
        const match = line.text.match(/^(\s*)/)
        const indent = match && match[1] !== undefined ? match[1] : ''
        const textContent = line.text.slice(indent.length)
        changes.push({ from: line.from, to: line.to, insert: `${indent}- ${textContent}` })
      }
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }
  return true
}

/**
 * Toggle ordered list for selected lines.
 * If all lines have numbers, removes them. Otherwise adds them.
 */
export function toggleOrderedList(view: EditorView): boolean {
  const { from, to } = getSelection(view.state)
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)

  // Gather all lines in selection
  const lines: { from: number; to: number; text: string }[] = []
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i)
    lines.push({ from: line.from, to: line.to, text: line.text })
  }

  // Check if all lines have ordered list markers
  const orderedPattern = /^(\s*)\d+\.\s/
  const allOrdered = lines.every((l) => orderedPattern.test(l.text))

  // Build changes from end to start
  const changes: { from: number; to: number; insert: string }[] = []

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    const lineIndex = i // Use index for numbering

    if (allOrdered) {
      // Remove number
      const newText = line.text.replace(orderedPattern, '$1')
      changes.push({ from: line.from, to: line.to, insert: newText })
    } else {
      // Add number if not already present
      if (!orderedPattern.test(line.text)) {
        const match = line.text.match(/^(\s*)/)
        const indent = match && match[1] !== undefined ? match[1] : ''
        const textContent = line.text.slice(indent.length)
        changes.push({ from: line.from, to: line.to, insert: `${indent}${lineIndex + 1}. ${textContent}` })
      }
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }
  return true
}

/**
 * Insert or wrap inline code (`code`).
 */
export function toggleInlineCode(view: EditorView): boolean {
  const { from, to, text } = getSelection(view.state)

  // Check if already code
  const isCode = text.startsWith('`') && text.endsWith('`') && text.length >= 2

  if (isCode) {
    // Remove ` markers
    const inner = text.slice(1, -1)
    return replaceSelection(view, from, to, inner)
  } else if (text.length === 0) {
    // No selection: insert placeholder
    return replaceSelection(view, from, to, '``', 1)
  } else {
    // Wrap selection
    return replaceSelection(view, from, to, `\`${text}\``)
  }
}

/**
 * Insert a link [text](url).
 * If text is selected, wraps it as the link text.
 */
export function insertLink(view: EditorView): boolean {
  const { from, to, text } = getSelection(view.state)

  if (text.length === 0) {
    // No selection: insert placeholder
    const link = '[link text](url)'
    replaceSelection(view, from, to, link)
    // Select "link text" for easy replacement
    const linkTextFrom = from + 1
    const linkTextTo = linkTextFrom + 9
    view.dispatch({
      selection: { anchor: linkTextFrom, head: linkTextTo },
    })
    return true
  } else {
    // Wrap selection as link text
    const link = `[${text}](url)`
    replaceSelection(view, from, to, link)
    // Select "url" for easy replacement
    const urlFrom = from + text.length + 3
    const urlTo = urlFrom + 3
    view.dispatch({
      selection: { anchor: urlFrom, head: urlTo },
    })
    return true
  }
}

/**
 * Check if the selection/cursor is within a format.
 * Uses the Lezer syntax tree for accurate bold/italic detection.
 * Used for toolbar button active states.
 */
export function isFormatActive(view: EditorView, format: 'bold' | 'italic' | 'heading' | 'bulletList' | 'orderedList', level?: number): boolean {
  const { from, to } = getSelection(view.state)

  switch (format) {
    case 'bold': {
      // Use syntax tree to check if cursor is inside StrongEmphasis node
      let isBold = false
      const tree = syntaxTree(view.state)
      tree.iterate({
        from,
        to: Math.max(to, from + 1), // Ensure we have a range to iterate
        enter: (node) => {
          if (node.type.name === 'StrongEmphasis') {
            isBold = true
            return false // Stop iteration
          }
        },
      })
      return isBold
    }
    case 'italic': {
      // Use syntax tree to check if cursor is inside Emphasis node (not StrongEmphasis)
      let isItalic = false
      const tree = syntaxTree(view.state)
      tree.iterate({
        from,
        to: Math.max(to, from + 1),
        enter: (node) => {
          if (node.type.name === 'Emphasis') {
            isItalic = true
            return false
          }
        },
      })
      return isItalic
    }
    case 'heading': {
      const line = view.state.doc.lineAt(from)
      const match = line.text.match(/^(#{1,6})\s/)
      if (!match || !match[1]) return false
      if (level !== undefined) {
        return match[1].length === level
      }
      return true
    }
    case 'bulletList': {
      const line = view.state.doc.lineAt(from)
      return /^(\s*)[-*+]\s/.test(line.text)
    }
    case 'orderedList': {
      const line = view.state.doc.lineAt(from)
      return /^(\s*)\d+\.\s/.test(line.text)
    }
    default:
      return false
  }
}
