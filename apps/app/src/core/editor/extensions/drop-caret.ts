/** Shared ProseMirror drop-caret geometry and lifecycle. */

import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const CURSOR_COLOR = "var(--color-primary)";
const CURSOR_WIDTH = 2;

export class DropCaretView {
  private cursorPos: number | null = null;
  private element: HTMLElement | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly handlers: { name: string; handler: (event: Event) => void }[];

  constructor(
    private readonly editorView: EditorView,
    private readonly targetAt: (view: EditorView, event: DragEvent) => number | null,
  ) {
    this.handlers = (["dragover", "dragend", "drop", "dragleave"] as const).map((name) => {
      const handler = (event: Event) => this[name](event as DragEvent);
      editorView.dom.addEventListener(name, handler);
      return { name, handler };
    });
  }

  destroy() {
    for (const { name, handler } of this.handlers)
      this.editorView.dom.removeEventListener(name, handler);
    this.setCursor(null);
  }

  update(editorView: EditorView, prevState: EditorState) {
    if (this.cursorPos == null || prevState.doc === editorView.state.doc) return;
    if (this.cursorPos > editorView.state.doc.content.size) this.setCursor(null);
    else this.updateOverlay();
  }

  private setCursor(pos: number | null) {
    if (pos === this.cursorPos) return;
    this.cursorPos = pos;
    if (pos == null) {
      this.element?.remove();
      this.element = null;
    } else this.updateOverlay();
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
            if (afterDOM instanceof HTMLElement)
              top = (top + afterDOM.getBoundingClientRect().top) / 2;
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
    if (!this.editorView.editable) {
      this.setCursor(null);
      return;
    }
    const target = this.targetAt(this.editorView, event);
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
