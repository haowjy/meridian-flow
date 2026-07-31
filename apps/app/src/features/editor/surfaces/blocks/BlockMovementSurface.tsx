/**
 * Block movement (§5.8): the handle in the margin, the drag with its jade drop
 * line, the block menu, and Alt+↑/↓.
 *
 * One surface owns all four because they are one verb with four doors — the
 * writer moves a block by dragging it, by pressing a key, or by choosing a
 * menu row, and every door ends in the same transaction. What each half of that
 * changes for is its own module:
 *
 * - the document half is `block-targets.ts`, the measuring half `block-geometry.ts`;
 * - the drag, from either door to the one finalizer, is `block-gesture.ts`;
 * - where the handle and the drop line are drawn is `block-placement.ts`;
 * - Alt+↑/↓ and its place in the kernel's ladder is `block-keymap.ts`.
 *
 * What is left here is what the writer sees and which block it is about: the
 * approach that reveals the handle, the hold the menu stands on, and the
 * composition of the rest. It decides nothing about the document itself.
 *
 * **Every position held across a transaction goes through `followBlock`** (law
 * 9: nothing gates a write). A block a peer deleted must take its chrome with
 * it rather than handing Delete to the neighbour, and a peer's write moves
 * every position in the document at once.
 *
 * The kernel owns the timing and the standing-down. Hover comes from
 * `chrome.registerHoverAnchor`; suppression, the Esc chain, and the drag token
 * are all its.
 */

import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { followBlock, holdBlock, type NodeHold } from "@/core/editor/anchors";
// Straight at the primitives rather than through `chrome/index.ts`: that
// barrel also carries the surface registry this file is listed in, so the
// barrel route is a module cycle (and a real one — Vite reported the
// registry's own export read before initialization).
import { CHROME_TIMING, editorChromeAttributes, hoverOwner } from "@/core/editor/chrome";
import { isEditorObject, selectObjectTransaction } from "@/core/editor/objects";

import { manuscriptOverlay } from "../../chrome/manuscript-overlay";
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
  blockUnderPointer,
} from "./block-geometry";
import { useBlockMovementGesture } from "./block-gesture";
import { useBlockMovementKeymap } from "./block-keymap";
import { useBlockChromePlacement } from "./block-placement";
import {
  type BlockTarget,
  blockAt,
  blockForSelection,
  deleteBlockTransaction,
  duplicateBlockTransaction,
  moveBlockStepTransaction,
} from "./block-targets";
import "./block-movement.css";

/** Names this surface in `EDITOR_CHROME_SURFACES` and in probes. */
export const BLOCK_MOVEMENT_SURFACE_ID = "block-movement";

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

  const editable = editor.isEditable;
  const targetPos = (menuHold ?? anchorHold)?.from ?? null;
  /**
   * The block the visible handle belongs to, for the door that fires outside
   * React's own event flow. Fed by render rather than remembered per-element
   * (the way an object's row has to be): there is only ever one handle, and it
   * exists only once the approach has already settled on a block.
   */
  const targetPosRef = useRef<number | null>(null);
  targetPosRef.current = targetPos;

  const gesture = useBlockMovementGesture({
    editor,
    editable,
    onHandleClick: (pos) => openBlockMenuAt(editor, pos, setMenuHold),
  });
  useBlockMovementKeymap(editor, BLOCK_MOVEMENT_SURFACE_ID);

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
        if (gesture.inFlight() || editor.isDestroyed) return null;
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
  }, [chrome, editable, editor, gesture.inFlight]);

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
    if (anchorHold === null || hovered || menuHold !== null || gesture.active || coarse) return;
    const timer = window.setTimeout(() => setAnchorHold(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [anchorHold, hovered, menuHold, gesture.active, coarse]);

  /**
   * Both holds travel with the document.
   *
   * A block a peer deleted takes its handle and its menu with it: `followBlock`
   * answers null once the node is gone, and null is this surface's dismissal.
   * The kernel re-asks what is under the pointer on the same transaction, so
   * nothing here has to tell the approach that its target has changed.
   */
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const follow = (hold: NodeHold) => followBlock(editor.state, hold, transaction.mapping);
      setMenuHold((hold) => (hold === null ? hold : follow(hold)));
      setAnchorHold((hold) => (hold === null ? hold : follow(hold)));
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  /**
   * The touch path (§5.8, law 8). A tap has no hover to settle, so on coarse
   * input the handle belongs to whatever the tap landed on — the writer's own
   * caret is the approach.
   */
  useEffect(() => {
    if (!editable) return;
    const onSelection = () => {
      if (!coarse || gesture.inFlight() || editor.isDestroyed) return;
      const selected = blockForSelection(editor.state);
      setAnchorHold(selected ? holdBlock(editor.state, selected.pos) : null);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, editable, coarse, gesture.inFlight]);

  /**
   * The handle's right-click (§5.1's claim ladder, `grip` rung).
   *
   * The grip is chrome drawn outside the frame, so a right-click on it is a
   * question about the block, never about the page: it opens the same menu the
   * click opens, through the same call. Not claiming would leave the browser's
   * menu over a control the browser knows nothing about — and the kernel's
   * default IS the native menu, so a surface that registers nothing gets it by
   * saying nothing.
   *
   * The claim is registered once and reads the handle's block live: it answers
   * whatever the handle is standing on when the writer presses, and a
   * registration per hovered block would churn the kernel's list all day.
   */
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerContextClaim({
      id: "grip",
      claim: ({ element }) => {
        if (!element.closest("[data-block-handle]")) return false;
        // A right-click with the pointer already down is not a menu request,
        // and the drag under it still owns the gesture.
        if (gesture.inFlight()) return false;
        const pos = targetPosRef.current;
        if (pos === null) return false;
        openBlockMenuAt(editor, pos, setMenuHold);
        return true;
      },
    });
  }, [chrome, editable, editor, gesture.inFlight]);

  const runOnBlock = useCallback(
    (pos: number, build: BlockTransactionBuilder) => {
      const target = blockAt(editor.state.doc, pos);
      if (!target || !editor.isEditable) return;
      const transaction = build(editor.state, target);
      if (transaction) editor.view.dispatch(transaction);
    },
    [editor],
  );

  const { handle, line } = useBlockChromePlacement(editor, targetPos, gesture.seamIndex);
  const overlay = manuscriptOverlay(editor);
  // The menu hangs off the handle in the POINTER's space, which is the one
  // Radix positions in. The handle's own placement is in the pane's, so the
  // element is what carries the answer across the two.
  const [handleElement, setHandleElement] = useState<HTMLButtonElement | null>(null);

  if (!editable || !chrome || !overlay || typeof document === "undefined") return null;

  const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
  const dragging = gesture.seamIndex !== null;
  const visible = !dragging && !suppressed && (hovered || menuHold !== null || coarse);

  return (
    <>
      {/* The handle stays mounted for the whole gesture even while it is
          invisible: it holds the pointer capture that keeps a touch drag from
          turning into a page scroll. */}
      {handle
        ? createPortal(
            <button
              ref={setHandleElement}
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
                if (event.button !== 0 || targetPos === null || gesture.inFlight()) return;
                // Keep the caret and the focus exactly where the writer left
                // them: the press is about a block, not about where to type.
                event.preventDefault();
                // Capture makes the browser hand the whole gesture over rather
                // than turning a touch drag into a page scroll halfway down.
                gesture.pressHandle(event, targetPos, event.currentTarget);
              }}
            >
              <GripVertical aria-hidden />
            </button>,
            overlay,
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
            overlay,
          )
        : null}

      {target && menuHold !== null && handleElement ? (
        <BlockMenu
          editor={editor}
          target={target}
          at={handleAnchorPoint(handleElement)}
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

/**
 * The handle's top-left in the pointer's own space, which is where Radix hangs
 * a menu from.
 *
 * Read off the element rather than passed down from the placement, because the
 * two are in different coordinate spaces on purpose: the handle is drawn in the
 * manuscript pane's, and the pane is what carries it through a scroll.
 */
function handleAnchorPoint(handle: HTMLElement): { x: number; y: number } {
  const box = handle.getBoundingClientRect();
  return { x: box.left, y: box.top };
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
