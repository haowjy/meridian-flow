import type { EditorView } from "@codemirror/view"
import { WidgetType } from "@codemirror/view"

/**
 * Simple hash for cache keys. FNV-1a 32-bit.
 */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) | 0
  }
  return hash.toString(36)
}

/**
 * Lazy loader for mermaid.js. Singleton promise ensures only one import
 * even when multiple mermaid blocks enter the viewport simultaneously.
 */
let mermaidPromise: Promise<typeof import("mermaid")> | null = null

function getMermaid(): Promise<typeof import("mermaid")> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        securityLevel: "sandbox", // MANDATORY -- renders in sandboxed iframe
        theme: "neutral",
        startOnLoad: false, // we control render timing
      })
      return m
    })
  }
  return mermaidPromise
}

/**
 * Render queue with concurrency limit and SVG cache.
 * Prevents main thread freeze when multiple diagrams render simultaneously.
 */
export class MermaidRenderQueue {
  private queue: Array<{
    id: string
    source: string
    resolve: (svg: string) => void
    reject: (e: Error) => void
  }> = []
  private active = 0
  private readonly maxConcurrent = 2
  private cache = new Map<string, string>()
  private readonly maxCacheSize = 50
  // Monotonic counter -- Date.now() can produce duplicates when two
  // renders are queued in the same millisecond (fast scroll)
  private nextRenderId = 0

  async render(source: string): Promise<string> {
    const hash = simpleHash(source)
    const cached = this.cache.get(hash)
    if (cached) return cached

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: `mermaid-${this.nextRenderId++}`,
        source,
        resolve,
        reject,
      })
      this.drain()
    })
  }

  private async drain(): Promise<void> {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!
      this.active++
      try {
        const mermaid = await getMermaid()
        const { svg } = await mermaid.default.render(item.id, item.source)
        const hash = simpleHash(item.source)
        this.cache.set(hash, svg)
        if (this.cache.size > this.maxCacheSize) {
          // Evict oldest entry
          const firstKey = this.cache.keys().next().value
          if (firstKey !== undefined) {
            this.cache.delete(firstKey)
          }
        }
        item.resolve(svg)
      } catch (e) {
        item.reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        this.active--
        this.drain()
      }
    }
  }
}

/** Module-level singleton render queue */
const mermaidQueue = new MermaidRenderQueue()

// Re-export for testing
export { mermaidQueue }

/**
 * Widget that renders a mermaid diagram as SVG via mermaid.js.
 *
 * Uses sandbox mode (securityLevel: "sandbox") which renders SVG
 * inside an <iframe> sandbox, preventing XSS from malicious diagram
 * source injected by collaborators.
 */
export class MermaidWidget extends WidgetType {
  source: string
  private destroyed = false

  constructor(source: string) {
    super()
    this.source = source
  }

  eq(other: MermaidWidget): boolean {
    return this.source === other.source
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div")
    container.className = "md-mermaid-block md-widget-wrapper"
    container.setAttribute("role", "img")
    container.setAttribute("aria-label", "Mermaid diagram")

    // Loading placeholder
    const placeholder = document.createElement("div")
    placeholder.className = "md-mermaid-placeholder"
    placeholder.textContent = "Rendering diagram..."
    container.appendChild(placeholder)

    // Hover affordance
    const overlay = document.createElement("div")
    overlay.className = "md-widget-overlay"
    const editIcon = document.createElement("span")
    editIcon.textContent = "Edit"
    editIcon.className = "md-code-copy-btn"
    overlay.appendChild(editIcon)
    container.appendChild(overlay)

    mermaidQueue
      .render(this.source)
      .then((svg) => {
        if (this.destroyed) return

        // In sandbox mode, mermaid returns an iframe srcdoc.
        // Validate that the returned string IS an iframe before innerHTML.
        // This guards against mermaid versions that bypass sandbox mode.
        if (!svg.trimStart().startsWith("<iframe")) {
          // Refuse to inject raw SVG -- potential XSS vector
          throw new Error(
            "Mermaid did not return sandboxed iframe -- refusing to inject raw SVG",
          )
        }
        placeholder.remove()
        const svgContainer = document.createElement("div")
        svgContainer.className = "md-mermaid-svg"
        svgContainer.innerHTML = svg
        container.insertBefore(svgContainer, overlay)
        view.requestMeasure()
      })
      .catch(() => {
        if (this.destroyed) return
        placeholder.textContent = "Diagram render failed"
      })

    return container
  }

  get estimatedHeight(): number {
    const lineCount = this.source.split("\n").length
    // Mermaid diagrams are typically taller than line count suggests
    return lineCount * 20 + 60
  }

  destroy(): void {
    this.destroyed = true
  }

  ignoreEvent(): boolean {
    return false
  }
}
