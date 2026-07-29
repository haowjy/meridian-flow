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
 *
 * **Elements are geometry, holds are identity.** The approach settles on a
 * `NodeHold` of the cell; the cell's element is resolved from it for each
 * measurement. So a peer's write that rebuilds the table moves the grips instead
 * of closing the menu open on them, and the anchor is released only when the
 * cell itself is gone or has left the manuscript's pane.
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

import { resolveNodeHold } from "@/core/editor/anchors";
import { editorChromeAttributes, hoverOwner, watchManuscriptLayout } from "@/core/editor/chrome";

import {
  EditorMenu,
  OverlayIconRow,
  useChromeContext,
  useChromeSuppressed,
  useEditorChrome,
  useNodeHold,
} from "../../chrome";
import {
  TableCellMenuItems,
  TableColumnMenuItems,
  TableMenuItems,
  TableRowMenuItems,
  tableMenuProps,
} from "./TableVerbMenu";
import {
  cellDocPosition,
  cellElementAt,
  isTableCellPos,
  measureTableChrome,
  pointerHoldsTableChrome,
  sameTableChromeRects,
  type TableChromePiece,
  type TableChromeRects,
  tableCellUnder,
} from "./table-anchors";
import {
  appendTableAxis,
  claimsTableCellMenu,
  selectTableAxis,
  TABLE_VERB_COMMANDS,
} from "./table-commands";
import { tableChromeCopy } from "./table-copy";
import "./table-chrome.css";

type Axis = "row" | "column";
/** The four shapes a table menu takes, each a different thing to act on. */
type TableMenuShape = Axis | "cells" | "table";

export function TableChrome({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const editable = editor.isEditable;

  const [anchorCell, holdAnchorCell] = useNodeHold(editor);
  const [hovering, setHovering] = useState(false);
  const [openMenu, setOpenMenu] = useState<Axis | null>(null);
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const [cellMenuAt, setCellMenuAt] = useState<{ x: number; y: number } | null>(null);

  // What the approach last settled on, whether or not this surface was free to
  // move its anchor there. A menu holds the grips still while it is open, and
  // the pointer's real place has to be readable again on close.
  const settledCell = useRef<number | null>(null);
  const openMenuRef = useRef<Axis | null>(null);
  openMenuRef.current = openMenu;

  /**
   * The hovered cell has left the manuscript's pane — scrolled out, or taken
   * away by a peer's write. Everything aimed at it goes with it: an open menu
   * that outlived its row would offer row verbs against whatever the selection
   * has become.
   */
  const releaseAnchor = useCallback(() => {
    setOpenMenu(null);
    holdAnchorCell(null);
    setHovering(false);
  }, [holdAnchorCell]);

  // Where the held cell is now, and what is drawing it. Read fresh every
  // render: a rebuild replaces the element while the cell itself stays, and
  // grips measured from the old one would hang beside a row nobody is on.
  const anchorPos = anchorCell ? (resolveNodeHold(editor.state, anchorCell)?.from ?? null) : null;
  const rects = useTableChromeRects(
    editor,
    anchorPos === null ? null : cellElementAt(editor.view, anchorPos),
    releaseAnchor,
  );

  // A cell a peer took away takes the menu aimed at it with it. The hold is
  // already gone by the time this runs; what it cannot know is that this
  // surface had a menu open on it.
  useEffect(() => {
    if (anchorCell === null) {
      setOpenMenu(null);
      setHovering(false);
    }
  }, [anchorCell]);

  // A menu held the anchor still while it was open, so the pointer's real
  // position has to be read back on close or the grips linger where it left.
  const syncHover = useCallback(() => {
    // Verified rather than trusted: a verb the menu just ran may have moved
    // every cell after the one the pointer was last read over.
    const settled = settledCell.current;
    const pos = settled !== null && isTableCellPos(editor.view, settled) ? settled : null;
    holdAnchorCell(pos);
    setHovering(pos !== null);
  }, [editor, holdAnchorCell]);

  /**
   * The approach. This lane answers one question — which cell is at this point
   * — and the kernel's coordinator owns the rest: the timing, the pointer's
   * last place, and which block owns hover chrome at all. A cell that scrolls
   * away under a still hand is therefore released by the same mechanism that
   * releases every other lane, rather than by a branch here.
   *
   * `holds` is the part only this lane knows. The grips live OUTSIDE the frame
   * (Q6), so the pixels BETWEEN the frame and a grip belong to the reveal too;
   * without them the travel to a grip crosses several pixels of nothing and
   * fades out the control the writer is reaching for.
   */
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerHoverAnchor<number>({
      id: "table-chrome",
      probe: ({ element }) => {
        const cell = tableCellUnder(editor.view, element);
        const pos = cell && cellDocPosition(editor.view, cell);
        if (!cell || pos === null) return null;
        const owner = hoverOwner(editor.view, cell);
        return owner ? { owner, value: pos } : null;
      },
      holds: (pos, { x, y }) => {
        const cell = cellElementAt(editor.view, pos);
        return cell !== null && pointerHoldsTableChrome(cell, x, y);
      },
      onSettle: (pos) => {
        settledCell.current = pos;
        // An open menu owns the anchor: letting a stray hover move the grips
        // out from under the menu would leave it pointing at another row.
        if (openMenuRef.current) return;
        if (pos !== null) holdAnchorCell(pos);
        setHovering(pos !== null);
      },
    });
  }, [chrome, editor, editable, holdAnchorCell]);

  const selectAxis = useCallback(
    (axis: Axis) => (anchorPos === null ? false : selectTableAxis(editor, anchorPos, axis)),
    [anchorPos, editor],
  );

  // A right-click on a grip is the same door as a left-click: one entry point,
  // so the menu cannot behave differently depending on which button opened it.
  useEffect(() => {
    if (!chrome || !editable) return;
    return chrome.registerContextClaim({
      id: "grip",
      claim: (target) => {
        // Mid-sweep or mid-drag the writer is doing something else with this
        // pointer, and every surface stands down for it.
        if (chrome.suppressed) return false;
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

  // A rectangle the writer swept by hand is the one table selection no grip
  // can make, and the only path to merging two arbitrary cells. Nothing above
  // this rung wants it — the formatting menu admits text selections only — so
  // without this the right-click lands on silence.
  useEffect(() => {
    if (!chrome) return;
    return chrome.registerContextClaim({
      id: "cell-selection",
      claim: (target) => {
        if (chrome.suppressed) return false;
        if (!claimsTableCellMenu(editor, target)) return false;
        setCellMenuAt({ x: target.event.clientX, y: target.event.clientY });
        return true;
      },
    });
  }, [chrome, editor]);

  useTableKeymap(chrome, editable);

  // The kernel's resolved context, not a per-transaction re-render: this
  // surface's only reading of the document is "is a table selected", and the
  // context store answers it, notifying when that answer changes rather than
  // on every keystroke of the chapter.
  const context = useChromeContext(editor);
  const selectedTablePos =
    context.owner === "object" && context.nodeType === "table" ? context.pos : null;
  const selectedTableDOM =
    selectedTablePos !== null && !editor.isDestroyed ? editor.view.nodeDOM(selectedTablePos) : null;
  const tableElement = selectedTableDOM instanceof HTMLElement ? selectedTableDOM : null;

  const visible = (hovering || openMenu !== null) && !suppressed;

  return (
    <>
      {rects && anchorPos !== null && editable && chrome
        ? createPortal(
            <div
              className="meridian-table-chrome"
              role="toolbar"
              aria-label={tableChromeCopy.tableControls()}
              data-table-chrome=""
              data-state={visible ? "open" : "closed"}
              {...editorChromeAttributes(chrome)}
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
                onSelect={() => appendTableAxis(editor, anchorPos, "column")}
                piece={rects.addColumn}
              />
              <AddTab
                axis="row"
                label={tableChromeCopy.addRow()}
                onSelect={() => appendTableAxis(editor, anchorPos, "row")}
                piece={rects.addRow}
              />
            </div>,
            document.body,
          )
        : null}

      {/* What a swept rectangle of cells opens, hung off the pointer. */}
      <EditorMenu
        editor={editor}
        id="table-cell-menu"
        open={cellMenuAt !== null}
        onOpenChange={(open) => {
          if (!open) setCellMenuAt(null);
        }}
        at={cellMenuAt}
      >
        <GripMenuContent editor={editor} axis="cells" />
      </EditorMenu>

      {/* The table's object controls: one ⋮, and only while the table is
          selected. §5.4 rules out a hover icon row here — the grips already
          own the top edge, and a second system would crowd them.

          Measured rather than rendered inside the frame, unlike every other
          object's row: a table is ProseMirror's own DOM rather than a node
          view's, and a child inserted into it is read back as a document
          change. */}
      <OverlayIconRow
        editor={editor}
        kind="table"
        corner={editable && tableElement ? { over: tableElement } : null}
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
 * unmounted otherwise), which is what makes `tableMenuProps` free to read the
 * whole verb matrix.
 */
function GripMenuContent({ editor, axis }: { editor: Editor; axis: TableMenuShape }) {
  const props = tableMenuProps(editor);

  if (axis === "row") return <TableRowMenuItems {...props} />;
  if (axis === "column") return <TableColumnMenuItems {...props} />;
  if (axis === "cells") return <TableCellMenuItems {...props} />;
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

    const measure = () => {
      const next = measureTableChrome(cell);
      // The cell scrolled out of the manuscript's pane: the approach is over
      // even though the pointer never moved, so the hover has to be told.
      if (!next) lostRef.current();
      setRects((previous) => (sameTableChromeRects(previous, next) ? previous : next));
    };

    measure();
    // The table itself joins the cell and the manuscript root: a column drag
    // resizes the frame live, before the width it settles on becomes a step.
    return watchManuscriptLayout(editor, [cell, cell.closest("table")], measure);
  }, [cell, editor]);

  return rects;
}
