import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

const listMarkDecoration = Decoration.mark({ class: "md-list-mark" })


function buildListDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "ListMark") {
          return
        }

        builder.add(node.from, node.to, listMarkDecoration)
      },
    })
  }

  return builder.finish()
}

class ListDecorations {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildListDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildListDecorations(update.view)
    }
  }
}

export function listDecorations(): Extension {
  return ViewPlugin.fromClass(ListDecorations, {
    decorations: (plugin) => plugin.decorations,
  })
}
