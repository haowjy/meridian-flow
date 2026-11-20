import type { Mark, Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { RAW_META } from "./rewrite.js";
import { blockKind, kindOf, type SuggestionAttrs, type View } from "./view.js";

/** Which suggestions an accept or reject takes: one change, a Work's turn, or a whole Work's. */
export type Filter = { id: string } | { work: string } | { turn: string };

function matches(attrs: SuggestionAttrs | null, filter: Filter): boolean {
  if (!attrs) return false;
  if ("id" in filter) return attrs.id === filter.id;
  if ("turn" in filter) return attrs.turn === filter.turn;
  return attrs.work === filter.work;
}

/** Accept: an insertion becomes Live text, a deletion removes its text. One local transaction. */
export function accept(state: EditorState, filter: Filter): Transaction {
  return resolve(state, filter, "accept");
}

/** Reject: an insertion goes, a deletion's text stays Live. One local transaction. */
export function reject(state: EditorState, filter: Filter): Transaction {
  return resolve(state, filter, "reject");
}

function resolve(state: EditorState, filter: Filter, action: "accept" | "reject"): Transaction {
  const tr = state.tr.setMeta(RAW_META, true);
  const { suggest_ins: ins, suggest_del: del } = state.schema.marks;
  const unmark: Array<[number, number, Mark]> = [];
  const remove: Array<[number, number]> = [];
  const keepBlock: number[] = [];
  state.doc.forEach((block, blockPos) => {
    if (matches(block.attrs.sug, filter)) {
      if (action === "accept") keepBlock.push(blockPos);
      else remove.push([blockPos, blockPos + block.nodeSize]);
      return;
    }
    if (!block.isTextblock) return;
    // A Live block whose whole text this suggestion deletes goes with it when accepted.
    let wholly = block.content.size > 0;
    block.forEach((child, offset) => {
      const from = blockPos + 1 + offset;
      const to = from + child.nodeSize;
      const insMark = child.marks.find(
        (m) => m.type === ins && matches(m.attrs as SuggestionAttrs, filter),
      );
      const delMark = child.marks.find(
        (m) => m.type === del && matches(m.attrs as SuggestionAttrs, filter),
      );
      // Whole means all of its Live text: another suggestion's insertion goes with the block.
      const otherIns = !insMark && child.marks.some((m) => m.type === ins);
      if (insMark || (!delMark && !otherIns)) wholly = false;
      if (insMark) action === "accept" ? unmark.push([from, to, insMark]) : remove.push([from, to]);
      if (delMark) action === "accept" ? remove.push([from, to]) : unmark.push([from, to, delMark]);
    });
    if (wholly && action === "accept" && state.doc.childCount > 1)
      remove.push([blockPos, blockPos + block.nodeSize]);
  });
  for (const [from, to, mark] of unmark) tr.removeMark(from, to, mark);
  for (const pos of keepBlock) tr.setNodeAttribute(pos, "sug", null);
  for (const [from, to] of merge(remove).reverse()) tr.delete(from, to);
  return tr;
}

/** Sorted, with touching ranges joined, so each delete sees the positions it was planned on. */
function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}

/** One change as a view shows it: what it adds and removes, where it starts. */
export type Change = SuggestionAttrs & {
  inserted: string;
  deleted: string;
  from: number;
  to: number;
};

/** The view's own changes, in document order, for review. */
export function list(doc: Node, view: View): Change[] {
  if (view.work === null) return [];
  const byId = new Map<string, Change>();
  const note = (
    attrs: SuggestionAttrs,
    from: number,
    to: number,
    text: string,
    side: "inserted" | "deleted",
  ) => {
    const change = byId.get(attrs.id) ?? { ...attrs, inserted: "", deleted: "", from, to };
    change[side] += text;
    change.from = Math.min(change.from, from);
    change.to = Math.max(change.to, to);
    byId.set(attrs.id, change);
  };
  doc.forEach((block, blockPos) => {
    if (blockKind(block, view) === "hidden") return;
    if (block.attrs.sug) {
      note(
        block.attrs.sug,
        blockPos,
        blockPos + block.nodeSize,
        `${block.textContent}\n`,
        "inserted",
      );
      return;
    }
    block.forEach((child, offset) => {
      const from = blockPos + 1 + offset;
      // An insertion a later turn of this view removes again is in neither column.
      if (
        child.marks.some((m) => m.type.name === "suggest_ins") &&
        kindOf(child.marks, block, view) === "own-del"
      )
        return;
      for (const mark of child.marks) {
        const attrs = mark.attrs as SuggestionAttrs;
        if (attrs.work !== view.work || view.hidden.has(attrs.work)) continue;
        if (mark.type.name === "suggest_ins")
          note(attrs, from, from + child.nodeSize, child.textContent, "inserted");
        if (mark.type.name === "suggest_del")
          note(attrs, from, from + child.nodeSize, child.textContent, "deleted");
      }
    });
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}
