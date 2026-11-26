import type { Editor } from "@tiptap/core";
import { AllSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type EditorChrome, getEditorChrome, trackPress } from "../chrome";
import { dragEdgeScroll } from "./edge-scroll";

const TICK_MS = 50;
const ROOT_CLASS = "selection-dragging";

type Modifiers = { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

const modifiersOf = ({ ctrlKey, altKey, shiftKey, metaKey }: Modifiers): Modifiers => ({
  ctrlKey,
  altKey,
  shiftKey,
  metaKey,
});

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

  const hover = () => {
    const now = doc.elementFromPoint(pointer.clientX, pointer.clientY);
    if (now !== over) {
      if (over?.isConnected) send("dragleave", over, now);
      if (now) send("dragenter", now, over);
      over = now;
    }
    return over ? send("dragover", over).defaultPrevented : false;
  };

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
      event.stopPropagation();
    },
    finish,
  };
}

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
