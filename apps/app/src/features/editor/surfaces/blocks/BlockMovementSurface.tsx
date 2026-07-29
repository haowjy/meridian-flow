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
 * The drag has two starting places and one gesture. The margin handle is one;
 * the body of a block object — a figure, a rule, a rendered diagram — is the
 * other, because direct manipulation is what a writer reaches for first: you
 * grab the thing and pull it where it goes. An object that lands inline is
 * not this gesture at all: it goes through ProseMirror's own drag, which
 * carries it between two words. Which drag a body starts is a registration
 * (`EDITOR_OBJECT_TYPES`), never a node name read here.
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { followBlock, holdBlock, type NodeHold } from "@/core/editor/anchors";
import { beginBlockDrag, draggedBlockPos, endBlockDrag, liftBlockDrag } from "@/core/editor/blocks";
// Straight at the primitives rather than through `chrome/index.ts`: that
// barrel also carries the surface registry this file is listed in, so the
// barrel route is a module cycle (and a real one — Vite reported the
// registry's own export read before initialization).
import {
  CHROME_TIMING,
  editorChromeAttributes,
  hoverOwner,
  type KeymapBinding,
  watchManuscriptLayout,
} from "@/core/editor/chrome";
import { isEditorObject, selectObjectTransaction } from "@/core/editor/objects";

import {
  useChromeCoarsePointer,
  useChromeSuppressed,
  useEditorChrome,
} from "../../chrome/useEditorChrome";
import { BlockMenu } from "./BlockMenu";
import { blockHandleLabel } from "./block-copy";
import {
  BLOCK_HANDLE_HEIGHT,
  BLOCK_HANDLE_WIDTH,
  blockElement,
  blockHandlePosition,
  blockUnderPointer,
  nativeDragCarriesObject,
  objectBodyDragTarget,
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
import "./block-movement.css";

/** Names this surface in `EDITOR_CHROME_SURFACES` and in probes. */
export const BLOCK_MOVEMENT_SURFACE_ID = "block-movement";

/**
 * Pointer travel that turns a press into a drag, not a click. Straight-line
 * distance: summing the axes made a 2px diagonal jitter — a hand resting on a
 * mouse — read as 4px of travel, so the block faded for a gesture that never
 * went anywhere.
 */
const DRAG_SLOP_PX = 4;

/**
 * Which door the press came through. The gesture is the same one either way;
 * only the click at the end of a press that never travelled differs — the
 * handle's click opens the menu, and an object's body leaves the click to
 * ProseMirror, which puts the jade ring on it (law 1).
 */
type DragSource = "handle" | "body";

/**
 * A press that may become a drag, from the moment it lands to whatever ends it.
 *
 * The drop target is NOT stored. It is derived from `pointerY` every time it
 * is needed, because a child index goes stale the instant a peer inserts a
 * block above, and the jade line would then promise a seam the drop would
 * miss. The pointer is the writer's intent and the geometry under it is the
 * truth; a seam is only ever a reading of the two.
 */
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
  /**
   * The element holding the pointer, when the press took capture. Only the
   * handle does: capture retargets the mouse events ProseMirror reads to
   * decide a click, and a body press has to leave that reading alone.
   */
  capture: HTMLElement | null;
};

/** What the gesture needs from a press, whether React or the DOM delivered it. */
type Press = Pick<PointerEvent, "pointerId" | "clientX" | "clientY">;

type BlockTransactionBuilder = (state: Editor["state"], source: BlockTarget) => Transaction | null;

export function BlockMovementSurface({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const coarse = useChromeCoarsePointer(editor);

  // What the handle points at, and whether the pointer is currently on it.
  // ONE hold, deliberately: the hover intent used to keep its own copy, and a
  // copy that changes do not carry is a handle that walks back onto a block a
  // peer moved out from under it.
  const [anchorHold, setAnchorHold] = useState<NodeHold | null>(null);
  const [hovered, setHovered] = useState(false);
  const [menuHold, setMenuHold] = useState<NodeHold | null>(null);
  const [seamIndex, setSeamIndex] = useState<number | null>(null);
  const [gesturing, setGesturing] = useState(false);

  const gestureRef = useRef<Gesture | null>(null);
  /**
   * The block the visible handle belongs to, for the doors that fire outside
   * React's own event flow. Fed by render rather than remembered per-element
   * (the way an object's row has to be): there is only ever one handle, and it
   * exists only once the approach has already settled on a block.
   */
  const targetPosRef = useRef<number | null>(null);

  const editable = editor.isEditable;

  useBlockMovementKeymap(editor);

  /**
   * The approach (§5.8). The pointer spends most of it in the margin, where
   * `posAtCoords` has nothing to say, so `blockUnderPointer` pulls x into the
   * column before asking.
   *
   * The kernel decides WHEN the pointer is believed and WHICH block owns
   * chrome; this only answers "which block is under this point". That is what
   * keeps the handle and an object's own controls on one block rather than on
   * two, and it is what re-aims the handle when the pane scrolls under a hand
   * that never moved.
   */
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerHoverAnchor<number>({
      id: BLOCK_MOVEMENT_SURFACE_ID,
      probe: ({ x, y }) => {
        if (gestureRef.current || editor.isDestroyed) return null;
        const block = blockUnderPointer(editor.view, x, y);
        if (!block) return null;
        const owner = hoverOwner(editor.view, blockElement(editor.view, block.pos));
        return owner ? { owner, value: block.pos } : null;
      },
      onSettle: (pos) => {
        setHovered(pos !== null);
        if (pos !== null) setAnchorHold(holdBlock(editor.state, pos));
      },
    });
  }, [chrome, editable, editor]);

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
    if (anchorHold === null || hovered || menuHold !== null || gesturing || coarse) return;
    const timer = window.setTimeout(() => setAnchorHold(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [anchorHold, hovered, menuHold, gesturing, coarse]);

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

      releasePointerCapture(gesture.capture, gesture.pointerId);
      const held = editor.isDestroyed ? null : draggedBlockPos(editor.state);

      if (commit && held !== null && !editor.isDestroyed) {
        if (gesture.lifted) dropHeldBlock(editor, held, gesture.pointerY);
        // A press that never travelled is a click. The handle's click opens
        // the menu; an object's body leaves the click alone, and ProseMirror
        // is already turning it into the jade ring (law 1).
        else if (gesture.source === "handle") openBlockMenuAt(editor, held, setMenuHold);
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

  /**
   * Take the press. Both doors land here, so the handle and an object's body
   * start ONE gesture: the same hold in the document, the same kernel token
   * once it lifts, the same finalizer whatever ends it.
   */
  const beginGesture = useCallback(
    (press: Press, pos: number, source: DragSource, capture: HTMLElement | null) => {
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
      setGesturing(true);
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

      const follow = (hold: NodeHold) => followBlock(editor.state, hold, transaction.mapping);
      setMenuHold((hold) => (hold === null ? hold : follow(hold)));
      // A block a peer deleted takes its handle with it. The kernel re-asks
      // what is under the pointer on the same transaction, so nothing here has
      // to tell the approach that its target is gone.
      setAnchorHold((hold) => (hold === null ? hold : follow(hold)));
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
      if (!coarse || gestureRef.current || editor.isDestroyed) return;
      const selected = blockForSelection(editor.state);
      setAnchorHold(selected ? holdBlock(editor.state, selected.pos) : null);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, editable, coarse]);

  /**
   * The handle's right-click (§5.1's claim ladder, `grip` rung).
   *
   * The grip is chrome drawn outside the frame, so a right-click on it is a
   * question about the block, never about the page: it opens the same menu the
   * click opens, through the same call. Not claiming would leave the browser's
   * menu over a control the browser knows nothing about — and the kernel's
   * default IS the native menu, so a surface that registers nothing gets it by
   * saying nothing.
   */
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerContextClaim({
      id: "grip",
      claim: ({ element }) => {
        if (!element.closest("[data-block-handle]")) return false;
        // A right-click with the pointer already down is not a menu request,
        // and the drag under it still owns the gesture.
        if (gestureRef.current) return false;
        const pos = targetPosRef.current;
        if (pos === null) return false;
        openBlockMenuAt(editor, pos, setMenuHold);
        return true;
      },
    });
  }, [chrome, editable, editor]);

  /**
   * The object door: a press on the body of an object the registry drags as a
   * block starts the drag the handle starts, on that object's top-level block.
   *
   * The press is NOT prevented. A press that never travels is a click, and
   * law 1's click has to reach ProseMirror to put the jade ring on the object.
   * What has to be stopped is what the browser would do with the press
   * INSTEAD, and the two answers are stopped on different terms:
   *
   * - **Its own drag**, refused over a BLOCK object. ProseMirror arms it on
   *   mousedown (a picture is `draggable` in the schema, a selected node is
   *   draggable whatever the schema says), it shows no block drop line, and it
   *   moves the node by serializing and re-parsing it — which brought a figure
   *   back as a bare paragraph. Over an object that lands inline that same
   *   drag is the RIGHT one and is left alone: it carries an inline slice, the
   *   dropcursor draws the caret between characters, and the drop is one
   *   transaction (human ruling, 2026-07-29).
   * - **A text selection** growing out of the object across everything the
   *   pointer crosses, refused while this gesture owns the pointer. Prose
   *   that merely runs THROUGH an object is untouched: that selection starts
   *   somewhere else, and this gesture never begins.
   *
   * Mouse only. A finger has no cursor to aim with and a drag under it is the
   * page scrolling; touch moves a block through the handle it taps (law 8).
   */
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

  const targetPos = (menuHold ?? anchorHold)?.from ?? null;
  targetPosRef.current = targetPos;
  const { handle, line } = useBlockChromePlacement(editor, targetPos, seamIndex);

  if (!editable || !chrome || typeof document === "undefined") return null;

  const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
  const dragging = seamIndex !== null;
  const visible = !dragging && !suppressed && (hovered || menuHold !== null || coarse);

  return (
    <>
      {/* The handle stays mounted for the whole gesture even while it is
          invisible: it holds the pointer capture that keeps a touch drag from
          turning into a page scroll. */}
      {handle
        ? createPortal(
            <button
              type="button"
              className="meridian-block-handle"
              data-block-handle
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
              onPointerDown={(event) => {
                if (event.button !== 0 || targetPos === null || gestureRef.current) return;
                // Keep the caret and the focus exactly where the writer left
                // them: the press is about a block, not about where to type.
                event.preventDefault();
                // Capture makes the browser hand the whole gesture over rather
                // than turning a touch drag into a page scroll halfway down.
                beginGesture(event, targetPos, "handle", event.currentTarget);
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

type BlockChromePlacement = {
  handle: ReturnType<typeof blockHandlePosition>;
  line: ReturnType<typeof seamLinePosition>;
};

const NO_BLOCK_CHROME: BlockChromePlacement = { handle: null, line: null };

/**
 * Where the handle and the drop line go, measured on a frame rather than in
 * render.
 *
 * Both readings are `getBoundingClientRect` and `getComputedStyle` against a
 * DOM ProseMirror has only just rewritten, and this surface re-renders on
 * every transaction — the writer's own keystrokes, a peer typing, an AI write
 * landing. Measuring them in render forced a synchronous layout on each one.
 * A frame coalesces the burst, and the state only moves when the numbers did,
 * so a transaction that changed nothing on screen costs one measurement and no
 * render at all.
 *
 * WHICH signals mean "measure again" is not this surface's question. A block
 * travels for reasons a `ResizeObserver` on one element never sees — three
 * paragraphs inserted above, the pane scrolling under a hand that never moved,
 * a diagram finishing its render — and every floating surface in the editor
 * needs the same list, so they share one: `watchManuscriptLayout`.
 */
function useBlockChromePlacement(
  editor: Editor,
  targetPos: number | null,
  seamIndex: number | null,
): BlockChromePlacement {
  const [placement, setPlacement] = useState<BlockChromePlacement>(NO_BLOCK_CHROME);

  useLayoutEffect(() => {
    const measure = () => {
      if (editor.isDestroyed) return;
      const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
      const next: BlockChromePlacement = {
        handle: target ? blockHandlePosition(editor.view, target) : null,
        // No line on the two seams the block already sits between. Dropping
        // there moves nothing, and a jade line promising a landing is the
        // silent rejection law 5 forbids — said in paint rather than in a click.
        line:
          seamIndex === null || restingSeam(editor, seamIndex)
            ? null
            : seamLinePosition(editor.view, seamIndex),
      };
      setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
    };

    // The pointer's own moves are measured at once: the drop line belongs
    // under the pointer on the frame the writer moved it, not the one after.
    // Everything else is a frame late, which is what the shared watcher coalesces to.
    measure();
    return watchManuscriptLayout(editor, [], measure);
  }, [editor, targetPos, seamIndex]);

  return placement;
}

function samePlacement(a: BlockChromePlacement, b: BlockChromePlacement): boolean {
  return (
    a.handle?.top === b.handle?.top &&
    a.handle?.left === b.handle?.left &&
    a.line?.top === b.line?.top &&
    a.line?.left === b.line?.left &&
    a.line?.width === b.line?.width
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
function openBlockMenuAt(editor: Editor, pos: number, open: (hold: NodeHold) => void): void {
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
