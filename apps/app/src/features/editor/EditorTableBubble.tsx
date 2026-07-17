/** Contextual controls for editing the table containing the current selection. */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Plus,
  RotateCcw,
  Rows3,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  addTableRow,
  alignTableColumn,
  moveTableColumn,
  moveTableRow,
  resetTableLayout,
  type TableSelection,
  tableSelection,
} from "@/core/editor/table-operations";
import type { BubbleContext, BubbleMatch } from "./EditorBubbleHost";

export function matchTable(editor: Editor): BubbleMatch | null {
  if (!editor.isEditable) return null;
  const selection = tableSelection(editor.state);
  return selection
    ? {
        from: selection.tablePos,
        to: selection.tablePos + selection.table.nodeSize,
        nodePos: selection.tablePos,
        identity: selection.table,
      }
    : null;
}

export const tableBubbleContext: BubbleContext = {
  id: "table",
  anchor: "node-top",
  accessibleName: () => t`Edit table`,
  match: matchTable,
  Component: TableBubble,
};

export function tableOperationAvailability(selection: TableSelection) {
  const rowCount = selection.table.childCount;
  const columnCount = selection.table.firstChild?.childCount ?? 0;
  const touchesHeader = selection.rowFrom === 0;
  const selectedColumnCount = selection.columnTo - selection.columnFrom + 1;
  return {
    addRowAbove: !touchesHeader,
    addRowBelow: true,
    moveRowUp: selection.rowFrom > 1,
    moveRowDown: !touchesHeader && selection.rowTo < rowCount - 1,
    deleteRow: !touchesHeader,
    moveColumnLeft: selection.columnFrom > 0,
    moveColumnRight: selection.columnTo < columnCount - 1,
    deleteColumn: selectedColumnCount < columnCount,
  };
}

function run(editor: Editor, command: Command) {
  command(editor.state, editor.view.dispatch);
  editor.commands.focus();
}

function ToolButton({
  label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={pressed || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset
      className="flex items-center gap-0.5 border-border-subtle border-r pr-1"
      aria-label={label}
    >
      {children}
    </fieldset>
  );
}

function TableBubble({ editor }: { editor: Editor; match: BubbleMatch }) {
  const selection = tableSelection(editor.state);
  if (!selection) return null;

  const availability = tableOperationAvailability(selection);
  const header = selection.table.firstChild;
  const selectedAlignments = new Set(
    Array.from(
      { length: selection.columnTo - selection.columnFrom + 1 },
      (_, offset) => header?.child(selection.columnFrom + offset).attrs.alignment ?? "left",
    ),
  );
  const alignment = selectedAlignments.size === 1 ? selectedAlignments.values().next().value : null;

  return (
    <div className="flex items-center gap-1 p-1">
      <Group label={t`Rows`}>
        <ToolButton
          label={t`Add row above`}
          disabled={!availability.addRowAbove}
          onClick={() => run(editor, addTableRow("above"))}
        >
          <span className="relative">
            <Rows3 className="size-3.5" aria-hidden />
            <Plus className="-right-1 -top-1 absolute size-2.5" aria-hidden />
          </span>
        </ToolButton>
        <ToolButton
          label={t`Add row below`}
          disabled={!availability.addRowBelow}
          onClick={() => run(editor, addTableRow("below"))}
        >
          <span className="relative">
            <Rows3 className="size-3.5" aria-hidden />
            <Plus className="-bottom-1 -right-1 absolute size-2.5" aria-hidden />
          </span>
        </ToolButton>
        <ToolButton
          label={t`Move row up`}
          disabled={!availability.moveRowUp}
          onClick={() => run(editor, moveTableRow(-1))}
        >
          <ArrowUp className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Move row down`}
          disabled={!availability.moveRowDown}
          onClick={() => run(editor, moveTableRow(1))}
        >
          <ArrowDown className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Delete row`}
          disabled={!availability.deleteRow}
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </ToolButton>
      </Group>

      <Group label={t`Columns`}>
        <ToolButton
          label={t`Add column left`}
          onClick={() => editor.chain().focus().addColumnBefore().run()}
        >
          <span className="relative">
            <Columns3 className="size-3.5" aria-hidden />
            <Plus className="-left-1 -top-1 absolute size-2.5" aria-hidden />
          </span>
        </ToolButton>
        <ToolButton
          label={t`Add column right`}
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          <span className="relative">
            <Columns3 className="size-3.5" aria-hidden />
            <Plus className="-right-1 -top-1 absolute size-2.5" aria-hidden />
          </span>
        </ToolButton>
        <ToolButton
          label={t`Move column left`}
          disabled={!availability.moveColumnLeft}
          onClick={() => run(editor, moveTableColumn(-1))}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Move column right`}
          disabled={!availability.moveColumnRight}
          onClick={() => run(editor, moveTableColumn(1))}
        >
          <ArrowRight className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Delete column`}
          disabled={!availability.deleteColumn}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </ToolButton>
      </Group>

      <Group label={t`Column text alignment`}>
        <ToolButton
          label={t`Align column left`}
          pressed={alignment === "left"}
          onClick={() => run(editor, alignTableColumn("left"))}
        >
          <AlignLeft className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Align column center`}
          pressed={alignment === "center"}
          onClick={() => run(editor, alignTableColumn("center"))}
        >
          <AlignCenter className="size-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t`Align column right`}
          pressed={alignment === "right"}
          onClick={() => run(editor, alignTableColumn("right"))}
        >
          <AlignRight className="size-3.5" aria-hidden />
        </ToolButton>
      </Group>

      <ToolButton label={t`Reset table layout`} onClick={() => run(editor, resetTableLayout)}>
        <RotateCcw className="size-3.5" aria-hidden />
      </ToolButton>
      <ToolButton
        label={t`Delete table`}
        onClick={() => editor.chain().focus().deleteTable().run()}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </ToolButton>
    </div>
  );
}
