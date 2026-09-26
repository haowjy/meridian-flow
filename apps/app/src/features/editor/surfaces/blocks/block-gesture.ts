/** Coordinates block dragging from press through drop. */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { beginBlockDrag, draggedBlockPos, endBlockDrag, liftBlockDrag } from "@/core/editor/blocks";

import { useEditorChrome } from "../../chrome/useEditorChrome";
import {
  nativeDragCarriesObject,
  objectBodyDragTarget,
  seamIndexAtPointer,
} from "./block-geometry";
import { blockAt, moveBlockToSeamTransaction } from "./block-targets";

/** Pointer travel that turns a press into a drag, not a click. */
const DRAG_SLOP_PX = 4;

/** Which door the press came through. */
type DragSource = "handle" | "body";

/** A press that may become a drag, from the moment it lands to whatever ends it. */
type Gesture = {
  pointerId: number;
  source: DragSource;
  startX: number;
  startY: number;
  /** Last seen pointer y, the only input the drop seam is computed from. */
  pointerY: number;
  /** False while the press might still turn out to be a click. */
  lifted: boolean;
  /** The kernel's closer, once the press became a drag. */
  endDrag: (() => void) | null;
  /** The element holding the pointer, when the press took capture. */
  capture: HTMLElement | null;
};

/** What the gesture needs from a press, whether React or the DOM delivered it. */
export type BlockPress = Pick<PointerEvent, "pointerId" | "clientX" | "clientY">;

export type BlockGesture = {
  /** The seam the drop line belongs on, or null while nothing has lifted. */
  seamIndex: number | null;
  /** True from the press to the finish, lifted or not. */
  active: boolean;
  /**
   * The margin handle's press. The object-body door is inside the controller,
   * because it listens on the prose rather than on chrome this lane renders.
   */
  pressHandle: (press: BlockPress, pos: number, capture: HTMLElement) => void;
  /** True while a press owns the pointer. */
  inFlight: () => boolean;
};

export type BlockGestureOptions = {
  editor: Editor;
  /** False behind a schema fence or a read-only host: no door opens. */
  editable: boolean;
  /**
   * A press on the handle that never travelled. That click is the menu's door;
   * a body's click belongs to ProseMirror and never reaches here.
   */
  onHandleClick: (pos: number) => void;
};

export function useBlockMovementGesture({
  editor,
  editable,
  onHandleClick,
}: BlockGestureOptions): BlockGesture {
  const chrome = useEditorChrome(editor);
  const [seamIndex, setSeamIndex] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);

  // Read live: the finalizer must keep one identity for the whole gesture, and
  // the menu it opens belongs to whatever the surface is rendering now.
  const onHandleClickRef = useRef(onHandleClick);
  onHandleClickRef.current = onHandleClick;

  /** End the gesture, once. */
  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;

      releasePointerCapture(gesture.capture, gesture.pointerId);
      const held = editor.isDestroyed ? null : draggedBlockPos(editor.state);

      if (commit && held !== null && !editor.isDestroyed) {
        if (gesture.lifted) dropHeldBlock(editor, held, gesture.pointerY);
        // A press that never travelled is a click. The handle's click opens
        // the menu; an object's body leaves the click alone, and ProseMirror
        // is already turning it into the jade ring ().
        else if (gesture.source === "handle") onHandleClickRef.current(held);
      }

      if (!editor.isDestroyed) endBlockDrag(editor);
      // Token-guarded by the kernel: a closer for a drag that was already
      // abandoned does nothing, so this is safe on every path.
      gesture.endDrag?.();
      setSeamIndex(null);
      setActive(false);
    },
    [editor],
  );

  /** Take the press. */
  const beginGesture = useCallback(
    (press: BlockPress, pos: number, source: DragSource, capture: HTMLElement | null) => {
      capture?.setPointerCapture?.(press.pointerId);
      gestureRef.current = {
        pointerId: press.pointerId,
        source,
        startX: press.clientX,
        startY: press.clientY,
        pointerY: press.clientY,
        lifted: false,
        endDrag: null,
        capture,
      };
      beginBlockDrag(editor, pos);
      setActive(true);
    },
    [editor],
  );

  useEffect(() => {
    const onTransaction = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      if (draggedBlockPos(editor.state) === null) {
        // A peer deleted the block under the pointer. The document has already
        // let go of it; the gesture has to as well, or the drop line keeps
        // hunting a seam on behalf of a block that no longer exists.
        finishGesture(false);
      } else if (gesture.lifted) {
        // The seam is re-derived rather than mapped: the document moved under
        // a pointer that did not, and the line belongs under the pointer.
        setSeamIndex(seamIndexAtPointer(editor.view, gesture.pointerY));
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, finishGesture]);

  /** The object door: a press on the body of an object the registry drags as a block starts the drag the handle starts, on that object's top-level block. */
  useEffect(() => {
    if (!editable || !chrome) return;
    const dom = editor.view.dom;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== "mouse") return;
      if (gestureRef.current || editor.isDestroyed) return;
      const target = objectBodyDragTarget(editor.view, event);
      if (target) beginGesture(event, target.pos, "body", null);
    };

    const onDragStart = (event: DragEvent) => {
      if (nativeDragCarriesObject(editor.view, event)) event.preventDefault();
    };

    const onSelectStart = (event: Event) => {
      if (gestureRef.current?.source === "body") event.preventDefault();
    };

    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("dragstart", onDragStart);
    dom.addEventListener("selectstart", onSelectStart);
    return () => {
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("dragstart", onDragStart);
      dom.removeEventListener("selectstart", onSelectStart);
    };
  }, [editor, editable, chrome, beginGesture]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || !chrome || editor.isDestroyed) {
        return;
      }
      gesture.pointerY = event.clientY;

      if (!gesture.lifted) {
        const travelled = Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
        );
        if (travelled < DRAG_SLOP_PX) return;
        // Only now is it a drag. A press that never travelled is a click, and
        // telling the kernel otherwise would blank every surface on the page
        // for the length of a menu press.
        gesture.lifted = true;
        gesture.endDrag = chrome.beginDrag(() => finishGesture(false));
        liftBlockDrag(editor);
      }

      setSeamIndex(seamIndexAtPointer(editor.view, event.clientY));
    },
    [chrome, editor, finishGesture],
  );

  useEffect(() => {
    if (!active) return;
    const release = () => finishGesture(true);
    const abandon = () => finishGesture(false);

    // Captured pointer events still bubble to the window, so these hear the
    // whole gesture whether or not the handle survives it. `pointercancel` is
    // the browser taking the gesture away (a touch becoming a page scroll),
    // `lostpointercapture` is the element losing it, and `blur` is the release
    // that happens where this document cannot hear it.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("lostpointercapture", abandon);
    window.addEventListener("blur", abandon);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("lostpointercapture", abandon);
      window.removeEventListener("blur", abandon);
    };
  }, [active, onPointerMove, finishGesture]);

  // Nothing outlives an unmount: a surface torn down mid-drag would leave the
  // kernel suppressing chrome for a pointer nobody is following.
  useEffect(() => () => finishGesture(false), [finishGesture]);

  const pressHandle = useCallback(
    (press: BlockPress, pos: number, capture: HTMLElement) => {
      beginGesture(press, pos, "handle", capture);
    },
    [beginGesture],
  );

  const inFlight = useCallback(() => gestureRef.current !== null, []);

  return { seamIndex, active, pressHandle, inFlight };
}

/** Land the held block on whatever seam the pointer is over right now. */
function dropHeldBlock(editor: Editor, held: number, pointerY: number): void {
  const source = blockAt(editor.state.doc, held);
  if (!source) return;
  const seam = seamIndexAtPointer(editor.view, pointerY);
  const transaction = moveBlockToSeamTransaction(editor.state, source, seam);
  if (transaction) editor.view.dispatch(transaction);
}

function releasePointerCapture(element: HTMLElement | null, pointerId: number): void {
  if (!element?.hasPointerCapture?.(pointerId)) return;
  element.releasePointerCapture(pointerId);
}
