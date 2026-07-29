/**
 * TableChrome — the table's approach chrome, drawn entirely outside the frame.
 *
 * At rest a table is just a table (§5.4). Hovering it fades in a grip above the
 * hovered column, a grip left of the hovered row, and quiet add tabs on the
 * right and bottom edges; leaving fades them out. All four are portalled to the
 * body and positioned from measured rects, so the manuscript never reserves a
 * pixel for them and no line of text moves when they appear.
 *
 * A grip press does one thing: select the row or the column. Everything the
 * menus then offer reads that selection, so a menu item, its keyboard twin,
 * and a hand-swept cell selection all run the same verb over the same cells.
 *
 * Column resize is prosemirror-tables' own `columnResizing` plugin (already
 * mounted by the table extension), restyled to Q6's hover-only hairline. It
 * writes widths to `colwidth`, which is exactly what the `Layout widths`
 * codec reads, so persistence needed nothing from this lane.
 */

import type { Editor } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import { GripHorizontal, GripVertical, Plus } from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { editorChromeAttributes, type HoverIntent } from "@/core/editor/chrome";
import { selectedObject } from "@/core/editor/objects";

import { EditorMenu, OverlayIconRow, useChromeSuppressed, useEditorChrome } from "../../chrome";
import { TableColumnMenuItems, TableMenuItems, TableRowMenuItems } from "./TableVerbMenu";
import {
  cellDocPosition,
  measureTableChrome,
  sameTableChromeRects,
  type TableChromePiece,
  type TableChromeRects,
  tableCellUnder,
} from "./table-anchors";
import {
  appendTableAxis,
  mergeJoinsCellText,
  selectedColumnAlignment,
  selectedTablePlacement,
  selectTableAxis,
  TABLE_VERB_COMMANDS,
  tableVerbStates,
} from "./table-commands";
import { tableChromeCopy } from "./table-copy";

type Axis = "row" | "column";

export function TableChrome({ editor }: { editor: Editor }) {
  useEditorRevision(editor);
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const editable = editor.isEditable;

  const [anchorCell, setAnchorCell] = useState<HTMLElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const [openMenu, setOpenMenu] = useState<Axis | null>(null);
  const [tableMenuOpen, setTableMenuOpen] = useState(false);

  // The pointer travels off the editor and onto the grips, so hover has to be
  // re-enterable from the chrome itself; the intent's warm grace is what makes
  // that crossing survivable.
  const intentRef = useRef<HoverIntent<HTMLElement> | null>(null);
  const openMenuRef = useRef<Axis | null>(null);
  openMenuRef.current = openMenu;

  /**
   * The hovered cell has left the manuscript's pane — scrolled out, or taken
   * away by a peer's write. Everything aimed at it goes with it: an open menu
   * that outlived its row would keep this surface's anchor pinned to a dead
   * element, and the grips would never come back.
   */
  const releaseAnchor = useCallback(() => {
    intentRef.current?.cancel();
    setOpenMenu(null);
    setAnchorCell(null);
    setHovering(false);
  }, []);

  const rects = useTableChromeRects(editor, anchorCell, releaseAnchor);

  // A menu held the anchor still while it was open, so the pointer's real
  // position has to be read back on close or the grips linger where it left.
  const syncHover = useCallback(() => {
    const settled = intentRef.current?.settled ?? null;
    if (settled) setAnchorCell(settled);
    setHovering(settled !== null);
  }, []);

  useEffect(() => {
    if (!chrome || !editable) return;
    const intent = chrome.createHoverIntent<HTMLElement>({
      onSettle: (cell) => {
        // An open menu owns the anchor: letting a stray hover move the grips
        // out from under the menu would leave it pointing at another row.
        if (openMenuRef.current) return;
        if (cell) setAnchorCell(cell);
        setHovering(cell !== null);
      },
    });
    intentRef.current = intent;

    const dom = editor.view.dom;
    const onMove = (event: MouseEvent) => {
      const cell = tableCellUnder(editor.view, event.target);
      if (cell) intent.enter(cell);
      else intent.leave();
    };
    const onLeave = () => intent.leave();

    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
      intentRef.current = null;
      intent.dispose();
    };
  }, [chrome, editor, editable]);

  const selectAxis = useCallback(
    (axis: Axis) => {
      if (!anchorCell) return false;
      const cellPos = cellDocPosition(editor.view, anchorCell);
      return cellPos === null ? false : selectTableAxis(editor, cellPos, axis);
    },
    [anchorCell, editor],
  );

  // A right-click on a grip is the same door as a left-click: one entry point,
  // so the menu cannot behave differently depending on which button opened it.
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerContextClaim({
      id: "grip",
      claim: (target) => {
        const grip = target.element.closest("[data-table-grip]");
        if (!(grip instanceof HTMLElement)) return false;
        const axis: Axis = grip.dataset.tableGrip === "row" ? "row" : "column";
        // A grip whose cells a peer has taken away claims nothing: opening a
        // menu over them would offer row verbs against whatever the selection
        // happens to be.
        if (!selectAxis(axis)) return false;
        setOpenMenu(axis);
        return true;
      },
    });
  }, [chrome, editable, selectAxis]);

  useTableKeymap(chrome, editable);

  const selected = selectedObject(editor.state);
  const selectedTable = selected?.node.type.name === "table" ? selected : null;
  const selectedTableDOM =
    selectedTable && !editor.isDestroyed ? editor.view.nodeDOM(selectedTable.pos) : null;
  const tableElement = selectedTableDOM instanceof HTMLElement ? selectedTableDOM : null;

  const visible = (hovering || openMenu !== null) && !suppressed;

  return (
    <>
      {rects && anchorCell && editable && chrome
        ? createPortal(
            <div
              className="meridian-table-chrome"
              // A group of controls, not decoration: the pointer crossing from
              // the table onto them must keep the reveal alive.
              role="toolbar"
              aria-label={tableChromeCopy.tableControls()}
              data-state={visible ? "open" : "closed"}
              {...editorChromeAttributes(chrome)}
              onMouseEnter={() => {
                if (anchorCell) intentRef.current?.enter(anchorCell);
              }}
              onMouseLeave={() => intentRef.current?.leave()}
            >
              <EditorMenu
                editor={editor}
                id="table-column-menu"
                open={openMenu === "column"}
                onOpenChange={(open) => {
                  setOpenMenu(open ? "column" : null);
                  if (!open) syncHover();
                }}
                side="bottom"
                align="center"
                trigger={
                  <GripButton
                    axis="column"
                    label={tableChromeCopy.columnGrip()}
                    onArm={() => selectAxis("column")}
                    piece={rects.columnGrip}
                  >
                    <GripHorizontal aria-hidden />
                  </GripButton>
                }
              >
                <GripMenuContent editor={editor} axis="column" />
              </EditorMenu>

              <EditorMenu
                editor={editor}
                id="table-row-menu"
                open={openMenu === "row"}
                onOpenChange={(open) => {
                  setOpenMenu(open ? "row" : null);
                  if (!open) syncHover();
                }}
                side="left"
                align="start"
                trigger={
                  <GripButton
                    axis="row"
                    label={tableChromeCopy.rowGrip()}
                    onArm={() => selectAxis("row")}
                    piece={rects.rowGrip}
                  >
                    <GripVertical aria-hidden />
                  </GripButton>
                }
              >
                <GripMenuContent editor={editor} axis="row" />
              </EditorMenu>

              <AddTab
                axis="column"
                label={tableChromeCopy.addColumn()}
                onSelect={() => appendFrom(editor, anchorCell, "column")}
                piece={rects.addColumn}
              />
              <AddTab
                axis="row"
                label={tableChromeCopy.addRow()}
                onSelect={() => appendFrom(editor, anchorCell, "row")}
                piece={rects.addRow}
              />
            </div>,
            document.body,
          )
        : null}

      {/* The table's object controls: one ⋮, and only while the table is
          selected. §5.4 rules out a hover icon row here — the grips already
          own the top edge, and a second system would crowd them. */}
      <OverlayIconRow
        editor={editor}
        kind="table"
        anchor={editable ? tableElement : null}
        visible={Boolean(tableElement)}
        items={[]}
        overflow={(chip) => (
          <EditorMenu
            editor={editor}
            id="table-menu"
            open={tableMenuOpen}
            onOpenChange={setTableMenuOpen}
            align="end"
            trigger={chip}
          >
            <GripMenuContent editor={editor} axis="table" />
          </EditorMenu>
        )}
      />
    </>
  );
}

function appendFrom(editor: Editor, cell: HTMLElement | null, axis: Axis) {
  if (!cell) return;
  const cellPos = cellDocPosition(editor.view, cell);
  if (cellPos !== null) appendTableAxis(editor, cellPos, axis);
}

/**
 * Radix passes its trigger props through `asChild`, including the
 * `onPointerDown` that opens the menu, so this composes rather than replaces:
 * arming the selection first and letting the library open second.
 */
function GripButton({
  axis,
  label,
  piece,
  onArm,
  onPointerDown,
  children,
  ...rest
}: ComponentProps<"button"> & {
  axis: Axis;
  label: string;
  /** Null once this grip would fall outside the manuscript's pane. */
  piece: TableChromePiece | null;
  /** Selects the row or column before the menu opens; the press means both. */
  onArm: () => void;
  children: ReactNode;
}) {
  // Radix still needs a trigger element to anchor an open menu to, so a grip
  // that has scrolled out of the pane keeps its box and stops painting.
  return (
    <button
      {...rest}
      type="button"
      className="meridian-table-grip"
      data-table-grip={axis}
      data-out-of-view={piece ? undefined : ""}
      aria-label={label}
      title={label}
      style={pieceStyle(piece)}
      onPointerDown={(event) => {
        onArm();
        onPointerDown?.(event);
      }}
    >
      {children}
    </button>
  );
}

function AddTab({
  axis,
  label,
  piece,
  onSelect,
}: {
  axis: Axis;
  label: string;
  piece: TableChromePiece | null;
  onSelect: () => void;
}) {
  if (!piece) return null;

  return (
    <button
      type="button"
      className="meridian-table-add-tab"
      data-table-add={axis}
      aria-label={label}
      title={label}
      style={pieceStyle(piece)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      <Plus aria-hidden />
    </button>
  );
}

/** Geometry is inline: it is measurement, not theme. */
function pieceStyle(piece: TableChromePiece | null): CSSProperties {
  if (!piece) return { display: "none" };
  return { left: piece.left, top: piece.top, width: piece.width, height: piece.height };
}

/**
 * Menu contents, mounted only while the menu is open (Radix keeps its content
 * unmounted otherwise). Recomputing the verb matrix on every keystroke of the
 * chapter would be a table walk per character; behind an open menu it is free.
 */
function GripMenuContent({ editor, axis }: { editor: Editor; axis: Axis | "table" }) {
  const states = tableVerbStates(editor.state, { editable: editor.isEditable });
  const props = {
    editor,
    states,
    alignment: selectedColumnAlignment(editor.state),
    placement: selectedTablePlacement(editor.state),
    mergeJoinsText: mergeJoinsCellText(editor.state),
  };

  if (axis === "row") return <TableRowMenuItems {...props} />;
  if (axis === "column") return <TableColumnMenuItems {...props} />;
  return <TableMenuItems {...props} />;
}

/**
 * Alt+Arrows move the row or the column (§4, deepest owner). Inside a table
 * they are ALWAYS consumed, refusal included: handing a refused move down the
 * ladder would move the whole table instead, which is not what the writer
 * asked for by pressing a key that means "move this row".
 */
function useTableKeymap(chrome: ReturnType<typeof useEditorChrome>, editable: boolean) {
  useEffect(() => {
    if (!chrome || !editable) return;
    // The kernel only runs a `table`-scope binding with a table in the
    // context chain, so these are always the writer's row and column. They
    // consume the key even when the move refuses: handing a refused row move
    // down the ladder would move the whole table instead.
    const inTable =
      (command: Command): Command =>
      (state, dispatch, view) => {
        command(state, dispatch, view);
        return true;
      };

    return chrome.registerKeymap({
      id: "table-chrome",
      scope: "table",
      bindings: {
        "Alt-ArrowUp": inTable(TABLE_VERB_COMMANDS.moveRowUp),
        "Alt-ArrowDown": inTable(TABLE_VERB_COMMANDS.moveRowDown),
        "Alt-ArrowLeft": inTable(TABLE_VERB_COMMANDS.moveColumnLeft),
        "Alt-ArrowRight": inTable(TABLE_VERB_COMMANDS.moveColumnRight),
      },
    });
  }, [chrome, editable]);
}

/**
 * The hovered cell's geometry, followed while the chrome is up.
 *
 * Scroll is watched in capture phase because the manuscript scrolls in a pane
 * rather than the window; the editor's own updates matter too, since a row
 * grows as the writer types into it and the grip has to travel with it.
 */
function useTableChromeRects(
  editor: Editor,
  cell: HTMLElement | null,
  onAnchorLost: () => void,
): TableChromeRects | null {
  const [rects, setRects] = useState<TableChromeRects | null>(null);
  const lostRef = useRef(onAnchorLost);
  lostRef.current = onAnchorLost;

  useLayoutEffect(() => {
    if (!cell) {
      setRects(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      const next = measureTableChrome(cell);
      // The cell scrolled out of the manuscript's pane: the approach is over
      // even though the pointer never moved, so the hover has to be told.
      if (!next) lostRef.current();
      setRects((previous) => (sameTableChromeRects(previous, next) ? previous : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    editor.on("transaction", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(cell);
    const table = cell.closest("table");
    if (table) observer.observe(table);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      editor.off("transaction", schedule);
      observer.disconnect();
    };
  }, [cell, editor]);

  return rects;
}

function useEditorRevision(editor: Editor) {
  const [, setRevision] = useState(0);

  useEffect(() => {
    const bump = () => setRevision((revision) => revision + 1);
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
    };
  }, [editor]);
}
