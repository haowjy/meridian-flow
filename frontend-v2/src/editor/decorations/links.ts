import { syntaxTree } from "@codemirror/language"
import { RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

import { safeExternalUrl } from "../url-validation"
import { cursorInRange } from "./cursor-utils"
import { hasRevealEffects, revealState } from "./reveal-state"

const hiddenSyntax = Decoration.replace({})

function buildLinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Link") {
          return
        }

        // OR rule: reveal if cursor in range (padding=0) OR range is in revealState.
        // Links use padding=0 because the cursor naturally enters link text
        // via arrow keys (links are NOT atomic), so proximity reveal triggers
        // automatically when the cursor is inside the link range.
        const revealed = view.state.field(revealState)
        const rangeKey = `${node.from}-${node.to}`
        if (cursorInRange(view, node.from, node.to, 0) || revealed.has(rangeKey)) {
          return
        }

        const marks = node.node.getChildren("LinkMark")
        const urlNode = node.node.getChild("URL")

        if (marks.length < 2 || !urlNode) {
          return
        }

        const textFrom = marks[0].to
        const textTo = marks[1].from
        if (textFrom >= textTo) {
          return
        }

        const rawUrl = view.state.doc.sliceString(urlNode.from, urlNode.to)
        const href = safeExternalUrl(rawUrl)

        // Additions must be in ascending `from` order for RangeSetBuilder
        builder.add(node.from, textFrom, hiddenSyntax)
        // Accessible link: role="link" for screen readers, tabindex="-1"
        // keeps it out of the tab order (Tab always indents text in the
        // editor, see design doc section 17).
        const attrs: Record<string, string> = {
          role: "link",
          tabindex: "-1",
        }
        if (href) {
          attrs["data-md-href"] = href
        }
        builder.add(
          textFrom,
          textTo,
          Decoration.mark({
            class: "md-link",
            attributes: attrs,
          })
        )
        builder.add(textTo, node.to, hiddenSyntax)
      },
    })
  }

  return builder.finish()
}

class LinkDecorations {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildLinkDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildLinkDecorations(update.view)
    }
  }
}

export function linkDecorations(): Extension {
  return ViewPlugin.fromClass(LinkDecorations, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event) {
        // Only open links on Cmd+Click (Mac) or Ctrl+Click (Windows/Linux).
        // Plain click places the cursor (normal CM6 behavior).
        if (!(event.metaKey || event.ctrlKey)) {
          return false
        }

        const target = event.target
        if (!(target instanceof HTMLElement)) {
          return false
        }

        const link = target.closest(".md-link")
        if (!link) {
          return false
        }

        const href = link.getAttribute("data-md-href")
        if (!href) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()
        window.open(href, "_blank", "noopener,noreferrer")
        return true
      },
    },
  })
}
