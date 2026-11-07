/**
 * The editor's own drag of a text selection: a press on the highlight that
 * travels 4px lifts it at once, the way Google Docs does, with no pause and no
 * third-click refusal. The browser's text drag has both (see
 * `findings/text-drag.md` in the editor-followups work), and brings a drag
 * image; this gesture has neither.
 *
 * Two halves that change independently: `trackPress` (in `chrome/`) follows the
 * mouse and decides click or lift; `liftSelection` is the pump. The pump is not a second
 * drop path. It feeds the drag events a native drag
 * would send (`dragstart`, `dragenter`, `dragover`, `drop`, `dragend`, with a
 * real `DataTransfer`) into the pipeline that already handles them:
 * ProseMirror's `view.dragging`, `LandingExtension`'s caret and doors, link
 * announcements, other surfaces' `LandingExtension` (the composer copies).
 * Release first lifts a press that has not lifted yet but ended past the press slop
 * from where it began (a flick can release before any move is heard), then
 * sends one `dragover` at the release point, so a fast drag lands where it is
 * let go, then `drop` only if that `dragover` was cancelled:
 * a target that claims nothing gets nothing. (A native drag also withholds
 * `drop` from a target that set `dropEffect` to `none`; this one does not, and
 * the doors check again on `drop`.)
 *
 * A press that never travels does what the browser would have done on
 * release: a caret there, or the paragraph for a third click. Presses it does
 * not take stay native, among them any with a modifier (so Ctrl/Option-drag
 * still carries text out of the window) and surfaces with no chrome kernel,
 * which have no Escape route for a drag.
 */

import type { Editor } from "@tiptap/core";
import { AllSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type EditorChrome, getEditorChrome, trackPress } from "../chrome";
import { dragEdgeScroll } from "./edge-scroll";

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
 * takes. The test is the one ProseMirror's own `dragstart` applies: the
 * position under the pointer lies in the selection's range. So letters, the
 * space between a range's lines and the blank past a covered line's last word
 * count, and unselected text after the range's end does not. A press that
 * doesn't travel still places a caret.
 */
function selectionPress(view: EditorView, event: MouseEvent): "on" | "beside" | null {
  const { selection } = view.state;
  if (event.button !== 0 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
    return null;
  }
  if (!(selection instanceof TextSelection || selection instanceof AllSelection) || selection.empty)
    return null;
  if (!view.editable || !view.hasFocus()) return null;
  const target = event.target;
  if (!(target instanceof Element) || !view.dom.contains(target)) return null;
  if (target.closest('[contenteditable="false"]') !== view.dom.closest('[contenteditable="false"]'))
    return null;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at || at.pos < selection.from || at.pos > selection.to) return null;
  const start = view.coordsAtPos(selection.from);
  if (at.pos === selection.from && (event.clientY < start.top || event.clientX < start.left))
    return "beside";
  if (at.pos === selection.to && event.clientX > view.coordsAtPos(selection.to, -1).left)
    return "beside";
  return "on";
}

function pressOnSelection(view: EditorView, event: MouseEvent): boolean {
  return selectionPress(view, event) === "on";
}

/**
 * The presses ProseMirror counted as a second or third click: a re-press on
 * the highlight is this gesture's, so `handleDoubleClick` and
 * `handleTripleClick` claim it (otherwise the browser or ProseMirror widens
 * the selection to a word or paragraph). A third press that doesn't travel
 * selects the paragraph, so the gesture reads the claim, not `detail`:
 * ProseMirror's count is the one that decided.
 */
const thirdPresses = new WeakSet<MouseEvent>();

export function claimRepress(
  view: EditorView,
  editor: Editor,
  event: MouseEvent,
  third: boolean,
): boolean {
  if (!getEditorChrome(editor) || !pressOnSelection(view, event)) return false;
  if (third) thirdPresses.add(event);
  return true;
}

/** Listens for qualifying presses on `view` for as long as it lives. Returns the teardown. */
export function installSelectionDrag(view: EditorView, editor: Editor): () => void {
  let cancel: (() => void) | null = null;

  const onMouseDown = (event: MouseEvent) => {
    // Runs after ProseMirror's own `mousedown` (registered first, on this
    // element), which counted the click and ran the claims above. Preventing
    // the default here is what keeps the browser's text drag and its
    // highlight redraw away; ProseMirror's click machinery still sees the
    // `mouseup`.
    const chrome = getEditorChrome(editor);
    if (cancel || !chrome) return;
    const hit = selectionPress(view, event);
    if (hit === "beside") {
      // Chrome otherwise starts its native drag from the painted half of the
      // adjacent glyph, before its default action can replace the old range.
      placeCaret(view, event.clientX, event.clientY, false);
      return;
    }
    if (hit !== "on") return;
    event.preventDefault();
    cancel = startGesture(view, chrome, event, () => {
      cancel = null;
    });
  };

  view.dom.addEventListener("mousedown", onMouseDown);
  return () => {
    view.dom.removeEventListener("mousedown", onMouseDown);
    cancel?.();
  };
}

/** Starts tracking a press the selection drag took: a click places the caret (or the paragraph for a third press), a travel lifts. */
function startGesture(
  view: EditorView,
  chrome: EditorChrome,
  press: MouseEvent,
  onDone: () => void,
): () => void {
  let lifted: ReturnType<typeof liftSelection> | null = null;
  return trackPress(press, {
    lift: (at) => {
      lifted = liftSelection(view, chrome, press, at);
      return lifted.move;
    },
    end: (how, at) => {
      onDone();
      if (how !== "click") lifted?.finish(how === "drop");
      // ProseMirror's `mouseup` ran first and did not take this one; the
      // browser would have collapsed the selection to a caret here.
      else if (at && !at.defaultPrevented) {
        placeCaret(view, at.clientX, at.clientY, thirdPresses.has(press));
      }
    },
  });
}

/**
 * Lifts the selection with the drag events a native drag would send, and
 * keeps them coming until `finish`, the chrome's Escape, or a peer's edit that
 * changes what the selection holds. After the last two `finish` is a no-op.
 */
function liftSelection(
  view: EditorView,
  chrome: EditorChrome,
  press: MouseEvent,
  at: MouseEvent,
): { move: (event: MouseEvent) => void; finish: (release: boolean) => void } {
  const transfer = new DataTransfer();
  let pointer = at;
  let modifiers = modifiersOf(at);
  const doc = view.dom.ownerDocument;
  let over: Element | null = null;
  let ended = false;
  const carried = view.state.selection.content();
  let seenState = view.state;
  let diverged = false;

  const send = (type: string, target: Element, related: Element | null = null, where = pointer) => {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: where.clientX,
      clientY: where.clientY,
      dataTransfer: transfer,
      relatedTarget: related,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };

  /** One `dragover`, preceded by `dragleave`/`dragenter` when the element under the pointer changed. Whether the target accepts. */
  const hover = () => {
    const now = doc.elementFromPoint(pointer.clientX, pointer.clientY);
    if (now !== over) {
      if (over?.isConnected) send("dragleave", over, now);
      if (now) send("dragenter", now, over);
      over = now;
    }
    return over ? send("dragover", over).defaultPrevented : false;
  };

  /** Whether a peer's edit has changed what the selection holds, so the drag no longer carries what was lifted. */
  const carriedChanged = () => {
    if (view.state !== seenState) {
      seenState = view.state;
      diverged = !view.state.selection.content().eq(carried);
    }
    return diverged;
  };

  const finish = (release: boolean) => {
    if (ended) return;
    ended = true;
    clearInterval(tick);
    // A release first asks the target once more at the release point, and `drop`s only if it accepts.
    if (release && !carriedChanged()) {
      if (hover() && over) send("drop", over);
    } else if (over?.isConnected) {
      send("dragleave", over);
    }
    send("dragend", view.dom);
    doc.documentElement.classList.remove(ROOT_CLASS);
    ac.abort();
    endChrome();
  };

  const ac = new AbortController();
  const onKey = (event: KeyboardEvent) => {
    modifiers = modifiersOf(event);
  };
  window.addEventListener("keydown", onKey, { capture: true, signal: ac.signal });
  window.addEventListener("keyup", onKey, { capture: true, signal: ac.signal });

  // At the press, not the pointer: a fast first move may already be off the selection.
  send("dragstart", view.dom, null, press);
  const endChrome = chrome.beginDrag(() => finish(false));
  doc.documentElement.classList.add(ROOT_CLASS);
  const tick = setInterval(() => {
    if (carriedChanged()) {
      finish(false);
      return;
    }
    hover();
    const scroller =
      over?.closest<HTMLElement>("[data-stable-layout-scroll]") ??
      view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
    dragEdgeScroll(scroller, pointer.clientY);
  }, TICK_MS);
  hover();

  return {
    move: (event) => {
      pointer = event;
      modifiers = modifiersOf(event);
      // Hover chrome elsewhere reads `pointermove`; a native drag sends none.
      event.stopPropagation();
    },
    finish,
  };
}

/** The caret a click makes at the pointer, or the pressed textblock for a third click. */
function placeCaret(view: EditorView, x: number, y: number, third: boolean): void {
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return;
  const $pos = view.state.doc.resolve(at.pos);
  const selection =
    third && $pos.parent.isTextblock
      ? TextSelection.create(view.state.doc, $pos.start(), $pos.end())
      : Selection.near($pos);
  view.dispatch(view.state.tr.setSelection(selection));
}
