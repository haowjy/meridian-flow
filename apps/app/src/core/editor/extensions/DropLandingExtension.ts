/**
 * The drop door and its promise.
 *
 * Two plugins, one resolution (`../table-drop.ts`): a drop whose raw position
 * is table-structural lands inside the nearest cell's paragraph or refuses,
 * and the dropcursor drawn during the drag asks the same question — so the
 * caret the writer sees during a drag over a table is exactly where the
 * content will stand. Everywhere else both plugins defer to ProseMirror's
 * stock resolution, unchanged.
 *
 * The cursor view is prosemirror-dropcursor's, carried here because its target
 * arithmetic is not pluggable: the stock plugin computes its own `dropPoint`,
 * which is the function that approves the illegal seam in the first place.
 * Replacing the display without replacing the landing (or the reverse) would
 * be a promise the drop betrays.
 */

import { Extension } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { type EditorState, type NodeSelection, Plugin } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import { seamDropTransaction, seamHostableSlice, tableDropDecision } from "../table-drop";

/** Matches the block drag's jade drop line (`--color-primary`, 2px). */
const CURSOR_COLOR = "var(--color-primary)";
const CURSOR_WIDTH = 2;

/**
 * The drag's source selection, when the drag carries a single node. ProseMirror
 * keeps it on `view.dragging` for its own drop handler but leaves it out of the
 * public type; without it a moved node's deletion would fall back to whatever
 * the document selection happens to be.
 */
function draggedNodeSelection(view: EditorView): NodeSelection | null {
  const dragging = view.dragging as { node?: NodeSelection } | null;
  return dragging?.node ?? null;
}

function dropLandingPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDrop(view, event, slice, moved) {
        // A file drop is the image door's (`images/ImageIngressExtension.ts`),
        // which routes its own landing through the same resolution.
        if (event.dataTransfer && event.dataTransfer.files.length > 0) return false;
        const decision = tableDropDecision(view, { x: event.clientX, y: event.clientY });
        if (decision.kind === "default") return false;
        if (decision.kind === "refuse") return true;
        const transaction = seamDropTransaction(view.state, decision.pos, slice, {
          moved,
          node: draggedNodeSelection(view),
        });
        // A slice no cell can host: the drop is consumed and nothing moves,
        // which is the refusal the hidden dropcursor already showed.
        if (!transaction) return true;
        view.focus();
        view.dispatch(transaction);
        return true;
      },
    },
  });
}

/**
 * Where the dropcursor should draw for a drag at `(x, y)`, or null for no
 * cursor. The one place display and landing could disagree, so it asks the
 * landing's own resolution first.
 */
function dropCursorTarget(view: EditorView, event: DragEvent): number | null {
  const { clientX: x, clientY: y } = event;
  const pos = view.posAtCoords({ left: x, top: y });
  if (!pos) return null;
  const inside = pos.inside >= 0 ? view.state.doc.nodeAt(pos.inside) : null;
  const disable = inside?.type.spec.disableDropCursor;
  const disabled = typeof disable === "function" ? disable(view, pos, event) : disable;
  if (disabled) return null;

  const slice: Slice | null = view.dragging?.slice ?? null;
  const decision = tableDropDecision(view, { x, y });
  if (decision.kind === "refuse") return null;
  if (decision.kind === "snap") {
    return seamHostableSlice(slice) ? decision.pos : null;
  }
  if (!slice) return pos.pos;
  return dropPoint(view.state.doc, pos.pos, slice) ?? pos.pos;
}

/**
 * prosemirror-dropcursor's view, with `dragover` asking `dropCursorTarget`
 * instead of computing its own landing. Everything else — the block line, the
 * inline caret, the scale handling, the removal timers — is the vendor's.
 */
class DropCursorView {
  private cursorPos: number | null = null;
  private element: HTMLElement | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly handlers: { name: string; handler: (event: Event) => void }[];

  constructor(private readonly editorView: EditorView) {
    this.handlers = (["dragover", "dragend", "drop", "dragleave"] as const).map((name) => {
      const handler = (event: Event) => {
        this[name](event as DragEvent);
      };
      editorView.dom.addEventListener(name, handler);
      return { name, handler };
    });
  }

  destroy() {
    for (const { name, handler } of this.handlers) {
      this.editorView.dom.removeEventListener(name, handler);
    }
    this.setCursor(null);
  }

  update(editorView: EditorView, prevState: EditorState) {
    if (this.cursorPos != null && prevState.doc !== editorView.state.doc) {
      if (this.cursorPos > editorView.state.doc.content.size) this.setCursor(null);
      else this.updateOverlay();
    }
  }

  private setCursor(pos: number | null) {
    if (pos === this.cursorPos) return;
    this.cursorPos = pos;
    if (pos == null) {
      this.element?.remove();
      this.element = null;
    } else {
      this.updateOverlay();
    }
  }

  private updateOverlay() {
    if (this.cursorPos == null) return;
    const $pos = this.editorView.state.doc.resolve(this.cursorPos);
    const isBlock = !$pos.parent.inlineContent;
    const editorDOM = this.editorView.dom;
    const editorRect = editorDOM.getBoundingClientRect();
    const scaleX = editorRect.width / editorDOM.offsetWidth;
    const scaleY = editorRect.height / editorDOM.offsetHeight;
    let rect: { left: number; right: number; top: number; bottom: number } | undefined;
    if (isBlock) {
      const before = $pos.nodeBefore;
      const after = $pos.nodeAfter;
      if (before || after) {
        const node = this.editorView.nodeDOM(this.cursorPos - (before ? before.nodeSize : 0));
        if (node instanceof HTMLElement) {
          const nodeRect = node.getBoundingClientRect();
          let top = before ? nodeRect.bottom : nodeRect.top;
          if (before && after) {
            const afterDOM = this.editorView.nodeDOM(this.cursorPos);
            if (afterDOM instanceof HTMLElement) {
              top = (top + afterDOM.getBoundingClientRect().top) / 2;
            }
          }
          const halfWidth = (CURSOR_WIDTH / 2) * scaleY;
          rect = {
            left: nodeRect.left,
            right: nodeRect.right,
            top: top - halfWidth,
            bottom: top + halfWidth,
          };
        }
      }
    }
    if (!rect) {
      const coords = this.editorView.coordsAtPos(this.cursorPos);
      const halfWidth = (CURSOR_WIDTH / 2) * scaleX;
      rect = {
        left: coords.left - halfWidth,
        right: coords.left + halfWidth,
        top: coords.top,
        bottom: coords.bottom,
      };
    }

    const parent = this.editorView.dom.offsetParent as HTMLElement | null;
    if (!this.element) {
      const host = parent ?? this.editorView.dom.ownerDocument.body;
      this.element = host.appendChild(document.createElement("div"));
      this.element.style.cssText = "position: absolute; z-index: 50; pointer-events: none;";
      this.element.style.backgroundColor = CURSOR_COLOR;
    }
    this.element.classList.toggle("prosemirror-dropcursor-block", isBlock);
    this.element.classList.toggle("prosemirror-dropcursor-inline", !isBlock);
    let parentLeft: number;
    let parentTop: number;
    if (!parent || (parent === document.body && getComputedStyle(parent).position === "static")) {
      parentLeft = -window.scrollX;
      parentTop = -window.scrollY;
    } else {
      const parentRect = parent.getBoundingClientRect();
      const parentScaleX = parentRect.width / parent.offsetWidth;
      const parentScaleY = parentRect.height / parent.offsetHeight;
      parentLeft = parentRect.left - parent.scrollLeft * parentScaleX;
      parentTop = parentRect.top - parent.scrollTop * parentScaleY;
    }
    this.element.style.left = `${(rect.left - parentLeft) / scaleX}px`;
    this.element.style.top = `${(rect.top - parentTop) / scaleY}px`;
    this.element.style.width = `${(rect.right - rect.left) / scaleX}px`;
    this.element.style.height = `${(rect.bottom - rect.top) / scaleY}px`;
  }

  private scheduleRemoval(timeout: number) {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.setCursor(null), timeout);
  }

  private dragover(event: DragEvent) {
    if (!this.editorView.editable) return;
    const target = dropCursorTarget(this.editorView, event);
    this.setCursor(target);
    if (target != null) this.scheduleRemoval(5000);
  }

  private dragend() {
    this.scheduleRemoval(20);
  }

  private drop() {
    this.scheduleRemoval(20);
  }

  private dragleave(event: DragEvent) {
    const related = event.relatedTarget as Node | null;
    if (!related || !this.editorView.dom.contains(related)) this.setCursor(null);
  }
}

function dropCursorPlugin(): Plugin {
  return new Plugin({
    view: (editorView) => new DropCursorView(editorView),
  });
}

export const DropLandingExtension = Extension.create({
  name: "meridianDropLanding",

  addProseMirrorPlugins() {
    return [dropLandingPlugin(), dropCursorPlugin()];
  },
});
