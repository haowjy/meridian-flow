import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import { cursorInRange } from "./cursor-utils"
import { hasRevealEffects, revealState } from "./reveal-state"

const hiddenSyntax = Decoration.replace({})
const strongMark = Decoration.mark({ class: "md-strong" })
const emphasisMark = Decoration.mark({ class: "md-emphasis" })

function buildEmphasisDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  const revealed = view.state.field(revealState)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "StrongEmphasis" && node.name !== "Emphasis") {
          return
        }

        // OR rule: reveal if cursor in range OR range is in revealState
        const rangeKey = `${node.from}-${node.to}`
        if (cursorInRange(view, node.from, node.to) || revealed.has(rangeKey)) {
          return
        }

        const marks = node.node.getChildren("EmphasisMark")
        if (marks.length < 2) {
          return
        }

        const contentMark = node.name === "StrongEmphasis" ? strongMark : emphasisMark

        // Non-overlapping pattern: replace(marker1) -> mark(content) -> replace(marker2)
        // Additions must be in ascending `from` order for RangeSetBuilder
        const openMark = marks[0]
        const closeMark = marks[marks.length - 1]

        builder.add(openMark.from, openMark.to, hiddenSyntax)
        if (openMark.to < closeMark.from) {
          builder.add(openMark.to, closeMark.from, contentMark)
        }
        builder.add(closeMark.from, closeMark.to, hiddenSyntax)
      },
    })
  }

  return builder.finish()
}

class EmphasisDecorations {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildEmphasisDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildEmphasisDecorations(update.view)
    }
  }
}

export function emphasisDecorations(): Extension {
  return ViewPlugin.fromClass(EmphasisDecorations, {
    decorations: (plugin) => plugin.decorations,
  })
}
