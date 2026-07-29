// @vitest-environment jsdom
/**
 * A grip serves a cell for as long as the writer is reaching for it, and the
 * table is being written into by collaborators the whole time.
 *
 * Two bindings, because that is the only way to produce the change this has to
 * survive: y-prosemirror replaces the whole ProseMirror document on every remote
 * write, so the mapping reports every position deleted and the elements drawing
 * the table are reconciled underneath. The hold answers which cell; the page
 * answers where it is drawn.
 */
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { holdNode, resolveNodeHold } from "@/core/editor/anchors";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { cellDocPosition, cellElementAt, isTableCellPos } from "./table-anchors";

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
   * The pointer's last reading is a number, and a verb run from the open menu
   * moves every cell after the one it described.
   */
  it("refuses a stale reading that is no longer a cell's own position", () => {
    const current = mount();
    const { local } = current;
    const last = cellPos(local, "four");
    expect(isTableCellPos(local.view, last)).toBe(true);

    sync(current, (peer) => {
      const at = cellPos(peer, "one");
      peer.commands.deleteRange({
        from: peer.state.doc.resolve(at).before(2),
        to: peer.state.doc.content.size,
      });
    });

    expect(isTableCellPos(local.view, last)).toBe(false);
  });
});
