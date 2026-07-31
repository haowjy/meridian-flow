/**
 * The contents of the row grip, column grip, and table menus.
 *
 * One item component for all of them, because law 5 is one rule: a verb that
 * cannot run here stays where the writer found it, keeps its hover and focus,
 * and says why when the writer reaches it. The greying, the swallowed select,
 * and the tooltip are the shared row's (`chrome/EditorMenuItem`); this file
 * only knows which verb is blocked and by what.
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
  runTableVerbOn,
  selectedColumnAlignment,
  selectedTablePlacement,
  type TableAlignment,
  type TableMenuTarget,
  type TablePlacement,
  type TableVerbId,
  type TableVerbStates,
  tableTargetState,
  tableVerbStates,
} from "./table-commands";
import { tableBlockedMessage, tableChromeCopy, tableVerbLabel } from "./table-copy";

/** How an item runs its verb: the menu's target, resolved at the moment it runs. */
export type RunTableVerb = (id: TableVerbId) => void;

export type VerbProps = {
  run: RunTableVerb;
  states: TableVerbStates;
  alignment: TableAlignment | null;
  placement: TablePlacement;
};

function TableVerbItem({
  run,
  states,
  verb,
  icon,
  shortcut,
  destructive = false,
}: {
  run: RunTableVerb;
  states: TableVerbStates;
  verb: TableVerbId;
  icon: ReactNode;
  shortcut?: string;
  destructive?: boolean;
}) {
  const { blockedBy } = states[verb];
  const blockedReason = tableBlockedMessage(verb, blockedBy);

  return (
    <EditorMenuItem
      data-table-verb={verb}
      variant={destructive ? "destructive" : "default"}
      blockedReason={blockedReason}
      onSelect={() => run(verb)}
    >
      {icon}
      {tableVerbLabel(verb)}
      {shortcut ? <EditorMenuShortcut>{shortcut}</EditorMenuShortcut> : null}
    </EditorMenuItem>
  );
}

export function TableRowMenuItems({ run, states, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        run={run}
        states={states}
        verb="insertRowAbove"
        icon={<ArrowUpFromLine aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="insertRowBelow"
        icon={<ArrowDownFromLine aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="moveRowUp"
        icon={<MoveUp aria-hidden />}
        shortcut="Alt+↑"
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="moveRowDown"
        icon={<MoveDown aria-hidden />}
        shortcut="Alt+↓"
      />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="deleteRow"
        icon={<Trash2 aria-hidden />}
        destructive
      />
      <EditorMenuSeparator />
      <TableSubmenu run={run} states={states} {...table} />
    </>
  );
}

export function TableColumnMenuItems({ run, states, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        run={run}
        states={states}
        verb="insertColumnLeft"
        icon={<ArrowLeftFromLine aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="insertColumnRight"
        icon={<ArrowRightFromLine aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableAlignmentItems run={run} alignment={table.alignment} />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="moveColumnLeft"
        icon={<MoveLeft aria-hidden />}
        shortcut="Alt+←"
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="moveColumnRight"
        icon={<MoveRight aria-hidden />}
        shortcut="Alt+→"
      />
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="deleteColumn"
        icon={<Trash2 aria-hidden />}
        destructive
      />
      <EditorMenuSeparator />
      <TableSubmenu run={run} states={states} {...table} />
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
export function TableCellMenuItems({ run, states, ...table }: VerbProps) {
  return (
    <>
      <TableVerbItem
        run={run}
        states={states}
        verb="mergeCells"
        icon={<TableCellsMerge aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="splitCell"
        icon={<TableCellsSplit aria-hidden />}
      />
      <EditorMenuSeparator />
      <TableAlignmentItems run={run} alignment={table.alignment} />
      <EditorMenuSeparator />
      <TableSubmenu run={run} states={states} {...table} />
    </>
  );
}

/** The table's own verbs, flat. What the selected table's ⋮ shows. */
export function TableMenuItems({ run, states, alignment, placement }: VerbProps) {
  return (
    <>
      <EditorMenuCheckboxItem
        data-table-verb="headerRow"
        checked={states.headerRow.active}
        onCheckedChange={() => run("headerRow")}
      >
        {tableVerbLabel("headerRow")}
      </EditorMenuCheckboxItem>
      <EditorMenuSeparator />
      <TableAlignmentItems run={run} alignment={alignment} />
      <EditorMenuSeparator />
      <EditorMenuLabel className="text-muted-foreground text-xs">
        {tableChromeCopy.tablePlacement()}
      </EditorMenuLabel>
      <EditorMenuRadioGroup
        value={placement}
        onValueChange={(value) => {
          if (value === "center") run("placeCenter");
          else if (value === "right") run("placeRight");
          else run("placeLeft");
        }}
      >
        <EditorMenuRadioItem value="left">{tableVerbLabel("placeLeft")}</EditorMenuRadioItem>
        <EditorMenuRadioItem value="center">{tableVerbLabel("placeCenter")}</EditorMenuRadioItem>
        <EditorMenuRadioItem value="right">{tableVerbLabel("placeRight")}</EditorMenuRadioItem>
      </EditorMenuRadioGroup>
      <EditorMenuSeparator />
      <TableVerbItem
        run={run}
        states={states}
        verb="resetColumnWidths"
        icon={<Ruler aria-hidden />}
      />
      <TableVerbItem
        run={run}
        states={states}
        verb="deleteTable"
        icon={<Trash2 aria-hidden />}
        destructive
      />
    </>
  );
}

/**
 * Everything the arrangements read, gathered once per open, against the target
 * the menu was opened on. Null once that target is gone: a menu with nothing
 * left to act on closes rather than offering verbs to the selection.
 *
 * Recomputing the verb matrix on every keystroke of the chapter would be a
 * table walk per character; behind an open menu it is free, and Radix keeps
 * menu content unmounted until then.
 */
export function tableMenuProps(
  editor: Editor,
  target: TableMenuTarget = { kind: "selection" },
): VerbProps | null {
  const state = tableTargetState(editor, target);
  if (!state) return null;

  return {
    run: (id) => runTableVerbOn(editor, target, id),
    states: tableVerbStates(state, { editable: editor.isEditable }),
    alignment: selectedColumnAlignment(state),
    placement: selectedTablePlacement(state),
  };
}

/**
 * The table verbs a caret in a cell reaches, as the two lists the grips
 * already own. No third copy: a writer who found the row grip and a writer who
 * right-clicked a cell meet the same rows in the same order.
 */
export function TableCaretMenuItems({ editor }: { editor: Editor }) {
  const props = tableMenuProps(editor);
  if (!props) return null;

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
  run,
  alignment,
}: {
  run: RunTableVerb;
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
          if (value === "left") run("alignLeft");
          else if (value === "center") run("alignCenter");
          else if (value === "right") run("alignRight");
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
