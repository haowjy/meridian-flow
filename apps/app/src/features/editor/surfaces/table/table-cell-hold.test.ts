// @vitest-environment jsdom
/**
 * A grip serves a cell, and a menu serves the cells it was opened on, for as
 * long as the writer is reaching for them — and the table is being written into
 * by collaborators the whole time.
 *
 * Two bindings, because that is the only way to produce the change this has to
 * survive: y-prosemirror replaces the whole ProseMirror document on every remote
 * write, so the mapping reports every position deleted, the elements drawing the
 * table are reconciled underneath, and the writer's own selection comes back as
 * a caret. The hold answers which cell; the page answers where it is drawn; the
 * menu's target answers which cells its verbs run on.
 */
import type { Editor } from "@tiptap/core";
import { addRowBefore, CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { holdNode, resolveNodeHold } from "@/core/editor/anchors";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { cellDocPosition, cellElementAt } from "./table-anchors";
import { runTableVerbOn, tableTargetState, tableVerbStates } from "./table-commands";

let pair: CollabPair | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
  document.body.replaceChildren();
});

function table(rows: string[][]) {
  return {
    type: "table",
    content: rows.map((cells) => ({
      type: "table_row",
      content: cells.map((text) => ({
        type: "table_cell",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })),
    })),
  };
}

function mount(): CollabPair {
  pair = createCollabPair({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      table([
        ["one", "two"],
        ["three", "four"],
      ]),
    ],
  });
  document.body.append(pair.local.view.dom);
  return pair;
}

/** Where the cell holding `text` is, in whichever editor is asked. */
function cellPos(instance: Editor, text: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name !== "table_cell") return true;
    if (node.textContent === text) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no cell holding ${text}`);
  return found;
}

function sync(current: CollabPair, write: (peer: Editor) => void): void {
  write(current.peer);
  current.sync();
}

/** Every row of the table, as the text its cells hold. */
function rowTexts(instance: Editor): string[][] {
  const rows: string[][] = [];
  instance.state.doc.descendants((node) => {
    if (node.type.name !== "table_row") return true;
    const cells: string[] = [];
    node.forEach((cell) => {
      cells.push(cell.textContent);
    });
    rows.push(cells);
    return false;
  });
  return rows;
}

/** The hold a surface aims with: whatever cell holds `text`, right now. */
function holdCell(instance: Editor, text: string) {
  const hold = holdNode(instance.state, cellPos(instance, text));
  if (!hold) throw new Error(`no hold on the cell holding ${text}`);
  return hold;
}

/** A collaborator inserts a row above the row holding `text`. */
function peerAddRowAbove(current: CollabPair, text: string): void {
  sync(current, (peer) => {
    const at = cellPos(peer, text);
    peer.view.dispatch(peer.state.tr.setSelection(CellSelection.create(peer.state.doc, at, at)));
    addRowBefore(peer.state, peer.view.dispatch);
  });
}

/** The writer sweeps a rectangle by hand, from one cell to another. */
function sweep(instance: Editor, anchor: string, head: string): void {
  instance.view.dispatch(
    instance.state.tr.setSelection(
      CellSelection.create(instance.state.doc, cellPos(instance, anchor), cellPos(instance, head)),
    ),
  );
}

describe("the cell a grip is aimed at, across a peer's write", () => {
  it("is found from the pointer and answers the same cell as the document", () => {
    const { local } = mount();
    const cell = cellElementAt(local.view, cellPos(local, "four"));
    expect(cell?.tagName).toBe("TD");
    expect(cell && cellDocPosition(local.view, cell)).toBe(cellPos(local, "four"));
  });

  it("keeps its cell, and re-reads the element drawing it, when a peer types elsewhere", () => {
    const current = mount();
    const { local } = current;
    const at = cellPos(local, "four");
    const hold = holdNode(local.state, at);
    expect(hold?.nodeType).toBe("table_cell");
    if (!hold) throw new Error("no hold");

    sync(current, (peer) => {
      peer.commands.insertContentAt(1, "PEER ");
      peer.commands.insertContentAt(cellPos(peer, "one") + 2, "!");
    });

    const now = resolveNodeHold(local.state, hold);
    expect(now?.from).toBe(cellPos(local, "four"));
    expect(local.state.doc.nodeAt(now?.from ?? -1)?.textContent).toBe("four");
    // The crossing back to geometry: whatever is drawing that cell right now.
    const cell = now ? cellElementAt(local.view, now.from) : null;
    expect(cell?.isConnected).toBe(true);
    expect(cell?.textContent).toBe("four");
  });

  it("lets go once a peer deletes the row the cell was in", () => {
    const current = mount();
    const { local } = current;
    const hold = holdNode(local.state, cellPos(local, "four"));
    if (!hold) throw new Error("no hold");

    sync(current, (peer) => {
      const row = peer.state.doc.resolve(cellPos(peer, "three")).before();
      peer.commands.deleteRange({
        from: row,
        to: row + (peer.state.doc.nodeAt(row)?.nodeSize ?? 0),
      });
    });

    expect(resolveNodeHold(local.state, hold)).toBeNull();
  });

  /**
   * A peer's inserted row leaves ANOTHER cell at the number the pointer last
   * read, so a position that still starts a cell says nothing about which cell.
   */
  it("moves with its cell when a peer inserts a row above it, past the imposter left behind", () => {
    const current = mount();
    const { local } = current;
    const settled = cellPos(local, "one");
    const hold = holdCell(local, "one");

    peerAddRowAbove(current, "one");

    // The number still starts a cell — the empty one the peer's row put there.
    expect(local.state.doc.nodeAt(settled)?.type.spec.tableRole).toBe("cell");
    expect(local.state.doc.nodeAt(settled)?.textContent).toBe("");
    // The hold answers with the writer's cell, wherever it now stands.
    const now = resolveNodeHold(local.state, hold);
    expect(now?.from).not.toBe(settled);
    expect(now && local.state.doc.nodeAt(now.from)?.textContent).toBe("one");
  });
});

describe("the cells a table menu's verbs run on, across a peer's write", () => {
  it("is the row a grip menu was opened on, not the row at the number it started from", () => {
    const current = mount();
    const { local } = current;
    const target = { kind: "axis", cell: holdCell(local, "one"), axis: "row" } as const;

    peerAddRowAbove(current, "one");

    expect(runTableVerbOn(local, target, "deleteRow")).toBe(true);
    // The writer's row is the one that went; the peer's new empty row stays.
    expect(rowTexts(local)).toEqual([
      ["", ""],
      ["three", "four"],
    ]);
  });

  it("is the rectangle the writer swept, after the write turned their selection into a caret", () => {
    const current = mount();
    const { local } = current;
    sweep(local, "one", "two");
    const target = {
      kind: "cells",
      anchor: holdCell(local, "one"),
      head: holdCell(local, "two"),
    } as const;

    sync(current, (peer) => {
      peer.commands.insertContentAt(1, "PEER ");
    });

    // What the writer is left standing in, and what the menu still acts on.
    expect(local.state.selection).not.toBeInstanceOf(CellSelection);
    const menuState = tableTargetState(local, target);
    expect(menuState && tableVerbStates(menuState).mergeCells.blockedBy).toBeNull();

    expect(runTableVerbOn(local, target, "mergeCells")).toBe(true);
    expect(rowTexts(local)).toEqual([["one two"], ["three", "four"]]);
  });

  it("is nothing once a peer takes one of those cells away, and the menu has nothing to offer", () => {
    const current = mount();
    const { local } = current;
    sweep(local, "one", "two");
    const target = {
      kind: "cells",
      anchor: holdCell(local, "one"),
      head: holdCell(local, "two"),
    } as const;

    sync(current, (peer) => {
      const at = cellPos(peer, "two");
      peer.view.dispatch(peer.state.tr.setSelection(CellSelection.create(peer.state.doc, at, at)));
      peer.commands.deleteColumn();
    });

    // Absent beats wrong: no state to read verbs from, and no verb runs.
    expect(tableTargetState(local, target)).toBeNull();
    expect(runTableVerbOn(local, target, "mergeCells")).toBe(false);
    expect(rowTexts(local)).toEqual([["one"], ["three"]]);
  });
});
