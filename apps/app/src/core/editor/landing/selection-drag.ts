/**
 * The editor's own drag of a text selection: a press on the highlight that
 * travels 4px lifts it at once, the way Google Docs does, with no pause and no
 * third-click refusal. The browser's text drag has both (see
 * `findings/text-drag.md` in the editor-followups work), and brings a drag
 * image; this gesture has neither.
 *
 * It is a pump, not a second drop path. It feeds the drag events a native drag
 * would send (`dragstart`, `dragenter`, `dragover`, `drop`, `dragend`, with a
 * real `DataTransfer`) into the pipeline that already handles them:
 * ProseMirror's `view.dragging`, `LandingExtension`'s caret and doors, link
 * announcements, other surfaces' `LandingExtension` (the composer copies).
 * Release sends `drop` only when the last `dragover` was cancelled, the
 * browser's own rule, so a target that claims nothing gets nothing.
 *
 * A press that never travels does what the browser would have done on
 * release: a caret there, or the paragraph for a third click. Presses it does
 * not take stay native, among them any with a modifier (so Ctrl/Option-drag
 * still carries text out of the window) and surfaces with no chrome kernel,
 * which have no Escape route for a drag.
 */

import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { getEditorChrome } from "../chrome";
import { dragEdgeScroll } from "./edge-scroll";

/** Pointer travel that lifts the selection, ProseMirror's own slop. */
const LIFT_PX = 4;
/** Re-sent `dragover`: native drags repeat it, and the caret, the scroll and a pause past 5s depend on that. */
const TICK_MS = 50;
const ROOT_CLASS = "selection-dragging";

type Modifiers = { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

/** The modifier flags alone: an event's own are prototype getters, which a spread would drop. */
const modifiersOf = ({ ctrlKey, altKey, shiftKey, metaKey }: Modifiers): Modifiers => ({
  ctrlKey,
  altKey,
  shiftKey,
  metaKey,
});

/**
 * Whether a press lands on the highlight of a text selection this gesture
 * takes. The rects are the browser's own highlight, so letters and the space
 * between lines of a multi-line range both count while a margin beside them
 * does not.
 */
export function pressOnSelection(view: EditorView, editor: Editor, event: MouseEvent): boolean {
  const { selection } = view.state;
  if (event.button !== 0 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
    return false;
  }
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  if (!view.editable || !view.hasFocus() || !getEditorChrome(editor)) return false;
  const target = event.target;
  if (!(target instanceof Element) || !view.dom.contains(target)) return false;
  if (target.closest('[contenteditable="false"]') !== view.dom.closest('[contenteditable="false"]'))
    return false;

  const domSelection = view.dom.ownerDocument.getSelection();
  if (!domSelection || domSelection.rangeCount === 0) return false;
  const range = domSelection.getRangeAt(0);
  if (!view.dom.contains(range.commonAncestorContainer)) return false;
  // A rect is the glyph box; the highlight paints the whole line box, so grow
  // each rect to the line height or the space between lines would not count.
  const style = getComputedStyle(target);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
  for (const rect of range.getClientRects()) {
    const lead = Math.max(0, (lineHeight - rect.height) / 2);
    if (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top - lead &&
      event.clientY <= rect.bottom + lead
    ) {
      return true;
    }
  }
  return false;
}

/** Listens for qualifying presses on `view` for as long as it lives. Returns the teardown. */
export function installSelectionDrag(view: EditorView, editor: Editor): () => void {
  let active: { cancel: () => void } | null = null;

  const onMouseDown = (event: MouseEvent) => {
    // Runs after ProseMirror's own `mousedown` (registered first, on this
    // element), which counted the click and ran `handleTripleClick`. Preventing
    // the default here is what keeps the browser's text drag and its
    // highlight redraw away; ProseMirror's click machinery still sees the
    // `mouseup`.
    if (active || !pressOnSelection(view, editor, event)) return;
    event.preventDefault();
    active = startGesture(view, editor, event, () => {
      active = null;
    });
  };

  view.dom.addEventListener("mousedown", onMouseDown);
  return () => {
    view.dom.removeEventListener("mousedown", onMouseDown);
    active?.cancel();
  };
}

function startGesture(
  view: EditorView,
  editor: Editor,
  press: MouseEvent,
  onDone: () => void,
): { cancel: () => void } {
  const chrome = getEditorChrome(editor);
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  const pressTarget = press.target as Element;
  const triple = press.detail >= 3;

  let lifted = false;
  /** Lifted at some point, so the `click` that follows the release is not a click. */
  let dragged = false;
  let x = press.clientX;
  let y = press.clientY;
  let modifiers = modifiersOf(press);
  let over: Element | null = null;
  let accepted = false;
  let tick: ReturnType<typeof setInterval> | undefined;
  let endChrome: (() => void) | undefined;
  let transfer: DataTransfer | null = null;
  let seenState = view.state;

  const send = (type: string, target: Element, related: Element | null = null): DragEvent => {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x + win.screenX,
      screenY: y + win.screenY,
      dataTransfer: transfer,
      relatedTarget: related,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };

  /** One `dragover`, preceded by `dragleave`/`dragenter` when the element under the pointer changed. */
  const hover = () => {
    const now = doc.elementFromPoint(x, y);
    if (now !== over) {
      if (over?.isConnected) send("dragleave", over, now);
      if (now) send("dragenter", now, over);
      over = now;
    }
    accepted = over ? send("dragover", over).defaultPrevented : false;
  };

  const peerChangedSelection = () => {
    if (view.state === seenState) return false;
    seenState = view.state;
    const slice = view.dragging?.slice;
    return !slice || !view.state.selection.content().eq(slice);
  };

  const onTick = () => {
    if (peerChangedSelection()) {
      finish(false);
      return;
    }
    hover();
    const scroller =
      over?.closest<HTMLElement>("[data-stable-layout-scroll]") ??
      view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
    dragEdgeScroll(scroller, y);
  };

  const lift = () => {
    transfer = new DataTransfer();
    send("dragstart", pressTarget);
    if (!view.dragging) {
      // Nothing took the drag (a selection with no content): stay a plain press.
      transfer = null;
      stop();
      return;
    }
    // TipTap's paste-rule plugin remembers a drag that starts in an editor
    // and deletes its selection after a drop into any other editor, copy or
    // not. Its own `window` `dragend` listener forgets it; a surface that is
    // a target copies, as this gesture promises.
    win.dispatchEvent(new Event("dragend"));
    lifted = true;
    dragged = true;
    endChrome = chrome?.beginDrag(() => finish(false));
    doc.documentElement.classList.add(ROOT_CLASS);
    tick = setInterval(onTick, TICK_MS);
    hover();
  };

  const swallowClick = () => {
    const swallow = (event: Event) => event.stopPropagation();
    win.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => win.removeEventListener("click", swallow, { capture: true }), 100);
  };

  /** Ends a lifted drag: `drop` only when the last `dragover` was accepted, then `dragend`. */
  const finish = (drop: boolean) => {
    if (!lifted) return;
    lifted = false;
    clearInterval(tick);
    if (drop) {
      hover();
      if (accepted && over) send("drop", over);
    } else if (over?.isConnected) {
      send("dragleave", over);
    }
    send("dragend", view.dom);
    doc.documentElement.classList.remove(ROOT_CLASS);
    endChrome?.();
    endChrome = undefined;
  };

  const stop = () => {
    win.removeEventListener("pointermove", onMove, true);
    win.removeEventListener("pointercancel", onLost, true);
    win.removeEventListener("mouseup", onUp);
    win.removeEventListener("blur", onLost);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("keyup", onKey, true);
    onDone();
  };

  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) {
      // The button came up somewhere we never heard about.
      onLost();
      return;
    }
    x = event.clientX;
    y = event.clientY;
    modifiers = modifiersOf(event);
    if (dragged && !lifted) return; // cancelled: the button is still down, the gesture is over
    if (lifted) {
      // Hover chrome elsewhere reads `pointermove`; a native drag sends none.
      event.stopPropagation();
      return;
    }
    if (Math.abs(x - press.clientX) + Math.abs(y - press.clientY) >= LIFT_PX) lift();
  };

  const onKey = (event: KeyboardEvent) => {
    modifiers = modifiersOf(event);
  };

  const onLost = () => {
    finish(false);
    stop();
  };

  const onUp = (event: MouseEvent) => {
    x = event.clientX;
    y = event.clientY;
    modifiers = modifiersOf(event);
    if (lifted) finish(true);
    if (dragged) {
      swallowClick();
    } else if (!event.defaultPrevented) {
      // ProseMirror's `mouseup` ran first and did not take this one; the
      // browser would have collapsed the selection to a caret here.
      placeCaret(view, x, y, triple);
    }
    stop();
  };

  win.addEventListener("pointermove", onMove, true);
  win.addEventListener("pointercancel", onLost, true);
  win.addEventListener("mouseup", onUp);
  win.addEventListener("blur", onLost);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("keyup", onKey, true);

  return {
    cancel: onLost,
  };
}

/** The caret a click makes at the pointer, or the pressed textblock for a third click. */
function placeCaret(view: EditorView, x: number, y: number, triple: boolean): void {
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return;
  const $pos = view.state.doc.resolve(at.pos);
  const selection =
    triple && $pos.parent.isTextblock
      ? TextSelection.create(view.state.doc, $pos.start(), $pos.end())
      : $pos.parent.inlineContent
        ? TextSelection.create(view.state.doc, at.pos)
        : Selection.near($pos);
  view.dispatch(view.state.tr.setSelection(selection));
}
