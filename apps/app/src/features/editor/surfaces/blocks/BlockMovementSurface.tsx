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
 * Two rules run through all of it, and both are about a document that moves
 * while a hand is on it (law 9: nothing gates a write):
 *
 * - **Every position held across a transaction goes through `followBlock`.**
 *   A block a peer deleted must take its chrome with it rather than handing
 *   Delete to the neighbour, and a peer's write moves every position in the
 *   document at once.
 * - **One finalizer ends the gesture, and everything that can end it calls
 *   that one.** Release, browser cancel, lost capture, a blurred window,
 *   Escape, and a peer deleting the block under the pointer are six ways to
 *   stop; five are interruptions, and any of them leaving the kernel
 *   suppressed would freeze every surface on the page until reload.
 *
 * The kernel owns the timing and the standing-down. Hover comes from
 * `chrome.createHoverIntent`; a drag is declared with `chrome.beginDrag`, whose
 * closer is token-guarded, so calling it late is safe and calling it twice is
 * nothing.
 */

import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { beginBlockDrag, draggedBlockPos, endBlockDrag, liftBlockDrag } from "@/core/editor/blocks";
import {
  CHROME_TIMING,
  editorChromeAttributes,
  type HoverIntent,
  type KeymapBinding,
} from "@/core/editor/chrome";
import { isEditorObject, selectObjectTransaction } from "@/core/editor/objects";

// Straight at the primitives rather than through `chrome/index.ts`: that
// barrel also carries the surface registry this file is listed in, so the
// barrel route is a module cycle (and a real one — Vite reported the
// registry's own export read before initialization).
import { useChromeSuppressed, useEditorChrome } from "../../chrome/useEditorChrome";
import { BlockMenu } from "./BlockMenu";
import { blockHandleLabel } from "./block-copy";
import {
  BLOCK_HANDLE_HEIGHT,
  BLOCK_HANDLE_WIDTH,
  blockHandlePosition,
  blockUnderPointer,
  seamIndexAtPointer,
  seamLinePosition,
} from "./block-geometry";
import {
  type BlockHold,
  type BlockMoveDirection,
  type BlockTarget,
  blockAt,
  blockForSelection,
  deleteBlockTransaction,
  duplicateBlockTransaction,
  followBlock,
  holdBlock,
  moveBlockStepTransaction,
  moveBlockToSeamTransaction,
  selectionIsInsideTable,
} from "./block-targets";

/** Names this surface in `EDITOR_CHROME_SURFACES` and in probes. */
export const BLOCK_MOVEMENT_SURFACE_ID = "block-movement";

/** Pointer travel that turns a press on the handle into a drag, not a click. */
const DRAG_SLOP_PX = 4;

/**
 * A press on the handle, from the moment it lands to whatever ends it.
 *
 * The drop target is NOT stored. It is derived from `pointerY` every time it
 * is needed, because a child index goes stale the instant a peer inserts a
 * block above, and the jade line would then promise a seam the drop would
 * miss. The pointer is the writer's intent and the geometry under it is the
 * truth; a seam is only ever a reading of the two.
 */
type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Last seen pointer y, the only input the drop seam is computed from. */
  pointerY: number;
  /** False while the press might still turn out to be a click. */
  lifted: boolean;
  /** The kernel's closer, once the press became a drag. */
  endDrag: (() => void) | null;
};

type BlockTransactionBuilder = (state: Editor["state"], source: BlockTarget) => Transaction | null;

export function BlockMovementSurface({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);

  // What the handle points at, and whether the pointer is currently on it.
  // ONE hold, deliberately: the hover intent used to keep its own copy, and a
  // copy that changes do not carry is a handle that walks back onto a block a
  // peer moved out from under it.
  const [anchorHold, setAnchorHold] = useState<BlockHold | null>(null);
  const [hovered, setHovered] = useState(false);
  const [menuHold, setMenuHold] = useState<BlockHold | null>(null);
  const [seamIndex, setSeamIndex] = useState<number | null>(null);
  const [gesturing, setGesturing] = useState(false);
  // A re-measure ticket: the value is never read, incrementing it is the whole
  // point. Block boxes move for reasons a ResizeObserver on one element never
  // sees — a peer typing three paragraphs above, an AI write landing — so
  // anything on screen re-reads its geometry once per transaction.
  const [, remeasure] = useState(0);

  const intentRef = useRef<HoverIntent<number> | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const showingRef = useRef(false);
  showingRef.current = anchorHold !== null || menuHold !== null;
  /**
   * The writer's last input device. A tap has no hover to settle, so on touch
   * the handle follows the selection instead (§5.8, law 8) — and a hybrid
   * machine answers for the hand actually on it rather than for a media query.
   */
  const coarseRef = useRef(false);

  const editable = editor.isEditable;

  useBlockMovementKeymap(editor);

  useEffect(() => {
    if (!chrome) return;
    const intent = chrome.createHoverIntent<number>({
      onSettle: (target) => {
        setHovered(target !== null);
        if (target !== null) setAnchorHold(holdBlock(editor.state, target));
      },
    });
    intentRef.current = intent;
    return () => {
      intentRef.current = null;
      intent.dispose();
    };
  }, [chrome, editor]);

  // The handle fades rather than vanishing: the hover intent's grace lets the
  // pointer travel onto it, and this keeps the element mounted one fade longer
  // so the way out looks like the way in. On touch there is no leaving to
  // handle — the handle belongs to the selected block until another is chosen.
  useEffect(() => {
    // A gesture keeps its anchor whatever the pointer is doing: the kernel
    // cancels the hover reveal the moment a drag begins, and letting the
    // handle unmount there would drop the pointer capture the drag is holding
    // — the browser would report lost capture and the drag would end on its
    // own first frame.
    if (hovered || menuHold !== null || gesturing || coarseRef.current) return;
    const timer = window.setTimeout(() => setAnchorHold(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [hovered, menuHold, gesturing]);

  /**
   * End the gesture, once. `commit` is what the writer asked for: a release
   * commits, every interruption does not.
   *
   * Ordering matters twice over. The held position is read before the hold is
   * released, because letting go is what forgets it; and `gestureRef` is
   * cleared first, so the transactions this dispatches cannot re-enter here.
   */
  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;

      releasePointerCapture(handleRef.current, gesture.pointerId);
      const held = editor.isDestroyed ? null : draggedBlockPos(editor.state);

      if (commit && held !== null && !editor.isDestroyed) {
        if (gesture.lifted) dropHeldBlock(editor, held, gesture.pointerY);
        // A press that never travelled is a click, and a click opens the menu.
        else openBlockMenuAt(editor, held, setMenuHold);
      }

      if (!editor.isDestroyed) endBlockDrag(editor);
      // Token-guarded by the kernel: a closer for a drag that was already
      // abandoned does nothing, so this is safe on every path.
      gesture.endDrag?.();
      setSeamIndex(null);
      setGesturing(false);
    },
    [editor],
  );

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const gesture = gestureRef.current;

      if (gesture && draggedBlockPos(editor.state) === null) {
        // A peer deleted the block under the pointer. The document has already
        // let go of it; the gesture has to as well, or the drop line keeps
        // hunting a seam on behalf of a block that no longer exists.
        finishGesture(false);
      } else if (gesture?.lifted) {
        // The seam is re-derived rather than mapped: the document moved under
        // a pointer that did not, and the line belongs under the pointer.
        setSeamIndex(seamIndexAtPointer(editor.view, gesture.pointerY));
      }

      const follow = (hold: BlockHold) => followBlock(editor.state, hold, transaction.mapping);
      setMenuHold((hold) => (hold === null ? hold : follow(hold)));
      setAnchorHold((hold) => {
        if (hold === null) return hold;
        const followed = follow(hold);
        // The hover intent still holds the old position; dropping the reveal
        // is how it finds out, and the next pointer move re-earns it.
        if (followed === null) intentRef.current?.cancel();
        return followed;
      });

      if (gestureRef.current || showingRef.current) remeasure((tick) => tick + 1);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, finishGesture]);

  /**
   * The touch path (§5.8, law 8). A tap has no hover to settle, so on coarse
   * input the handle belongs to whatever the tap landed on — the writer's own
   * caret is the approach.
   */
  useEffect(() => {
    if (!editable) return;
    const onSelection = () => {
      if (!coarseRef.current || gestureRef.current || editor.isDestroyed) return;
      const selected = blockForSelection(editor.state);
      setAnchorHold(selected ? holdBlock(editor.state, selected.pos) : null);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, editable]);

  // Approach: the pointer spends most of it in the margin, where `posAtCoords`
  // has nothing to say, so x is pulled into the column before asking.
  useEffect(() => {
    if (!editable || !chrome) return;
    const scroller = editor.view.dom.closest("[data-stable-layout-scroll]") ?? editor.view.dom;
    const chromeSelector = Object.entries(editorChromeAttributes(chrome))
      .map(([name, value]) => `[${name}="${value}"]`)
      .join("");

    const onPointerMove = (event: Event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType !== "mouse") {
        // A finger does not hover. Remember the hand and let the selection
        // path place the handle.
        coarseRef.current = true;
        return;
      }
      coarseRef.current = false;
      if (gestureRef.current || editor.isDestroyed) return;
      const block = blockUnderPointer(editor.view, pointer.clientX, pointer.clientY);
      if (block) intentRef.current?.enter(block.pos);
      else intentRef.current?.leave();
    };

    const onPointerLeave = (event: Event) => {
      if (coarseRef.current) return;
      // The handle is portalled out of the scroller, so travelling onto it
      // reads to the DOM as leaving the editor — and the browser delivers that
      // leave AFTER the handle's own enter, so a naive `leave()` here undoes
      // the reveal the writer was reaching for. THIS editor's own chrome is
      // still the editor: the approach continues. Another document's row open
      // beside it is not, which is why the mark carries a kernel id.
      const related = (event as PointerEvent).relatedTarget;
      if (related instanceof Element && related.closest(chromeSelector)) return;
      intentRef.current?.leave();
    };

    scroller.addEventListener("pointermove", onPointerMove);
    scroller.addEventListener("pointerleave", onPointerLeave);
    return () => {
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [editor, editable, chrome]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || !chrome || editor.isDestroyed) {
        return;
      }
      gesture.pointerY = event.clientY;

      if (!gesture.lifted) {
        const travelled =
          Math.abs(event.clientX - gesture.startX) + Math.abs(event.clientY - gesture.startY);
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

  /**
   * Escape belongs to the kernel's chain whenever the editor can hear it: the
   * chain cancels the gesture through the handler `beginDrag` was given, which
   * lands back in the finalizer, and law 3 gets its one key, one step. This
   * listener covers only what the chain cannot see — a press that began on
   * portalled chrome may have left focus outside the prose — and it stops the
   * key there so nothing else takes a second step on it.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gestureRef.current) return;
      if (editor.view.hasFocus()) return;
      event.preventDefault();
      event.stopPropagation();
      finishGesture(false);
    },
    [editor, finishGesture],
  );

  useEffect(() => {
    if (!gesturing) return;
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
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("lostpointercapture", abandon);
      window.removeEventListener("blur", abandon);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [gesturing, onPointerMove, onKeyDown, finishGesture]);

  // Nothing outlives an unmount: a surface torn down mid-drag would leave the
  // kernel suppressing chrome for a pointer nobody is following.
  useEffect(() => () => finishGesture(false), [finishGesture]);

  const runOnBlock = useCallback(
    (pos: number, build: BlockTransactionBuilder) => {
      const target = blockAt(editor.state.doc, pos);
      if (!target || !editor.isEditable) return;
      const transaction = build(editor.state, target);
      if (transaction) editor.view.dispatch(transaction);
    },
    [editor],
  );

  if (!editable || !chrome || typeof document === "undefined") return null;

  const targetPos = (menuHold ?? anchorHold)?.from ?? null;
  const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
  const dragging = seamIndex !== null;
  // The handle stays mounted for the whole gesture even while it is invisible:
  // it holds the pointer capture that keeps a touch drag from turning into a
  // page scroll.
  const handle = target ? blockHandlePosition(editor.view, target) : null;
  // No line on the two seams the block already sits between. Dropping there
  // moves nothing, and a jade line promising a landing is the silent rejection
  // law 5 forbids — said in paint rather than in a click.
  const line =
    seamIndex === null || restingSeam(editor, seamIndex)
      ? null
      : seamLinePosition(editor.view, seamIndex);
  const visible = !dragging && !suppressed && (hovered || menuHold !== null || coarseRef.current);

  return (
    <>
      {handle
        ? createPortal(
            <button
              ref={handleRef}
              type="button"
              className="meridian-block-handle"
              {...editorChromeAttributes(chrome)}
              data-state={visible ? "open" : dragging ? "dragging" : "closed"}
              aria-label={blockHandleLabel()}
              aria-haspopup="menu"
              aria-expanded={menuHold !== null}
              style={{
                top: handle.top,
                left: handle.left,
                width: BLOCK_HANDLE_WIDTH,
                height: BLOCK_HANDLE_HEIGHT,
              }}
              onPointerEnter={() => {
                if (targetPos !== null) intentRef.current?.enter(targetPos);
              }}
              onPointerLeave={() => {
                if (!coarseRef.current) intentRef.current?.leave();
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || targetPos === null || gestureRef.current) return;
                // Keep the caret and the focus exactly where the writer left
                // them: the press is about a block, not about where to type.
                event.preventDefault();
                if (event.pointerType !== "mouse") coarseRef.current = true;
                // Capture makes the browser hand the whole gesture over rather
                // than turning a touch drag into a page scroll halfway down.
                event.currentTarget.setPointerCapture?.(event.pointerId);
                gestureRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  pointerY: event.clientY,
                  lifted: false,
                  endDrag: null,
                };
                beginBlockDrag(editor, targetPos);
                setGesturing(true);
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
              {...editorChromeAttributes(chrome)}
              aria-hidden
              style={{ top: line.top, left: line.left, width: line.width }}
            />,
            document.body,
          )
        : null}

      {target && menuHold !== null && handle ? (
        <BlockMenu
          editor={editor}
          target={target}
          at={{ x: handle.left, y: handle.top }}
          open
          onOpenChange={(open) => {
            if (!open) setMenuHold(null);
          }}
          onMove={(direction) =>
            runOnBlock(menuHold.from, (state, source) =>
              moveBlockStepTransaction(state, source, direction),
            )
          }
          onDuplicate={() => runOnBlock(menuHold.from, duplicateBlockTransaction)}
          onDelete={() => runOnBlock(menuHold.from, deleteBlockTransaction)}
        />
      ) : null}
    </>
  );
}

/** Land the held block on whatever seam the pointer is over right now. */
function dropHeldBlock(editor: Editor, held: number, pointerY: number): void {
  const source = blockAt(editor.state.doc, held);
  if (!source) return;
  const seam = seamIndexAtPointer(editor.view, pointerY);
  const transaction = moveBlockToSeamTransaction(editor.state, source, seam);
  if (transaction) editor.view.dispatch(transaction);
}

/**
 * Open the menu for a block, standing the writer on it first.
 *
 * Law 1: pressing a block's handle READS that block — a caret in prose, a
 * selection on an object. The menu's verbs then run against the same selection
 * the toolbar's fence reads, which is what keeps one refusal rule behind both
 * surfaces.
 */
function openBlockMenuAt(editor: Editor, pos: number, open: (hold: BlockHold) => void): void {
  const target = blockAt(editor.state.doc, pos);
  if (!target) return;
  const selection = isEditorObject(target.node)
    ? selectObjectTransaction(editor.state, target.pos)
    : editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target.pos + 1)));
  if (selection) editor.view.dispatch(selection);
  // Held from the state the selection left behind: the block moved if the
  // press selected an object, and the menu belongs to where it is now.
  const hold = holdBlock(editor.state, target.pos);
  if (hold) open(hold);
}

function releasePointerCapture(element: HTMLElement | null, pointerId: number): void {
  if (!element?.hasPointerCapture?.(pointerId)) return;
  element.releasePointerCapture(pointerId);
}

/** True when `seamIndex` is one of the two edges the held block already has. */
function restingSeam(editor: Editor, seamIndex: number): boolean {
  const held = draggedBlockPos(editor.state);
  if (held === null) return false;
  const source = blockAt(editor.state.doc, held);
  return source !== null && (seamIndex === source.index || seamIndex === source.index + 1);
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
