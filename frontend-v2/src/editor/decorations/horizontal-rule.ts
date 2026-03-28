import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"

import { cursorOnLine } from "./cursor-utils"
import { hasRevealEffects, revealState } from "./reveal-state"

class HorizontalRuleWidget extends WidgetType {
  eq(other: HorizontalRuleWidget): boolean {
    return other instanceof HorizontalRuleWidget
  }

  toDOM(): HTMLElement {
    // Wrap in div.md-hr-wrapper for context menu and keyboard handler targeting
    const wrapper = document.createElement("div")
    wrapper.className = "md-hr-wrapper"
    const hr = document.createElement("hr")
    hr.className = "md-hr"
    wrapper.append(hr)
    return wrapper
  }
}

function buildHorizontalRuleDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  const revealed = view.state.field(revealState)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "HorizontalRule") {
          return
        }

        const lineNumber = view.state.doc.lineAt(node.from).number

        // OR rule: reveal if cursor on line OR range is in revealState
        const rangeKey = `${node.from}-${node.to}`
        if (cursorOnLine(view, lineNumber) || revealed.has(rangeKey)) {
          return
        }

        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new HorizontalRuleWidget(),
          })
        )
      },
    })
  }

  return builder.finish()
}

class HorizontalRuleDecorationsPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildHorizontalRuleDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildHorizontalRuleDecorations(update.view)
    }
  }
}

export function horizontalRuleDecorations(): Extension {
  return ViewPlugin.fromClass(HorizontalRuleDecorationsPlugin, {
    decorations: (plugin) => plugin.decorations,
  })
}
