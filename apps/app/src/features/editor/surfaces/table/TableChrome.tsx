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
 *
 * **Every menu here has exactly one target, and it is held.** A grip menu's
 * target is the cell the grips serve; a swept rectangle's is the pair of cells
 * that describe it. Both are `NodeHold`s, both are resolved into a selection at
 * the moment a verb runs (`TableMenuTarget`), and both close rather than re-aim
 * when what they held is gone. Nothing about the document is remembered as a
 * number or a screen point: the Yjs binding restores the writer's place as a
 * caret on every remote write, so a menu that read the selection it was opened
 * with would offer a rectangle's verbs to a caret.
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
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { type NodeHold, resolveNodeHold } from "@/core/editor/anchors";
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
  measureTableChrome,
  pointerHoldsTableChrome,
  sameTableChromeRects,
  type TableChromePiece,
  type TableChromeRects,
  tableCellUnder,
} from "./table-anchors";
import {
  appendTableAxis,
  claimedSweptCells,
  selectTableAxis,
  TABLE_VERB_COMMANDS,
  type TableMenuTarget,
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
  // Where a swept rectangle's menu hangs. Geometry only: which cells it acts on
  // is the pair of holds beside it, and a screen point cannot say that.
  const [cellMenuAt, setCellMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [sweptCells, holdSweptCells] = useSweptCells(editor);

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

  // Either swept cell taken away is a rectangle nobody can name any more, so
  // the menu aimed at it goes with it rather than re-aiming at what is left.
  useEffect(() => {
    if (sweptCells !== null) return;
    setCellMenuAt(null);
    holdSweptCells(null);
  }, [sweptCells, holdSweptCells]);

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
        // Whether the pointer is still on this table is true of the pointer
        // whatever a menu is doing, and it is what fades the grips out the
        // moment a menu that was holding them closes.
        setHovering(pos !== null);
        // An open menu owns the anchor: letting a stray hover move the grips out
        // from under the menu would leave it pointing at another row. The
        // pointer's place is NOT copied aside for the close — the menu's hold is
        // its target, and the kernel's next reading of the page is the only
        // honest word on where the pointer is.
        if (openMenuRef.current) return;
        if (pos !== null) holdAnchorCell(pos);
      },
    });
  }, [chrome, editor, editable, holdAnchorCell]);

  const selectAxis = useCallback(
    (axis: Axis) => (anchorPos === null ? false : selectTableAxis(editor, anchorPos, axis)),
    [anchorPos, editor],
  );

  /**
   * An open grip menu re-arms its axis whenever the held cell moves.
   *
   * This is the row's HIGHLIGHT, not the menu's aim: prosemirror-tables paints
   * the selected cells, and the Yjs binding restores the writer's place as a
   * caret, so a peer's write leaves the row the writer opened the menu on
   * looking unselected. The verbs themselves take the menu's target and
   * materialize it as they run, so they never depend on this landing.
   * Re-arming is safe because an open menu already owns the anchor, and it runs
   * only when the cell moved — never against a selection the writer made.
   */
  useEffect(() => {
    if (openMenu === null || anchorPos === null) return;
    selectAxis(openMenu);
  }, [anchorPos, openMenu, selectAxis]);

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
        // The claim is the last moment the rectangle is on screen: the next
        // remote write turns it back into a caret, so the menu takes hold of
        // the two cells here and never reads the selection again.
        const cells = claimedSweptCells(editor, target);
        if (!cells) return false;
        holdSweptCells(cells);
        setCellMenuAt({ x: target.event.clientX, y: target.event.clientY });
        return true;
      },
    });
  }, [chrome, editor, holdSweptCells]);

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
      {rects && anchorCell && anchorPos !== null && editable && chrome
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
                onOpenChange={(open) => setOpenMenu(open ? "column" : null)}
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
                <TableMenuContent
                  editor={editor}
                  shape="column"
                  target={{ kind: "axis", cell: anchorCell, axis: "column" }}
                />
              </EditorMenu>

              <EditorMenu
                editor={editor}
                id="table-row-menu"
                open={openMenu === "row"}
                onOpenChange={(open) => setOpenMenu(open ? "row" : null)}
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
                <TableMenuContent
                  editor={editor}
                  shape="row"
                  target={{ kind: "axis", cell: anchorCell, axis: "row" }}
                />
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

      {/* What a swept rectangle of cells opens, hung off the pointer. The point
          is where it hangs; the two holds are what it acts on. */}
      <EditorMenu
        editor={editor}
        id="table-cell-menu"
        open={cellMenuAt !== null && sweptCells !== null}
        onOpenChange={(open) => {
          if (open) return;
          setCellMenuAt(null);
          holdSweptCells(null);
        }}
        at={cellMenuAt}
      >
        {sweptCells ? (
          <TableMenuContent
            editor={editor}
            shape="cells"
            target={{ kind: "cells", ...sweptCells }}
          />
        ) : null}
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
            {/* The table's own verbs act on the selected table, and the
                selection is what keeps this menu mounted at all: it unmounts
                with the selection rather than outliving it. */}
            <TableMenuContent editor={editor} shape="table" target={{ kind: "selection" }} />
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
 * whole verb matrix — and to read it against the menu's own target rather than
 * against the selection, which a peer's write has already turned into a caret.
 */
function TableMenuContent({
  editor,
  shape,
  target,
}: {
  editor: Editor;
  shape: TableMenuShape;
  target: TableMenuTarget;
}) {
  const props = tableMenuProps(editor, target);
  // The target went away between the click that opened this and this render.
  // The surface closes the menu on the same fact; an empty list for that frame
  // is the honest picture, and offering the selection's verbs is not.
  if (!props) return null;

  if (shape === "row") return <TableRowMenuItems {...props} />;
  if (shape === "column") return <TableColumnMenuItems {...props} />;
  if (shape === "cells") return <TableCellMenuItems {...props} />;
  return <TableMenuItems {...props} />;
}

/** The cell positions a claim reports, or null to let the rectangle go. */
type SweptCellPositions = { anchor: number; head: number } | null;

/**
 * The two cells a swept rectangle is described by, held.
 *
 * Two holds rather than one because a rectangle is not a node: the pair is
 * exactly what a `CellSelection` is made of, and either cell taken away is a
 * rectangle that can no longer be named. Composed from the same plumbing every
 * other surface aims with, so a rectangle survives a peer's write for the same
 * reason a grip's cell does.
 */
function useSweptCells(
  editor: Editor,
): [{ anchor: NodeHold; head: NodeHold } | null, (cells: SweptCellPositions) => void] {
  const [anchor, holdAnchor] = useNodeHold(editor);
  const [head, holdHead] = useNodeHold(editor);

  const take = useCallback(
    (cells: SweptCellPositions) => {
      holdAnchor(cells?.anchor ?? null);
      holdHead(cells?.head ?? null);
    },
    [holdAnchor, holdHead],
  );

  // Memoized because surfaces depend on the pair's identity in effects: a fresh
  // object every render would read as "the rectangle changed" every render.
  const cells = useMemo(() => (anchor && head ? { anchor, head } : null), [anchor, head]);
  return [cells, take];
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
