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
  const fateOf = fates(state.doc, filter, action);
  const unmark: Array<[number, number, Mark]> = [];
  const remove: Array<[number, number]> = [];
  const keepBlock: number[] = [];
  state.doc.forEach((block, blockPos) => {
    const blockFate = fateOf(block.attrs.sug);
    if (blockFate) {
      if (blockFate === "accept") keepBlock.push(blockPos);
      else remove.push([blockPos, blockPos + block.nodeSize]);
      return;
    }
    if (!block.isTextblock) return;
    // A Live block whose whole text an accepted change deletes goes with it, and with it any
    // other suggestion's insertion inside, as a Live delete of the block would.
    let wholly = block.content.size > 0;
    block.forEach((child, offset) => {
      const from = blockPos + 1 + offset;
      const to = from + child.nodeSize;
      let kept = false;
      let deleted = false;
      for (const mark of child.marks) {
        if (mark.type !== ins && mark.type !== del) continue;
        const fate = fateOf(mark.attrs as SuggestionAttrs);
        if (!fate) continue;
        if ((mark.type === ins) === (fate === "reject")) remove.push([from, to]);
        else unmark.push([from, to, mark]);
        if (fate === "accept" && mark.type === ins) kept = true;
        if (fate === "accept" && mark.type === del) deleted = true;
      }
      const otherIns = !kept && child.marks.some((m) => m.type === ins);
      if (kept || (!deleted && !otherIns)) wholly = false;
    });
    if (wholly && action === "accept" && state.doc.childCount > 1)
      remove.push([blockPos, blockPos + block.nodeSize]);
  });
  for (const [from, to, mark] of unmark) tr.removeMark(from, to, mark);
  for (const pos of keepBlock) tr.setNodeAttribute(pos, "sug", null);
  for (const [from, to] of merge(remove).reverse()) tr.delete(from, to);
  return tr;
}

/**
 * What happens to each change: the filter's take `action`. Accepting a deletion also rejects
 * every other change that deletes the same text: two Works' rewrites of one passage, the first
 * applied wins and the other goes whole.
 */
function fates(
  doc: Node,
  filter: Filter,
  action: "accept" | "reject",
): (attrs: SuggestionAttrs | null) => "accept" | "reject" | null {
  const chosen = new Set<string>();
  const superseded = new Set<string>();
  if (action === "accept")
    doc.descendants((node) => {
      const marks = node.marks.filter(isSuggestion);
      for (const mark of marks)
        if (matches(mark.attrs as SuggestionAttrs, filter)) chosen.add(mark.attrs.id);
      if (
        marks.some(
          (m) => m.type.name === "suggest_del" && matches(m.attrs as SuggestionAttrs, filter),
        )
      )
        for (const mark of marks)
          if (mark.type.name === "suggest_del" && !matches(mark.attrs as SuggestionAttrs, filter))
            superseded.add(mark.attrs.id);
    });
  for (const id of chosen) superseded.delete(id);
  return (attrs) =>
    matches(attrs, filter) ? action : attrs && superseded.has(attrs.id) ? "reject" : null;
}

function isSuggestion(mark: Mark): boolean {
  return mark.type.name === "suggest_ins" || mark.type.name === "suggest_del";
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

/** The view's own changes, in document order, for review: what `kindOf` shows as its own. */
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
    const owner = blockKind(block, view);
    if (owner === "hidden") return;
    if (owner === "own") {
      note(
        block.attrs.sug,
        blockPos,
        blockPos + block.nodeSize,
        `${block.textContent}\n`,
        "inserted",
      );
      return;
    }
    if (!block.isTextblock) return;
    block.forEach((child, offset) => {
      const kind = kindOf(child.marks, block, view);
      if (kind !== "own-ins" && kind !== "own-del") return;
      const name = kind === "own-ins" ? "suggest_ins" : "suggest_del";
      const mark = child.marks.find((m) => m.type.name === name && m.attrs.work === view.work);
      if (!mark) return;
      const from = blockPos + 1 + offset;
      const side = kind === "own-ins" ? "inserted" : "deleted";
      note(mark.attrs as SuggestionAttrs, from, from + child.nodeSize, child.textContent, side);
    });
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}
