import { syntaxTree } from "@codemirror/language"
import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateField,
  type Transaction,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view"

import { selectionIntersectsRange } from "./cursor-utils"
import { FencedCodeWidget } from "./fenced-code-widget"
import { focusChange, focusState } from "./focus-state"
import { MermaidWidget } from "./mermaid-widget"
import { concealElement, revealElement, revealState } from "./reveal-state"

/**
 * Check whether a transaction's changes touch any FencedCode syntax node.
 * This determines if we need a full rebuild vs cheap mapping.
 */
function changeAffectsBlocks(tr: Transaction): boolean {
  if (!tr.docChanged) return false

  const tree = syntaxTree(tr.state)
  let affects = false

  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (affects) return
    tree.iterate({
      from: fromB,
      to: toB,
      enter: (node) => {
        if (node.name === "FencedCode") {
          affects = true
          return false // stop iteration
        }
      },
    })
  })

  return affects
}

/**
 * Check whether the selection moved INTO, OUT OF, or BETWEEN block decoration
 * ranges. Tracks WHICH specific block the cursor is in (by position range),
 * not just a boolean "is in any block". Moving from code block A to code
 * block B triggers a rebuild (both blocks need to update their reveal state).
 */
function selectionCrossesBlockBoundary(
  tr: Transaction,
  currentDecos: DecorationSet,
): boolean {
  if (!tr.selection) return false

  const oldSel = tr.startState.selection.main
  const newSel = tr.state.selection.main

  // Find WHICH specific block each selection is in (null if not in any)
  let oldBlockKey: string | null = null
  let newBlockKey: string | null = null

  const cursor = currentDecos.iter()
  while (cursor.value) {
    const from = cursor.from
    const to = cursor.to
    if (oldSel.from >= from && oldSel.from <= to) {
      oldBlockKey = `${from}-${to}`
    }
    if (newSel.from >= from && newSel.from <= to) {
      newBlockKey = `${from}-${to}`
    }
    cursor.next()
  }

  // Rebuild when the specific block changes -- including block A -> block B
  return oldBlockKey !== newBlockKey
}

/**
 * Build all block-level decorations from the full syntax tree.
 * Walks the tree once, dispatching to per-node-type handlers for
 * FencedCode (with or without mermaid CodeInfo).
 */
function buildBlockDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(state)
  const revealed = state.field(revealState)
  const focused = state.field(focusState)

  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") {
        return
      }

      const from = node.from
      const to = node.to

      // OR rule: skip replacement if cursor is in range OR range is in revealState.
      // When unfocused AND no reveal active, always show preview.
      const rangeKey = `${from}-${to}`
      const isRevealed = revealed.has(rangeKey)
      const cursorInBlock = focused && selectionIntersectsRange(state, from, to, 0)

      if (isRevealed || cursorInBlock) {
        return false // skip this node, show raw markdown
      }

      // Extract language from CodeInfo child
      const codeInfo = node.node.getChild("CodeInfo")
      const language = codeInfo ? state.doc.sliceString(codeInfo.from, codeInfo.to).trim() : ""

      // Extract code content (between opening and closing fences)
      const codeMark = node.node.getChild("CodeMark")
      const lastCodeMark = node.node.lastChild
      if (!codeMark || !lastCodeMark) {
        return false
      }

      // Content is between the end of the first line (opening fence) and
      // the start of the closing fence line
      const openFenceLine = state.doc.lineAt(codeMark.from)
      const closeFenceLine = state.doc.lineAt(lastCodeMark.from)

      let code: string
      if (openFenceLine.number + 1 <= closeFenceLine.number - 1) {
        // There are content lines between fences
        const contentStart = state.doc.line(openFenceLine.number + 1).from
        const contentEnd = state.doc.line(closeFenceLine.number - 1).to
        code = state.doc.sliceString(contentStart, contentEnd)
      } else if (openFenceLine.number + 1 === closeFenceLine.number) {
        // Empty code block (fences are adjacent lines)
        code = ""
      } else {
        // Single-line code block (shouldn't happen with valid fenced code)
        code = ""
      }

      // Dispatch to widget type based on language
      const isMermaid = language.toLowerCase() === "mermaid"

      const widget = isMermaid
        ? new MermaidWidget(code)
        : new FencedCodeWidget(code, language)

      builder.add(
        from,
        to,
        Decoration.replace({
          widget,
          block: true,
        }),
      )

      return false // don't descend into children
    },
  })

  return builder.finish()
}

/**
 * Unified StateField for all block-level decorations (fenced code blocks
 * and mermaid diagrams).
 *
 * Uses StateField (NOT ViewPlugin) because:
 * - Multi-line Decoration.replace is forbidden in ViewPlugin
 * - Decoration.replace({ block: true }) requires StateField
 *
 * Incremental update strategy:
 * - Always map through changes first (O(changes), preserves positions)
 * - Full rebuild only when changes affect blocks, selection crosses
 *   a block boundary, or focus/reveal state changes
 */
export const blockDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildBlockDecorations(state)
  },

  update(decos, tr) {
    // Always map through changes first (cheap, preserves positions)
    const mapped = decos.map(tr.changes)

    // Full rebuild only when needed
    const needsRebuild =
      changeAffectsBlocks(tr) ||
      selectionCrossesBlockBoundary(tr, mapped) ||
      tr.effects.some(
        (e) =>
          e.is(focusChange) || e.is(revealElement) || e.is(concealElement),
      )

    return needsRebuild ? buildBlockDecorations(tr.state) : mapped
  },

  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Atomic ranges for block decorations. Ensures cursor movement
 * skips over the entire block widget rather than entering it.
 *
 * Boundaries exactly match replace decoration ranges to prevent
 * cursor getting stuck at boundaries (too wide) or entering hidden
 * content (too narrow).
 */
const blockAtomicRanges = EditorView.atomicRanges.of((view) => {
  return view.state.field(blockDecorationField)
})

/**
 * Extension that provides the block decoration StateField and its
 * atomic ranges. Include this in the editor extension stack.
 */
export function blockDecorations(): Extension[] {
  return [blockDecorationField, blockAtomicRanges]
}
