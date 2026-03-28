import { WidgetType } from "@codemirror/view"

/**
 * Widget that renders a fenced code block as a styled <pre><code> element.
 *
 * Uses textContent (NEVER innerHTML) to insert code content -- explicit
 * defense against injection in collaborative editing where remote peers
 * can set arbitrary code block content.
 */
export class FencedCodeWidget extends WidgetType {
  code: string
  language: string

  constructor(code: string, language: string) {
    super()
    this.code = code
    this.language = language
  }

  eq(other: FencedCodeWidget): boolean {
    return this.code === other.code && this.language === other.language
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("pre")
    wrapper.className = "md-code-block md-widget-wrapper"

    // Language label (top-right, subtle)
    if (this.language) {
      const label = document.createElement("span")
      label.className = "md-code-block-lang"
      label.textContent = this.language
      wrapper.appendChild(label)
    }

    // Copy button (hover affordance)
    const overlay = document.createElement("div")
    overlay.className = "md-widget-overlay md-code-block-actions"

    const copyBtn = document.createElement("button")
    copyBtn.className = "md-code-copy-btn"
    copyBtn.textContent = "Copy"
    copyBtn.type = "button"
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      navigator.clipboard.writeText(this.code).then(() => {
        copyBtn.textContent = "Copied!"
        setTimeout(() => {
          copyBtn.textContent = "Copy"
        }, 1500)
      })
    })
    overlay.appendChild(copyBtn)
    wrapper.appendChild(overlay)

    // Code content -- MUST use textContent, never innerHTML
    const codeEl = document.createElement("code")
    codeEl.className = "md-code-block-code"
    codeEl.textContent = this.code
    wrapper.appendChild(codeEl)

    return wrapper
  }

  get estimatedHeight(): number {
    const lineCount = this.code.split("\n").length
    // Approximate: lineHeight ~24px + padding 28px (top+bottom)
    return lineCount * 24 + 28
  }

  ignoreEvent(): boolean {
    return false
  }
}
