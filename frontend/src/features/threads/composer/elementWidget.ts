/**
 * Inline Element Widget
 *
 * Renders inline elements (references, future: images) as compact pill widgets.
 * Pattern follows HunkActionWidget.ts: raw DOM, ignoreEvent, eq for re-render control.
 *
 * Reference pill: [FileText icon] Chapter 5 [X]
 * - Compact: bg-muted, rounded, text-xs, max-width truncation
 * - title attribute shows full document path
 * - X button dispatches transaction deleting \uFFFC (decoration auto-removed)
 */

import { WidgetType, EditorView } from "@codemirror/view";
import type { InlineElementData } from "./inlineElements";

export class ElementWidget extends WidgetType {
  constructor(public readonly data: InlineElementData) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    if (this.data.type === "reference") {
      return this.renderReferencePill(view);
    }
    // Future: handle "image" type
    return this.renderReferencePill(view);
  }

  eq(other: ElementWidget): boolean {
    if (this.data.type !== other.data.type) return false;
    if (this.data.type === "reference" && other.data.type === "reference") {
      return this.data.documentId === other.data.documentId;
    }
    return false;
  }

  /** Let mousedown through to domEventHandlers for pill click handling.
   *  Other events (click, etc.) stay ignored so CM6 doesn't interfere
   *  with the remove button's direct onclick handler. */
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }

  private renderReferencePill(view: EditorView): HTMLElement {
    if (this.data.type !== "reference") {
      return document.createElement("span");
    }
    const data = this.data;
    const isEditable = view.state.facet(EditorView.editable);

    const pill = document.createElement("span");
    pill.className = "cm-inline-pill";
    const baseTitle = data.documentPath ?? data.displayName;
    pill.title = isEditable
      ? `${baseTitle}\nClick center to open, edge to place caret`
      : baseTitle;
    pill.setAttribute("role", "img");
    pill.setAttribute("aria-label", `Reference to ${data.displayName}`);
    // Store document ID for click handler lookup (avoids unreliable posAtDOM → decoration search)
    pill.dataset.documentId = data.documentId;
    // Prevent CM6 from treating pill as editable text
    pill.contentEditable = "false";

    // Icon — folder or file based on refType (simple SVG inline — avoids lucide-react dependency in raw DOM)
    const icon = document.createElement("span");
    icon.className = "cm-inline-pill-icon";
    icon.innerHTML =
      data.refType === "folder"
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
    pill.appendChild(icon);

    // Display name (truncated via CSS)
    const name = document.createElement("span");
    name.className = "cm-inline-pill-name";
    name.textContent = data.displayName;
    pill.appendChild(name);

    // Only show remove button in editable mode — no button in the DOM means
    // nothing to click or see in read-only/view mode
    if (isEditable) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "cm-inline-pill-remove";
      removeBtn.type = "button";
      removeBtn.title = "Remove reference";
      removeBtn.dataset.action = "remove";
      removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
      removeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Find the position of this widget's \uFFFC and delete it.
        // The StateField auto-cleans the decoration when \uFFFC is removed.
        const pos = view.posAtDOM(pill);
        if (pos >= 0 && pos < view.state.doc.length) {
          view.dispatch({
            changes: { from: pos, to: pos + 1 },
          });
        }
        view.focus();
      };
      pill.appendChild(removeBtn);
    }

    return pill;
  }
}
