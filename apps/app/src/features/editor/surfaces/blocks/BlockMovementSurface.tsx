/**
 * Block movement (§5.8): the handle in the margin, the drag with its jade drop
 * line, the block menu, and Alt+↑/↓.
 *
 * One surface owns all four because they are one verb with four doors — the
 * writer moves a block by dragging it, by pressing a key, or by choosing a
 * menu row, and every door ends in the same transaction. The document half is
 * `block-targets.ts`, the measuring half is `block-geometry.ts`; this file is
 * the gesture, and it decides nothing about the document itself.
 *
 * The kernel owns the timing and the standing-down. Hover comes from
 * `chrome.createHoverIntent`, so a pointer crossing the page on its way
 * somewhere else is ignored and a gesture cancels the reveal outright; a drag
 * is declared with `chrome.beginDrag`, so every other surface goes quiet while
 * it runs and re-evaluates on release. Nothing here keeps its own timer and
 * nothing here decides whether another surface may exist.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CHROME_TIMING, type HoverIntent, type KeymapBinding } from "@/core/editor/chrome";
import { isEditorObject, selectObjectTransaction } from "@/core/editor/objects";

import { useChromeSuppressed, useEditorChrome } from "../../chrome";
import { BlockMenu } from "./BlockMenu";
import { blockHandleLabel } from "./block-copy";
import {
  BLOCK_HANDLE_HEIGHT,
  BLOCK_HANDLE_WIDTH,
  blockElement,
  blockHandlePosition,
  blockUnderPointer,
  seamIndexAtPointer,
  seamLinePosition,
} from "./block-geometry";
import {
  type BlockMoveDirection,
  type BlockTarget,
  blockAt,
  blockForSelection,
  deleteBlockTransaction,
  duplicateBlockTransaction,
  moveBlockStepTransaction,
  moveBlockToSeamTransaction,
  selectionIsInsideTable,
} from "./block-targets";

/** Names this surface in `EDITOR_CHROME_SURFACES` and in probes. */
export const BLOCK_MOVEMENT_SURFACE_ID = "block-movement";

/** Pointer travel that turns a press on the handle into a drag, not a click. */
const DRAG_SLOP_PX = 4;

type Gesture = {
  startX: number;
  startY: number;
  /** Mapped through every transaction, so a peer's edit cannot lose the block. */
  sourcePos: number;
  seamIndex: number;
  /** Non-null once the press became a drag and the kernel was told. */
  endDrag: (() => void) | null;
};

/** What a drag renders: the ghosted source, and the seam it would land on. */
type DragView = { sourcePos: number; seamIndex: number };

type BlockTransactionBuilder = (state: Editor["state"], source: BlockTarget) => Transaction | null;

export function BlockMovementSurface({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);

  const [settled, setSettled] = useState<number | null>(null);
  const [anchorPos, setAnchorPos] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<number | null>(null);
  const [pressing, setPressing] = useState(false);
  const [drag, setDrag] = useState<DragView | null>(null);
  // A re-measure ticket. Block boxes move for reasons a ResizeObserver on one
  // element never sees — a peer typing three paragraphs above, an AI write
  // landing — so anything on screen re-reads its geometry per transaction.
  const [revision, setRevision] = useState(0);

  const intentRef = useRef<HoverIntent<number> | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const showingRef = useRef(false);
  showingRef.current = anchorPos !== null || menuPos !== null;

  const editable = editor.isEditable;

  useBlockMovementKeymap(editor);

  useEffect(() => {
    if (!chrome) return;
    const intent = chrome.createHoverIntent<number>({ onSettle: setSettled });
    intentRef.current = intent;
    return () => {
      intentRef.current = null;
      intent.dispose();
    };
  }, [chrome]);

  // The handle fades rather than vanishing: the hover intent's grace lets the
  // pointer travel onto it, and this keeps the element mounted one fade longer
  // so the way out looks like the way in.
  useEffect(() => {
    if (settled !== null) {
      setAnchorPos(settled);
      return;
    }
    if (menuPos !== null) return;
    const timer = window.setTimeout(() => setAnchorPos(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [settled, menuPos]);

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const gesture = gestureRef.current;
      if (gesture) gesture.sourcePos = transaction.mapping.map(gesture.sourcePos);
      setMenuPos((pos) => (pos === null ? pos : transaction.mapping.map(pos)));
      // Only what is on screen pays for a keystroke.
      if (gesture || showingRef.current) setRevision((value) => value + 1);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  // Approach: the pointer spends most of it in the margin, where `posAtCoords`
  // has nothing to say, so x is pulled into the column before asking.
  useEffect(() => {
    if (!editable) return;
    const scroller = editor.view.dom.closest("[data-stable-layout-scroll]") ?? editor.view.dom;

    const onPointerMove = (event: Event) => {
      if (gestureRef.current || editor.isDestroyed) return;
      const { clientX, clientY } = event as PointerEvent;
      const block = blockUnderPointer(editor.view, clientX, clientY);
      if (block) intentRef.current?.enter(block.pos);
      else intentRef.current?.leave();
    };
    const onPointerLeave = () => intentRef.current?.leave();

    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerleave", onPointerLeave);
    return () => {
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [editor, editable]);

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    gesture?.endDrag?.();
    setPressing(false);
    setDrag(null);
    return gesture;
  }, []);

  const openMenuAt = useCallback(
    (pos: number) => {
      const target = blockAt(editor.state.doc, pos);
      if (!target) return;
      // Law 1: pressing a block's handle READS that block — a caret in prose,
      // a selection on an object. The menu's verbs then run against the same
      // selection the toolbar's fence reads, which is what keeps one refusal
      // rule behind both surfaces.
      const selection = isEditorObject(target.node)
        ? selectObjectTransaction(editor.state, target.pos)
        : editor.state.tr.setSelection(
            TextSelection.near(editor.state.doc.resolve(target.pos + 1)),
          );
      if (selection) editor.view.dispatch(selection);
      setMenuPos(target.pos);
    },
    [editor],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || !chrome || editor.isDestroyed) return;

      if (!gesture.endDrag) {
        const travelled =
          Math.abs(event.clientX - gesture.startX) + Math.abs(event.clientY - gesture.startY);
        if (travelled < DRAG_SLOP_PX) return;
        // Only now is it a drag. A press that never travelled is a click, and
        // telling the kernel otherwise would blank every surface on the page
        // for the length of a menu press.
        gesture.endDrag = chrome.beginDrag(() => {
          gestureRef.current = null;
          setPressing(false);
          setDrag(null);
        });
      }

      gesture.seamIndex = seamIndexAtPointer(editor.view, event.clientY);
      setDrag({ sourcePos: gesture.sourcePos, seamIndex: gesture.seamIndex });
    },
    [chrome, editor],
  );

  const onPointerUp = useCallback(() => {
    const gesture = endGesture();
    if (!gesture || editor.isDestroyed) return;

    if (!gesture.endDrag) {
      openMenuAt(gesture.sourcePos);
      return;
    }

    const source = blockAt(editor.state.doc, gesture.sourcePos);
    if (!source) return;
    const transaction = moveBlockToSeamTransaction(editor.state, source, gesture.seamIndex);
    if (transaction) editor.view.dispatch(transaction);
  }, [editor, endGesture, openMenuAt]);

  // Esc during a drag reaches the kernel's chain only while the prose holds
  // focus, and a press that began on portalled chrome may have left it
  // elsewhere. This is the same cancel the chain calls, so both doors land on
  // one path rather than two.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gestureRef.current) return;
      event.preventDefault();
      endGesture();
    },
    [endGesture],
  );

  useEffect(() => {
    if (!pressing) return;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [pressing, onPointerMove, onPointerUp, onKeyDown]);

  // The lifted block reads as lifted (mockup 08, state C). An attribute rather
  // than a decoration: nothing is dispatched until the drop, so the document
  // must not learn about a drag that may never land.
  useLayoutEffect(() => {
    if (!drag) return;
    const element = blockElement(editor.view, drag.sourcePos);
    if (!element) return;
    element.setAttribute("data-block-dragging", "true");
    return () => element.removeAttribute("data-block-dragging");
  }, [editor, drag, revision]);

  const runOnBlock = useCallback(
    (pos: number, build: BlockTransactionBuilder) => {
      const target = blockAt(editor.state.doc, pos);
      if (!target || !editor.isEditable) return;
      const transaction = build(editor.state, target);
      if (transaction) editor.view.dispatch(transaction);
    },
    [editor],
  );

  if (!editable || typeof document === "undefined") return null;

  const targetPos = menuPos ?? anchorPos;
  const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
  const handle = target && !drag ? blockHandlePosition(editor.view, target) : null;
  const line = drag ? seamLinePosition(editor.view, drag.seamIndex) : null;
  const visible = !suppressed && (settled !== null || menuPos !== null);

  return (
    <>
      {handle
        ? createPortal(
            <button
              type="button"
              className="meridian-block-handle"
              data-state={visible ? "open" : "closed"}
              data-editor-chrome
              aria-label={blockHandleLabel()}
              aria-haspopup="menu"
              aria-expanded={menuPos !== null}
              style={{
                top: handle.top,
                left: handle.left,
                width: BLOCK_HANDLE_WIDTH,
                height: BLOCK_HANDLE_HEIGHT,
              }}
              onPointerEnter={() => {
                if (targetPos !== null) intentRef.current?.enter(targetPos);
              }}
              onPointerLeave={() => intentRef.current?.leave()}
              onPointerDown={(event) => {
                if (event.button !== 0 || targetPos === null) return;
                // Keep the caret and the focus exactly where the writer left
                // them: the press is about a block, not about where to type.
                event.preventDefault();
                gestureRef.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  sourcePos: targetPos,
                  seamIndex: 0,
                  endDrag: null,
                };
                setPressing(true);
              }}
            >
              <GripVertical aria-hidden />
            </button>,
            document.body,
          )
        : null}

      {line
        ? createPortal(
            <div
              className="meridian-block-drop-line"
              data-editor-chrome
              aria-hidden
              style={{ top: line.top, left: line.left, width: line.width }}
            />,
            document.body,
          )
        : null}

      {target && menuPos !== null && handle ? (
        <BlockMenu
          editor={editor}
          target={target}
          at={{ x: handle.left, y: handle.top }}
          open
          onOpenChange={(open) => {
            if (!open) setMenuPos(null);
          }}
          onMove={(direction) =>
            runOnBlock(menuPos, (state, source) =>
              moveBlockStepTransaction(state, source, direction),
            )
          }
          onDuplicate={() => runOnBlock(menuPos, duplicateBlockTransaction)}
          onDelete={() => runOnBlock(menuPos, deleteBlockTransaction)}
        />
      ) : null}
    </>
  );
}

/**
 * Alt+↑/↓ (§4, §5.8): the keyboard twin of the drag, registered at the kernel's
 * `block` scope.
 *
 * Scope is the whole precedence story. Inside a table the same keys move rows,
 * and rows belong to the table surface at the deeper `table` scope — so this
 * binding also declines outright when the caret is in a cell, rather than
 * moving the table out from under a writer editing one square of it. A
 * selected table is a different question and still moves: it is an object, and
 * the writer selected the whole thing.
 */
function useBlockMovementKeymap(editor: Editor) {
  const chrome = useEditorChrome(editor);

  useEffect(() => {
    if (!chrome) return;

    const move =
      (direction: BlockMoveDirection): KeymapBinding =>
      (state, dispatch) => {
        if (selectionIsInsideTable(state)) return false;
        const source = blockForSelection(state);
        if (!source) return false;
        const transaction = moveBlockStepTransaction(state, source, direction);
        // The ends of the document are a no-op, and an unconsumed one: the key
        // is left for whatever else might want it rather than swallowed here.
        if (!transaction) return false;
        dispatch?.(transaction);
        return true;
      };

    return chrome.registerKeymap({
      id: BLOCK_MOVEMENT_SURFACE_ID,
      scope: "block",
      bindings: { "Alt-ArrowUp": move("up"), "Alt-ArrowDown": move("down") },
    });
  }, [chrome]);
}
