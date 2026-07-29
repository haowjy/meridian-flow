/**
 * The contents of the row grip, column grip, and table menus.
 *
 * One item component for all of them, because law 5 is one rule: a verb that
 * cannot run here stays where the writer found it, keeps its hover and focus,
 * and says why on a second line. `disabled` would take it out of the focus
 * path and the reason would never arrive, so nothing here uses it.
 *
 * The table verbs appear twice on purpose — flat under the selected table's ⋮
 * and as a submenu at the foot of both grip menus. Selecting a whole table is
 * a deliberate act (arrow-walk or Esc out of a cell), and the header toggle
 * should not be behind it: the grips are the surface a writer already found.
 *
 * `TableCaretMenuItems` is the fifth arrangement and adds no verb: a
 * right-click inside a cell now opens the formatting menu (human ruling,
 * 2026-07-29), and these are the two submenus it carries so the writer can
 * reach the table without finding a grip first.
 */
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownFromLine,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ArrowUpFromLine,
  Columns3,
  MoveDown,
  MoveLeft,
  MoveRight,
  MoveUp,
  Rows3,
  Ruler,
  TableCellsMerge,
  TableCellsSplit,
  Table as TableIcon,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  EditorMenuCheckboxItem,
  EditorMenuItem,
  EditorMenuLabel,
  EditorMenuRadioGroup,
  EditorMenuRadioItem,
  EditorMenuSeparator,
  EditorMenuShortcut,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
} from "../../chrome";
import {
  mergeJoinsCellText,
  runTableVerb,
  selectedColumnAlignment,
  selectedTablePlacement,
  type TableAlignment,
  type TablePlacement,
  type TableVerbId,
  type TableVerbStates,
  tableVerbStates,
} from "./table-commands";
import { tableBlockedMessage, tableChromeCopy, tableVerbHint, tableVerbLabel } from "./table-copy";

export type VerbProps = {
  editor: Editor;
  states: TableVerbStates;
  alignment: TableAlignment | null;
  placement: TablePlacement;
  /** Merging here will run two cells' text together; the item says so. */
  mergeJoinsText: boolean;
};

function TableVerbItem({
  editor,
  states,
  verb,
  icon,
  shortcut,
  destructive = false,
  mergeJoinsText = false,
}: {
  editor: Editor;
  states: TableVerbStates;
  verb: TableVerbId;
  icon: ReactNode;
  shortcut?: string;
  destructive?: boolean;
  mergeJoinsText?: boolean;
}) {
  const { blockedBy } = states[verb];
  const reason = tableBlockedMessage(verb, blockedBy);
  const hint = reason ?? tableVerbHint(verb, { mergeJoinsText });

  return (
    <EditorMenuItem
      data-table-verb={verb}
      variant={destructive ? "destructive" : "default"}
      aria-disabled={reason ? true : undefined}
      className={reason ? "cursor-not-allowed opacity-50 focus:bg-transparent" : undefined}
      onSelect={(event) => {
        // A blocked item stays open and stays reachable: the writer came for
        // the reason, and closing the menu would take it away again.
        if (reason) {
          event.preventDefault();
          return;
        }
        runTableVerb(editor, verb);
      }}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span>{tableVerbLabel(verb)}</span>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </span>
      {shortcut ? <EditorMenuShortcut>{shortcut}</EditorMenuShortcut> : null}
    </EditorMenuItem>
  );
}

export function TableRowMenuItems({ editor, states, mergeJoinsText, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        editor={editor}
        states={states}
        verb="insertRowAbove"
        icon={<ArrowUpFromLine aria-hidden />}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="insertRowBelow"
        icon={<ArrowDownFromLine aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
        mergeJoinsText={mergeJoinsText}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="moveRowUp"
        icon={<MoveUp aria-hidden />}
        shortcut="Alt+↑"
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="moveRowDown"
        icon={<MoveDown aria-hidden />}
        shortcut="Alt+↓"
      />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="deleteRow"
        icon={<Trash2 aria-hidden />}
        destructive
      />
      <EditorMenuSeparator />
      <TableSubmenu editor={editor} states={states} mergeJoinsText={mergeJoinsText} {...table} />
    </>
  );
}

export function TableColumnMenuItems({ editor, states, mergeJoinsText, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        editor={editor}
        states={states}
        verb="insertColumnLeft"
        icon={<ArrowLeftFromLine aria-hidden />}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="insertColumnRight"
        icon={<ArrowRightFromLine aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableAlignmentItems editor={editor} alignment={table.alignment} />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
        mergeJoinsText={mergeJoinsText}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="moveColumnLeft"
        icon={<MoveLeft aria-hidden />}
        shortcut="Alt+←"
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="moveColumnRight"
        icon={<MoveRight aria-hidden />}
        shortcut="Alt+→"
      />
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="deleteColumn"
        icon={<Trash2 aria-hidden />}
        destructive
      />
      <EditorMenuSeparator />
      <TableSubmenu editor={editor} states={states} mergeJoinsText={mergeJoinsText} {...table} />
    </>
  );
}

/**
 * What a swept rectangle of cells offers.
 *
 * Deliberately short: merge and split are the verbs a rectangle exists for,
 * alignment applies to the columns it covers, and the row and column verbs
 * already have a home on the grips a few pixels away. A third full copy of
 * them here would be three places to keep saying the same thing.
 */
export function TableCellMenuItems({ editor, states, mergeJoinsText, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        editor={editor}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
        mergeJoinsText={mergeJoinsText}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableAlignmentItems editor={editor} alignment={table.alignment} />
      <EditorMenuSeparator />
      <TableSubmenu editor={editor} states={states} mergeJoinsText={mergeJoinsText} {...table} />
    </>
  );
}

/** The table's own verbs, flat. What the selected table's ⋮ shows. */
export function TableMenuItems({ editor, states, alignment, placement }: VerbProps) {
  return (
    <>
      <EditorMenuCheckboxItem
        data-table-verb="headerRow"
        checked={states.headerRow.active}
        onCheckedChange={() => runTableVerb(editor, "headerRow")}
      >
        {tableVerbLabel("headerRow")}
      </EditorMenuCheckboxItem>
      <EditorMenuSeparator />
      <TableAlignmentItems editor={editor} alignment={alignment} />
      <EditorMenuSeparator />
      <EditorMenuLabel className="text-muted-foreground text-xs">
        {tableChromeCopy.tablePlacement()}
      </EditorMenuLabel>
      <EditorMenuRadioGroup
        value={placement}
        onValueChange={(value) => {
          if (value === "center") runTableVerb(editor, "placeCenter");
          else if (value === "right") runTableVerb(editor, "placeRight");
          else runTableVerb(editor, "placeLeft");
        }}
      >
        <EditorMenuRadioItem value="left">{tableVerbLabel("placeLeft")}</EditorMenuRadioItem>
        <EditorMenuRadioItem value="center">{tableVerbLabel("placeCenter")}</EditorMenuRadioItem>
        <EditorMenuRadioItem value="right">{tableVerbLabel("placeRight")}</EditorMenuRadioItem>
      </EditorMenuRadioGroup>
      <EditorMenuSeparator />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="resetColumnWidths"
        icon={<Ruler aria-hidden />}
      />
      <TableVerbItem
        editor={editor}
        states={states}
        verb="deleteTable"
        icon={<Trash2 aria-hidden />}
        destructive
      />
    </>
  );
}

/**
 * Everything the arrangements read, gathered once per open.
 *
 * Recomputing the verb matrix on every keystroke of the chapter would be a
 * table walk per character; behind an open menu it is free, and Radix keeps
 * menu content unmounted until then.
 */
export function tableMenuProps(editor: Editor): VerbProps {
  return {
    editor,
    states: tableVerbStates(editor.state, { editable: editor.isEditable }),
    alignment: selectedColumnAlignment(editor.state),
    placement: selectedTablePlacement(editor.state),
    mergeJoinsText: mergeJoinsCellText(editor.state),
  };
}

/**
 * The table verbs a caret in a cell reaches, as the two lists the grips
 * already own. No third copy: a writer who found the row grip and a writer who
 * right-clicked a cell meet the same rows in the same order.
 */
export function TableCaretMenuItems({ editor }: { editor: Editor }) {
  const props = tableMenuProps(editor);

  return (
    <>
      <TableMenuSub label={tableChromeCopy.rowVerbs()} icon={<Rows3 aria-hidden />} name="row">
        <TableRowMenuItems {...props} />
      </TableMenuSub>
      <TableMenuSub
        label={tableChromeCopy.columnVerbs()}
        icon={<Columns3 aria-hidden />}
        name="column"
      >
        <TableColumnMenuItems {...props} />
      </TableMenuSub>
    </>
  );
}

function TableSubmenu(props: VerbProps) {
  return (
    <TableMenuSub
      label={tableChromeCopy.wholeTable()}
      icon={<TableIcon aria-hidden />}
      name="table"
    >
      <TableMenuItems {...props} />
    </TableMenuSub>
  );
}

/**
 * A submenu that spends one Escape, not two.
 *
 * Radix answers Escape inside a submenu by closing the whole menu, which is
 * two steps of the walk home on one key (law 3). Taking the key here closes
 * this list and leaves the menu it opened from standing.
 */
function TableMenuSub({
  label,
  icon,
  name,
  children,
}: {
  label: string;
  icon: ReactNode;
  /** Names the list for a probe; the label is the writer's. */
  name: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <EditorMenuSub open={open} onOpenChange={setOpen}>
      <EditorMenuSubTrigger data-table-submenu={name}>
        {icon}
        {label}
      </EditorMenuSubTrigger>
      <EditorMenuSubContent
        className="min-w-52"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        {children}
      </EditorMenuSubContent>
    </EditorMenuSub>
  );
}

/**
 * Per-column text alignment. Unset is a real value and shows as no choice
 * made: a column nobody has aligned reads in the reading direction, which is
 * not the same as a column decided to be left.
 */
function TableAlignmentItems({
  editor,
  alignment,
}: {
  editor: Editor;
  alignment: TableAlignment | null;
}) {
  return (
    <>
      <EditorMenuLabel className="text-muted-foreground text-xs">
        {tableChromeCopy.textAlignment()}
      </EditorMenuLabel>
      <EditorMenuRadioGroup
        value={alignment ?? ""}
        onValueChange={(value) => {
          if (value === "left") runTableVerb(editor, "alignLeft");
          else if (value === "center") runTableVerb(editor, "alignCenter");
          else if (value === "right") runTableVerb(editor, "alignRight");
        }}
      >
        <EditorMenuRadioItem value="left" data-table-verb="alignLeft">
          <AlignLeft aria-hidden />
          {tableVerbLabel("alignLeft")}
        </EditorMenuRadioItem>
        <EditorMenuRadioItem value="center" data-table-verb="alignCenter">
          <AlignCenter aria-hidden />
          {tableVerbLabel("alignCenter")}
        </EditorMenuRadioItem>
        <EditorMenuRadioItem value="right" data-table-verb="alignRight">
          <AlignRight aria-hidden />
          {tableVerbLabel("alignRight")}
        </EditorMenuRadioItem>
      </EditorMenuRadioGroup>
    </>
  );
}
