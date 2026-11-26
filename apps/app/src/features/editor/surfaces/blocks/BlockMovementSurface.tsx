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
  const targetPosRef = useRef<number | null>(null);
  targetPosRef.current = targetPos;

  const gesture = useBlockMovementGesture({
    editor,
    editable,
    onHandleClick: (pos) => openBlockMenuAt(editor, pos, setMenuHold),
  });
  useBlockMovementKeymap(editor, BLOCK_MOVEMENT_SURFACE_ID);

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
  const [handleElement, setHandleElement] = useState<HTMLButtonElement | null>(null);

  if (!editable || !chrome || !overlay || typeof document === "undefined") return null;

  const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
  const dragging = gesture.seamIndex !== null;
  const visible = !dragging && !suppressed && (hovered || menuHold !== null || coarse);

  return (
    <>
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
                event.preventDefault();
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

function handleAnchorPoint(handle: HTMLElement): { x: number; y: number } {
  const box = handle.getBoundingClientRect();
  return { x: box.left, y: box.top };
}

function openBlockMenuAt(editor: Editor, pos: number, open: (hold: NodeHold) => void): void {
  const target = blockAt(editor.state.doc, pos);
  if (!target) return;
  const selection = isEditorObject(target.node)
    ? selectObjectTransaction(editor.state, target.pos)
    : editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target.pos + 1)));
  if (selection) editor.view.dispatch(selection);
  const hold = holdBlock(editor.state, target.pos);
  if (hold) open(hold);
}
