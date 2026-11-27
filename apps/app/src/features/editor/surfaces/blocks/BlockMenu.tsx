import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, CopyPlus, Trash2, Type } from "lucide-react";

import { isEditorObject } from "@/core/editor/objects";

import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
} from "../../chrome/EditorMenu";
import {
  BLOCK_TYPE_IDS,
  BlockTypeMenuItem,
  blockTypeReasonMessage,
  blockTypeStates,
} from "../toolbar";
import { blockMenuLabel, blockMoveShortcut } from "./block-copy";
import type { BlockTarget } from "./block-targets";

export type BlockMenuProps = {
  editor: Editor;
  target: BlockTarget;
  at: { x: number; y: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (direction: "up" | "down") => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

export function BlockMenu({
  editor,
  target,
  at,
  open,
  onOpenChange,
  onMove,
  onDuplicate,
  onDelete,
}: BlockMenuProps) {
  const lastIndex = editor.state.doc.childCount - 1;

  return (
    <EditorMenu
      editor={editor}
      id="block-menu"
      open={open}
      onOpenChange={onOpenChange}
      at={at}
      side="left"
      align="start"
      className="min-w-56"
    >
      {target.index > 0 ? (
        <EditorMenuItem onSelect={() => onMove("up")} note={blockMoveShortcut("up")}>
          <ArrowUp aria-hidden />
          {blockMenuLabel("moveUp")}
        </EditorMenuItem>
      ) : null}
      {target.index < lastIndex ? (
        <EditorMenuItem onSelect={() => onMove("down")} note={blockMoveShortcut("down")}>
          <ArrowDown aria-hidden />
          {blockMenuLabel("moveDown")}
        </EditorMenuItem>
      ) : null}
      <EditorMenuItem onSelect={onDuplicate}>
        <CopyPlus aria-hidden />
        {blockMenuLabel("duplicate")}
      </EditorMenuItem>
      <TurnIntoSection editor={editor} target={target} />
      <EditorMenuSeparator />
      <EditorMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 aria-hidden />
        {blockMenuLabel("delete")}
      </EditorMenuItem>
    </EditorMenu>
  );
}

function TurnIntoSection({ editor, target }: { editor: Editor; target: BlockTarget }) {
  if (!target.node.isTextblock || isEditorObject(target.node)) return null;

  const states = blockTypeStates(editor);
  const targets = BLOCK_TYPE_IDS.map((id) => ({ id, ...states[id] }));
  const refused = targets.filter((option) => option.blockedBy);
  const reason = refused[0]?.blockedBy ? blockTypeReasonMessage(refused[0].blockedBy) : null;

  if (refused.length === targets.length) {
    return (
      <EditorMenuItem blockedReason={reason}>
        <Type aria-hidden />
        {blockMenuLabel("turnInto")}
      </EditorMenuItem>
    );
  }

  return (
    <EditorMenuSub>
      <EditorMenuSubTrigger>
        <Type aria-hidden />
        {blockMenuLabel("turnInto")}
      </EditorMenuSubTrigger>
      <EditorMenuSubContent className="min-w-48">
        {targets.map((option) => (
          <BlockTypeMenuItem
            key={option.id}
            editor={editor}
            id={option.id}
            active={option.active}
            blockedReason={option.blockedBy ? blockTypeReasonMessage(option.blockedBy) : null}
          />
        ))}
      </EditorMenuSubContent>
    </EditorMenuSub>
  );
}
