/**
 * The block menu: what the handle opens (§5.8).
 *
 * Five verbs about one block — move up, move down, duplicate, turn into,
 * delete — anchored at the handle so the manuscript stays readable beside it.
 *
 * Two law-5 shapes, and the difference is deliberate. A move that has nowhere
 * to go is ABSENT: a block already at the top of the document has no "up", and
 * saying so would be a row that exists to be dead. A conversion that the
 * schema refuses is PRESENT with its reason in view, because the writer asked
 * for something real and is owed the answer — a code fence keeps its language,
 * an embedded component keeps its props. The reason is rendered text rather
 * than a tooltip, which is why these items may take Radix's `disabled`: the
 * toolbar greys instead only because its reasons live in tooltips, and a
 * disabled button never opens one.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code,
  CopyPlus,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Pilcrow,
  TextQuote,
  Trash2,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";

import { isEditorObject } from "@/core/editor/objects";
import { cn } from "@/lib/utils";

import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuLabel,
  EditorMenuSeparator,
  EditorMenuShortcut,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
} from "../../chrome";
import { blockTypeReasonMessage } from "../toolbar";
import { blockMenuLabel, blockMoveShortcut, turnIntoLabel } from "./block-copy";
import type { BlockTarget } from "./block-targets";
import { applyTurnInto, type TurnIntoTargetId, turnIntoTargets } from "./turn-into";

export type BlockMenuProps = {
  editor: Editor;
  /** The block the handle points at, re-resolved on every render. */
  target: BlockTarget;
  /** The handle's own position: the menu hangs off it, not off the pointer. */
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
      // Left of the margin the handle already lives in, so the menu never
      // covers the sentence the writer is deciding about.
      side="left"
      align="start"
      className="min-w-56"
    >
      {target.index > 0 ? (
        <EditorMenuItem onSelect={() => onMove("up")}>
          <ArrowUp aria-hidden />
          {blockMenuLabel("moveUp")}
          <EditorMenuShortcut>{blockMoveShortcut("up")}</EditorMenuShortcut>
        </EditorMenuItem>
      ) : null}
      {target.index < lastIndex ? (
        <EditorMenuItem onSelect={() => onMove("down")}>
          <ArrowDown aria-hidden />
          {blockMenuLabel("moveDown")}
          <EditorMenuShortcut>{blockMoveShortcut("down")}</EditorMenuShortcut>
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

/**
 * Turn into is for text blocks (§5.8). A figure, a table, a rule, or a rendered
 * diagram has no block type to change, so the row is absent rather than
 * present and refusing — the deepest form of law 5.
 */
function TurnIntoSection({ editor, target }: { editor: Editor; target: BlockTarget }) {
  if (!target.node.isTextblock || isEditorObject(target.node)) return null;

  const targets = turnIntoTargets(editor);
  const refused = targets.filter((option) => option.blockedBy);
  const reason = refused[0]?.blockedBy ? blockTypeReasonMessage(refused[0].blockedBy) : null;

  // Nothing here can run: one row carrying the answer beats a submenu of eight
  // dead ones.
  if (refused.length === targets.length) {
    return (
      <EditorMenuItem disabled className="flex-col items-start gap-0.5">
        <span className="flex items-center gap-2">
          <Type aria-hidden />
          {blockMenuLabel("turnInto")}
        </span>
        {reason ? <span className="pl-6 text-muted-foreground text-xs">{reason}</span> : null}
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
        {reason ? (
          <EditorMenuLabel className="font-normal text-muted-foreground text-xs">
            {reason}
          </EditorMenuLabel>
        ) : null}
        {targets.map((option) => (
          <EditorMenuItem
            key={option.id}
            disabled={Boolean(option.blockedBy)}
            onSelect={() => applyTurnInto(editor, option.id)}
          >
            {turnIntoIcon(option.id)}
            <span className={cn(option.active && "font-medium")}>{turnIntoLabel(option.id)}</span>
            {option.active ? (
              <Check className="ml-auto text-foreground" aria-label={t`Current block type`} />
            ) : null}
          </EditorMenuItem>
        ))}
      </EditorMenuSubContent>
    </EditorMenuSub>
  );
}

function turnIntoIcon(id: TurnIntoTargetId): ReactNode {
  switch (id) {
    case "paragraph":
      return <Pilcrow aria-hidden />;
    case "heading1":
      return <Heading1 aria-hidden />;
    case "heading2":
      return <Heading2 aria-hidden />;
    case "heading3":
      return <Heading3 aria-hidden />;
    case "bulletList":
      return <List aria-hidden />;
    case "orderedList":
      return <ListOrdered aria-hidden />;
    case "quote":
      return <TextQuote aria-hidden />;
    case "codeBlock":
      return <Code aria-hidden />;
  }
}
