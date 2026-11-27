import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { beginBlockDrag, draggedBlock, endBlockDrag, liftBlockDrag } from "@/core/editor/blocks";
import { type EditorChrome, type PressStart, trackPress } from "@/core/editor/chrome";
import { endUndoStep } from "@/core/editor/editor-history";

import { useEditorChrome } from "../../chrome/useEditorChrome";
import {
  nativeDragCarriesObject,
  objectBodyDragTarget,
  seamIndexAtPointer,
} from "./block-geometry";
import { blockAt, moveBlockToSeamTransaction } from "./block-targets";

type DragSource = "handle" | "body";

type Gesture = {
  pointerId: number;
  source: DragSource;
  pointerY: number;
  endDrag: (() => void) | null;
  capture: HTMLElement | null;
  stop: () => void;
};

export type BlockPress = PressStart & { pointerId: number };

export type BlockGesture = {
  seamIndex: number | null;
  active: boolean;
  pressHandle: (press: BlockPress, pos: number, capture: HTMLElement) => void;
  inFlight: () => boolean;
};

export type BlockGestureOptions = {
  editor: Editor;
  editable: boolean;
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

  const onHandleClickRef = useRef(onHandleClick);
  onHandleClickRef.current = onHandleClick;

  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      gesture.stop();

      releasePointerCapture(gesture.capture, gesture.pointerId);
      const held = editor.isDestroyed ? null : draggedBlock(editor.state);

      if (commit && held !== null) {
        if (held.lifted) dropHeldBlock(editor, held.pos, gesture.pointerY);
        else if (gesture.source === "handle") onHandleClickRef.current(held.pos);
      }

      if (!editor.isDestroyed) endBlockDrag(editor);
      gesture.endDrag?.();
      setSeamIndex(null);
      setActive(false);
    },
    [editor],
  );

  const beginGesture = useCallback(
    (
      chrome: EditorChrome,
      press: BlockPress,
      pos: number,
      source: DragSource,
      capture: HTMLElement | null,
    ) => {
      capture?.setPointerCapture?.(press.pointerId);
      beginBlockDrag(editor, pos);
      const gesture: Gesture = {
        pointerId: press.pointerId,
        source,
        pointerY: press.clientY,
        endDrag: null,
        capture,
        stop: trackPress(press, {
          lift: () => {
            // Only now is it a drag. A press that never travelled is a click, and
            // telling the kernel otherwise would blank every surface on the page
            // for the length of a menu press.
            gesture.endDrag = chrome.beginDrag(() => finishGesture(false));
            liftBlockDrag(editor);
            return (event) => {
              if (draggedBlock(editor.state) === null) {
                finishGesture(false);
                return;
              }
              gesture.pointerY = event.clientY;
              setSeamIndex(seamIndexAtPointer(editor.view, event.clientY));
            };
          },
          end: (how) => finishGesture(how !== "cancel"),
        }),
      };
      gestureRef.current = gesture;
      setActive(true);
    },
    [editor, finishGesture],
  );

  useEffect(() => {
    const onTransaction = () => {
      const gesture = gestureRef.current;
      const held = draggedBlock(editor.state);
      if (!gesture || !held?.lifted) return;
      setSeamIndex(seamIndexAtPointer(editor.view, gesture.pointerY));
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  useEffect(() => {
    if (!editable || !chrome) return;
    const dom = editor.view.dom;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== "mouse") return;
      if (gestureRef.current || editor.isDestroyed) return;
      const target = objectBodyDragTarget(editor.view, event);
      if (target) beginGesture(chrome, event, target.pos, "body", null);
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

  useEffect(() => () => finishGesture(false), [finishGesture]);

  const pressHandle = useCallback(
    (press: BlockPress, pos: number, capture: HTMLElement) => {
      if (chrome) beginGesture(chrome, press, pos, "handle", capture);
    },
    [chrome, beginGesture],
  );

  const inFlight = useCallback(() => gestureRef.current !== null, []);

  return { seamIndex, active, pressHandle, inFlight };
}

function dropHeldBlock(editor: Editor, held: number, pointerY: number): void {
  const source = blockAt(editor.state.doc, held);
  if (!source) return;
  const seam = seamIndexAtPointer(editor.view, pointerY);
  const transaction = moveBlockToSeamTransaction(editor.state, source, seam);
  if (!transaction) return;
  endUndoStep(editor.state);
  editor.view.dispatch(transaction);
}

function releasePointerCapture(element: HTMLElement | null, pointerId: number): void {
  if (!element?.hasPointerCapture?.(pointerId)) return;
  element.releasePointerCapture(pointerId);
}
