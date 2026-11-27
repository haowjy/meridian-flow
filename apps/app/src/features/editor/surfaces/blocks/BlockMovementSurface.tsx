import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { holdBlock, type NodeHold, resolveBlockHold } from "@/core/editor/anchors";
import { CHROME_TIMING, editorChromeAttributes, hoverOwner } from "@/core/editor/chrome";
import { isEditorObject, selectObjectTransaction } from "@/core/editor/objects";

import { manuscriptOverlay } from "../../chrome/manuscript-overlay";
import {
  useChromeCoarsePointer,
  useChromeSuppressed,
  useEditorChrome,
} from "../../chrome/useEditorChrome";
import { type TakeNodeHold, useNodeHold } from "../../chrome/useNodeHold";
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
  const [anchorHold, takeAnchor] = useNodeHold(editor, resolveBlockHold);
  const [hovered, setHovered] = useState(false);
  const [menuHold, takeMenu] = useNodeHold(editor, resolveBlockHold);

  const editable = editor.isEditable;
  const targetPos = (menuHold ?? anchorHold)?.from ?? null;
  const targetPosRef = useRef<number | null>(null);
  targetPosRef.current = targetPos;

  const openMenu = useCallback(
    (pos: number) => openBlockMenuAt(editor, pos, takeMenu),
    [editor, takeMenu],
  );

  const gesture = useBlockMovementGesture({ editor, editable, onHandleClick: openMenu });
  useBlockMovementKeymap(editor, BLOCK_MOVEMENT_SURFACE_ID);

  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerHoverAnchor<NodeHold>({
      id: BLOCK_MOVEMENT_SURFACE_ID,
      probe: ({ x, y }) => {
        if (gesture.inFlight() || editor.isDestroyed) return null;
        const block = blockUnderPointer(editor.view, x, y);
        if (!block) return null;
        const owner = hoverOwner(editor.view, blockElement(editor.view, block.pos));
        const hold = holdBlock(editor.state, block.pos);
        return owner && hold ? { owner, value: hold } : null;
      },
      onSettle: (hold) => {
        setHovered(hold !== null);
        const at = hold && resolveBlockHold(editor.state, hold);
        if (at) takeAnchor(at.from);
      },
    });
  }, [chrome, editable, editor, gesture.inFlight, takeAnchor]);

  useEffect(() => {
    // A gesture keeps its anchor whatever the pointer is doing: the kernel
    // cancels the hover reveal the moment a drag begins, and letting the
    // handle unmount there would drop the pointer capture the drag is holding
    // — the browser would report lost capture and the drag would end on its
    // own first frame.
    if (anchorHold === null || hovered || menuHold !== null || gesture.active || coarse) return;
    const timer = window.setTimeout(() => takeAnchor(null), CHROME_TIMING.fadeMs);
    return () => window.clearTimeout(timer);
  }, [anchorHold, hovered, menuHold, gesture.active, coarse, takeAnchor]);

  useEffect(() => {
    if (!editable) return;
    const onSelection = () => {
      if (!coarse || gesture.inFlight() || editor.isDestroyed) return;
      const selected = blockForSelection(editor.state);
      takeAnchor(selected ? selected.pos : null);
    };
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, editable, coarse, gesture.inFlight, takeAnchor]);

  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerContextClaim({
      id: "grip",
      claim: ({ element }) => {
        if (!element.closest("[data-block-handle]")) return false;
        if (gesture.inFlight()) return false;
        const pos = targetPosRef.current;
        if (pos === null) return false;
        openMenu(pos);
        return true;
      },
    });
  }, [chrome, editable, gesture.inFlight, openMenu]);

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
            if (!open) takeMenu(null);
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

function openBlockMenuAt(editor: Editor, pos: number, open: TakeNodeHold): void {
  const target = blockAt(editor.state.doc, pos);
  if (!target) return;
  const selection = isEditorObject(target.node)
    ? selectObjectTransaction(editor.state, target.pos)
    : editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target.pos + 1)));
  if (selection) editor.view.dispatch(selection);
  open(target.pos);
}
