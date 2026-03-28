import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import { cursorOnLine } from "./cursor-utils"
import { hasRevealEffects, revealState } from "./reveal-state"

const hiddenSyntax = Decoration.replace({})
const blockquoteMark = Decoration.mark({ class: "md-blockquote" })

/**
 * Recursively collect all QuoteMark nodes at every nesting depth.
 * For `> > nested content`, the parser produces nested Blockquote nodes,
 * and `getChildren("QuoteMark")` only returns direct children. This
 * function descends into nested Blockquote children to find all markers.
 *
 * Returns marks in document order (ascending from) since we traverse
 * siblings left-to-right and recurse depth-first.
 */
function collectQuoteMarks(node: SyntaxNode): SyntaxNode[] {
  const marks: SyntaxNode[] = []
  let child = node.firstChild
  while (child) {
    if (child.type.name === "QuoteMark") {
      marks.push(child)
    } else if (child.type.name === "Blockquote") {
      marks.push(...collectQuoteMarks(child))
    }
    child = child.nextSibling
  }
  return marks
}

function buildBlockquoteDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  const revealed = view.state.field(revealState)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Blockquote") {
          return
        }

        // OR rule: if the entire blockquote range is in revealState, skip decoration
        const rangeKey = `${node.from}-${node.to}`
        if (revealed.has(rangeKey)) {
          return false
        }

        // Recursively collect ALL QuoteMarks at every nesting depth.
        // This handles nested blockquotes (> > text) where inner markers
        // are children of nested Blockquote nodes.
        const quoteMarks = collectQuoteMarks(node.node)
        const firstLine = view.state.doc.lineAt(node.from).number
        const lastLine = view.state.doc.lineAt(node.to).number

        // Process all lines and their QuoteMarks together so that
        // RangeSetBuilder additions stay in ascending `from` order.
        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
          if (cursorOnLine(view, lineNumber)) {
            continue
          }

          const line = view.state.doc.line(lineNumber)

          // Collect markers on this line, sorted ascending
          const lineMarks = quoteMarks.filter(
            (qm) => qm.from >= line.from && qm.from <= line.to
          )

          // Build decorations in ascending from-order:
          // line.from is always <= any QuoteMark.from on this line.
          // We need to interleave: mark segments between/after markers,
          // replace segments for markers themselves.
          let pos = line.from
          for (const qm of lineMarks) {
            // Style content before this marker
            if (pos < qm.from) {
              builder.add(pos, qm.from, blockquoteMark)
            }
            // Hide the marker
            builder.add(qm.from, qm.to, hiddenSyntax)
            pos = qm.to
          }
          // Style remaining content after last marker
          if (pos < line.to) {
            builder.add(pos, line.to, blockquoteMark)
          }
        }

        // Don't descend — we already handled all nested QuoteMarks above
        return false
      },
    })
  }

  return builder.finish()
}

class BlockquoteDecorations {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildBlockquoteDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildBlockquoteDecorations(update.view)
    }
  }
}

export function blockquoteDecorations(): Extension {
  return ViewPlugin.fromClass(BlockquoteDecorations, {
    decorations: (plugin) => plugin.decorations,
  })
}
