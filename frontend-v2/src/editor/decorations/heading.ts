import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
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

// Line decorations style the entire .cm-line element (full-width heading
// styling including padding and margins), not just the text content.
// This matches Obsidian and SilverBullet's approach.
const headingLineDecorations = {
  1: Decoration.line({ class: "md-h1" }),
  2: Decoration.line({ class: "md-h2" }),
  3: Decoration.line({ class: "md-h3" }),
  4: Decoration.line({ class: "md-h4" }),
  5: Decoration.line({ class: "md-h5" }),
  6: Decoration.line({ class: "md-h6" }),
} as const

function headingLevel(nodeName: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (!nodeName.startsWith("ATXHeading")) {
    return null
  }

  const raw = Number.parseInt(nodeName.slice("ATXHeading".length), 10)
  if (Number.isNaN(raw)) {
    return null
  }

  return Math.max(1, Math.min(6, raw)) as 1 | 2 | 3 | 4 | 5 | 6
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const level = headingLevel(node.name)
        if (!level) {
          return
        }

        const line = view.state.doc.lineAt(node.from)

        // Always apply Decoration.line for heading-level font size/weight.
        // This persists even when revealed (editing a heading still shows
        // it at its heading size -- matches Obsidian behavior).
        builder.add(line.from, line.from, headingLineDecorations[level])

        // OR rule: reveal if cursor on line OR range is in revealState
        const revealed = view.state.field(revealState)
        const rangeKey = `${node.from}-${node.to}`
        if (cursorOnLine(view, line.number) || revealed.has(rangeKey)) {
          return
        }

        // Find where the heading text starts (after the FIRST marker).
        // Only use marks[0].to -- the parser may produce trailing HeaderMark
        // nodes (e.g., `# title #`), and using the last mark would skip
        // past the content entirely.
        const marks = node.node.getChildren("HeaderMark")
        if (marks.length === 0) {
          return
        }

        // Skip whitespace after leading marker
        const textStart = marks[0].to
        const doc = view.state.doc.sliceString(textStart, node.to)
        const trimOffset = doc.length - doc.trimStart().length
        const contentFrom = textStart + trimOffset

        // Additions must be in ascending `from` order for RangeSetBuilder.
        // Handle trailing HeaderMark (e.g., `# title #`) correctly:
        // 1. Hide leading mark
        // 2. Hide whitespace after leading mark
        // 3. Hide trailing marks (if any)

        // Step 1: Hide leading mark
        builder.add(marks[0].from, marks[0].to, hiddenSyntax)

        // Step 2: Hide whitespace between leading mark and content
        if (contentFrom > marks[0].to) {
          builder.add(marks[0].to, contentFrom, hiddenSyntax)
        }

        // Step 3: Hide trailing marks and any whitespace before them
        if (marks.length > 1) {
          // Hide whitespace between content and first trailing mark
          const contentEnd = marks[1].from
          const trailingText = view.state.doc.sliceString(
            contentFrom,
            contentEnd
          )
          const trimmedEnd = contentFrom + trailingText.trimEnd().length
          if (trimmedEnd < contentEnd) {
            builder.add(trimmedEnd, contentEnd, hiddenSyntax)
          }

          // Hide each trailing mark
          for (let i = 1; i < marks.length; i++) {
            builder.add(marks[i].from, marks[i].to, hiddenSyntax)
          }
        }
      },
    })
  }

  return builder.finish()
}

class HeadingDecorations {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildHeadingDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildHeadingDecorations(update.view)
    }
  }
}

export function headingDecorations(): Extension {
  return ViewPlugin.fromClass(HeadingDecorations, {
    decorations: (plugin) => plugin.decorations,
  })
}
