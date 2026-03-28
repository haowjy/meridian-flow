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

import { type SafeImageResult, safeImageUrl } from "../url-validation"
import { cursorOnLine } from "./cursor-utils"
import { hasRevealEffects, revealState } from "./reveal-state"

class ImageWidget extends WidgetType {
  private readonly result: SafeImageResult
  private readonly alt: string

  constructor(result: SafeImageResult, alt: string) {
    super()
    this.result = result
    this.alt = alt
  }

  eq(other: ImageWidget): boolean {
    return (
      this.result.type === other.result.type &&
      this.result.href === other.result.href &&
      this.alt === other.alt
    )
  }

  // Prevent scroll position jumps when images are outside the viewport.
  // CM6 uses this estimate for height map calculations until the actual
  // DOM element is measured.
  get estimatedHeight(): number {
    return 200
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("figure")
    wrapper.className = "md-image-wrapper"

    const image = document.createElement("img")
    image.className = "md-image"
    image.src = this.result.href
    image.alt = this.alt
    image.loading = "lazy"
    // Images with loading="lazy" change height from 0 to actual on load.
    // requestMeasure updates CM6's height map to prevent scroll jumps.
    image.addEventListener("load", () => {
      view.requestMeasure()
    })
    wrapper.append(image)

    // Only open image on Cmd/Ctrl+Click, not on every click
    wrapper.addEventListener("mousedown", (event) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      window.open(this.result.href, "_blank", "noopener,noreferrer")
    })

    return wrapper
  }

  ignoreEvent(): boolean {
    return false
  }
}

const hiddenSyntax = Decoration.replace({})

function buildImageDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  const revealed = view.state.field(revealState)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Image") {
          return
        }

        const marks = node.node.getChildren("LinkMark")
        const urlNode = node.node.getChild("URL")
        if (marks.length < 2 || !urlNode) {
          return
        }

        const alt = view.state.doc.sliceString(marks[0].to, marks[1].from)
        const rawUrl = view.state.doc.sliceString(urlNode.from, urlNode.to)
        const result = safeImageUrl(rawUrl)
        if (!result) {
          return
        }

        const lineNumber = view.state.doc.lineAt(node.from).number

        // OR rule: reveal if cursor on line OR range is in revealState
        const rangeKey = `${node.from}-${node.to}`
        const isRevealed = cursorOnLine(view, lineNumber) || revealed.has(rangeKey)

        // When cursor is away and not explicitly revealed: hide the ![alt](url) syntax
        if (!isRevealed) {
          builder.add(node.from, node.to, hiddenSyntax)
        }

        // Always: render the image widget after the syntax
        builder.add(
          node.to,
          node.to,
          Decoration.widget({
            widget: new ImageWidget(result, alt),
            side: 1,
          })
        )
      },
    })
  }

  return builder.finish()
}

class ImageDecorationsPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildImageDecorations(view)
  }

  update(update: ViewUpdate) {
    // Map decorations through changes first so positions stay valid
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
    // Skip expensive full rebuild during IME composition
    if (update.view.composing) return
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || hasRevealEffects(update)) {
      this.decorations = buildImageDecorations(update.view)
    }
  }
}

export function imageDecorations(): Extension {
  return ViewPlugin.fromClass(ImageDecorationsPlugin, {
    decorations: (plugin) => plugin.decorations,
  })
}
