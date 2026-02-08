/**
 * Ref Icon Widget
 *
 * Minimal WidgetType that renders a small file icon (12x12) as a point widget
 * preceding wiki-link display text. Used with the mark-based decoration pattern
 * where display text is styled real text (Decoration.mark) rather than a replace widget.
 *
 * Also re-exports PillAIChangeType for backward compatibility with existing imports.
 */

import { WidgetType } from "@codemirror/view";

export type PillAIChangeType = "none" | "insertion" | "deletion";

// Inline SVG for FileText icon (12x12, matches elementWidget.ts)
const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;

export class RefIconWidget extends WidgetType {
  constructor(public readonly isBroken: boolean) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ref-icon";
    if (this.isBroken) {
      span.classList.add("cm-ref-icon-broken");
    }
    span.innerHTML = FILE_ICON_SVG;
    return span;
  }

  eq(other: RefIconWidget): boolean {
    return this.isBroken === other.isBroken;
  }

  /** Let mousedown through so click handler on .cm-inline-ref works */
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}
