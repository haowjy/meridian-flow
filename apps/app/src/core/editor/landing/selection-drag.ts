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
 * Release first lifts a press that has not lifted yet but ended `LIFT_PX` or more
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
import type { Slice } from "@tiptap/pm/model";
import { AllSelection, Selection, TextSelection } from "@tiptap/pm/state";
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
 * takes. The rects are the browser's own highlight, grown to the line height,
 * so letters and the space between lines of a multi-line range count, and in
 * a multi-block range the sliver past each line's last word. A block
 * the range covers whole can report a full-width rect too, so its margin
 * counts there; a press that doesn't travel still places a caret.
 */
function pressOnSelection(view: EditorView, editor: Editor, event: MouseEvent): boolean {
  const { selection } = view.state;
  if (event.button !== 0 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
    return false;
  }
  if (!(selection instanceof TextSelection || selection instanceof AllSelection) || selection.empty)
    return false;
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
  // Across blocks the highlight also paints the sliver past each line's last
  // word, out to the editor's right edge.
  const multiBlock = !(
    selection.$from.parent.isTextblock && selection.$from.sameParent(selection.$to)
  );
  const editorRight = view.dom.getBoundingClientRect().right;
  for (const rect of range.getClientRects()) {
    const lead = Math.max(0, (lineHeight - rect.height) / 2);
    if (
      event.clientX >= rect.left &&
      event.clientX <= (multiBlock ? editorRight : rect.right) &&
      event.clientY >= rect.top - lead &&
      event.clientY <= rect.bottom + lead
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The presses ProseMirror counted as a second or third click: a re-press on
 * the highlight is this gesture's, so `handleDoubleClick` and
 * `handleTripleClick` claim it (otherwise the browser or ProseMirror widens the
 * selection to a word or paragraph). A third press that doesn't travel selects
 * the paragraph, so the gesture reads the claim, not `detail`: ProseMirror's
 * count is the one that decided.
 */
const thirdPresses = new WeakSet<MouseEvent>();

export function claimRepress(
  view: EditorView,
  editor: Editor,
  event: MouseEvent,
  third: boolean,
): boolean {
  if (!pressOnSelection(view, editor, event)) return false;
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
    if (cancel || !pressOnSelection(view, editor, event)) return;
    event.preventDefault();
    cancel = startGesture(view, editor, event, () => {
      cancel = null;
    });
  };

  view.dom.addEventListener("mousedown", onMouseDown);
  return () => {
    view.dom.removeEventListener("mousedown", onMouseDown);
    cancel?.();
  };
}

/** Runs one press-to-release gesture. Returns its cancel. */
function startGesture(
  view: EditorView,
  editor: Editor,
  press: MouseEvent,
  onDone: () => void,
): () => void {
  const chrome = getEditorChrome(editor);
  const ac = new AbortController();
  const listen = (type: string, handler: (event: never) => void, capture = false) =>
    window.addEventListener(type, handler as EventListener, { capture, signal: ac.signal });
  const transfer = new DataTransfer();

  /** "ended" is a lift that finished (released, or cancelled with the button still down). */
  let phase: "pressed" | "lifted" | "ended" = "pressed";
  let pointer: MouseEvent = press;
  let modifiers = modifiersOf(press);
  let over: Element | null = null;
  let accepted = false;
  let tick: ReturnType<typeof setInterval> | undefined;
  let endChrome: (() => void) | undefined;
  let carried: Slice | undefined;
  let seenState = view.state;

  const send = (type: string, target: Element, related: Element | null = null, at = pointer) => {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.clientX,
      clientY: at.clientY,
      dataTransfer: transfer,
      relatedTarget: related,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };

  /** One `dragover`, preceded by `dragleave`/`dragenter` when the element under the pointer changed. */
  const hover = () => {
    const now = view.dom.ownerDocument.elementFromPoint(pointer.clientX, pointer.clientY);
    if (now !== over) {
      if (over?.isConnected) send("dragleave", over, now);
      if (now) send("dragenter", now, over);
      over = now;
    }
    accepted = over ? send("dragover", over).defaultPrevented : false;
  };

  /** A peer's edit that changed what the selection holds: the drag no longer carries what was lifted. */
  const peerChangedSelection = () => {
    if (view.state === seenState) return false;
    seenState = view.state;
    return !carried || !view.state.selection.content().eq(carried);
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
    dragEdgeScroll(scroller, pointer.clientY);
  };

  const lift = () => {
    // At the press, not the pointer: a fast first move may already be off the selection.
    send("dragstart", view.dom, null, press);
    if (!view.dragging) {
      // Nothing took the drag: stay a plain press.
      stop();
      return;
    }
    carried = view.dragging.slice;
    phase = "lifted";
    endChrome = chrome?.beginDrag(() => finish(false));
    view.dom.ownerDocument.documentElement.classList.add(ROOT_CLASS);
    tick = setInterval(onTick, TICK_MS);
    hover();
  };

  /** Ends a lift. A release first asks the target once more at the release point, and `drop`s only if it accepts. */
  const finish = (release: boolean) => {
    if (phase !== "lifted") return;
    phase = "ended";
    clearInterval(tick);
    if (release && !peerChangedSelection()) {
      hover();
      if (accepted && over) send("drop", over);
    } else if (over?.isConnected) {
      send("dragleave", over);
    }
    send("dragend", view.dom);
    view.dom.ownerDocument.documentElement.classList.remove(ROOT_CLASS);
    endChrome?.();
  };

  const stop = () => {
    ac.abort();
    onDone();
  };

  const onLost = () => {
    finish(false);
    stop();
  };

  const track = (event: MouseEvent) => {
    pointer = event;
    modifiers = modifiersOf(event);
  };

  /** A release the gesture heard, from `mouseup` or from a `pointermove` that says no button is down. */
  const release = (event: MouseEvent) => {
    track(event);
    // A flick can release before any move far enough to lift: the release
    // point decides, and the drag lands where it was let go.
    if (phase === "pressed" && travelled(event)) lift();
    if (ac.signal.aborted) return;
    finish(true);
    if (phase === "ended") {
      // The `click` after a lift is not a click (the link surface would follow a link).
      window.addEventListener("click", (click) => click.stopPropagation(), {
        capture: true,
        once: true,
        signal: AbortSignal.timeout(100),
      });
    } else if (!event.defaultPrevented) {
      // ProseMirror's `mouseup` ran first and did not take this one; the
      // browser would have collapsed the selection to a caret here.
      placeCaret(view, event.clientX, event.clientY, thirdPresses.has(press));
    }
    stop();
  };

  const travelled = (event: MouseEvent) =>
    Math.abs(event.clientX - press.clientX) + Math.abs(event.clientY - press.clientY) >= LIFT_PX;

  listen(
    "pointermove",
    (event: PointerEvent) => {
      if (event.buttons === 0) {
        // The button came up where we heard nothing; treat it as the release.
        // `release` ends the gesture, so a `mouseup` that follows is not heard twice.
        release(event);
        return;
      }
      track(event);
      if (phase === "lifted") {
        // Hover chrome elsewhere reads `pointermove`; a native drag sends none.
        event.stopPropagation();
      } else if (phase === "pressed" && travelled(event)) {
        lift();
      }
    },
    true,
  );
  listen("pointercancel", onLost, true);
  listen("blur", onLost);
  const onKey = (event: KeyboardEvent) => {
    modifiers = modifiersOf(event);
  };
  listen("keydown", onKey, true);
  listen("keyup", onKey, true);
  listen("mouseup", release);

  return onLost;
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
