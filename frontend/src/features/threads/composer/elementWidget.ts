/**
 * Inline Element Widget
 *
 * Renders inline elements (references, future: images) as compact pill widgets.
 * Pattern follows HunkActionWidget.ts: raw DOM, ignoreEvent, eq for re-render control.
 *
 * DOM creation delegates to the shared `createPillElement()` — visual design
 * is defined once in `shared/reference-pill/`. This file owns the CM6 Widget
 * lifecycle (eq, ignoreEvent, toDOM).
 */

import { WidgetType, EditorView } from "@codemirror/view";
import { createPillElement } from "@/shared/reference-pill";
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

    // Create pill, then wire up onRemove using the pill element for posAtDOM
    const pill = createPillElement({
      displayName: data.displayName,
      iconType: data.refType === "folder" ? "folder" : "file",
      documentId: data.documentId,
      documentPath: data.documentPath,
      editable: isEditable,
      onRemove: isEditable
        ? () => {
            // Find the position of this widget's \uFFFC and delete it.
            // The StateField auto-cleans the decoration when \uFFFC is removed.
            const pos = view.posAtDOM(pill);
            if (pos >= 0 && pos < view.state.doc.length) {
              view.dispatch({
                changes: { from: pos, to: pos + 1 },
              });
            }
            view.focus();
          }
        : undefined,
    });

    return pill;
  }
}
