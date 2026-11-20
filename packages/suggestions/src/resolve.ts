import type { Attrs, Mark, Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { RAW_META } from "./rewrite.js";
import {
  type AttrProposal,
  blockKind,
  kindOf,
  layered,
  proposals,
  type SuggestionAttrs,
  type View,
} from "./view.js";

/** The turns with suggestions still in `doc`: where a reject of `{ turn }` would change it. */
export function pendingTurns(doc: Node): Set<string> {
  const turns = new Set<string>();
  const note = (attrs: SuggestionAttrs | null) => {
    if (attrs?.turn) turns.add(attrs.turn);
  };
  doc.descendants((node) => {
    note(node.attrs.sug);
    for (const proposal of Object.values(proposals(node)).flat()) note(proposal);
    for (const mark of node.marks) if (isSuggestion(mark)) note(mark.attrs as SuggestionAttrs);
    return true;
  });
  return turns;
}

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
  const set: Array<[number, string, unknown]> = [];
  state.doc.descendants((block, blockPos, parent) => {
    if (block.isInline) return false;
    const blockFate = fateOf(block.attrs.sug);
    if (blockFate) {
      // A block inside it carries the same suggestion, and goes or stays with it.
      if (blockFate === "accept") set.push([blockPos, "sug", null]);
      else remove.push([blockPos, blockPos + block.nodeSize]);
      return blockFate === "accept";
    }
    const pending = Object.entries(proposals(block));
    if (pending.some(([, layers]) => layers.some((layer) => fateOf(layer)))) {
      const left: Array<[string, AttrProposal[]]> = [];
      for (const [work, layers] of pending) {
        const accepted = layers.filter((layer) => fateOf(layer) === "accept");
        // A block its container cannot do without (a cell's only block) stays, emptied.
        if (accepted.some((layer) => layer.remove) && parent && parent.childCount > 1)
          remove.push([blockPos, blockPos + block.nodeSize]);
        for (const [key, value] of Object.entries(layered(accepted)))
          set.push([blockPos, key, value]);
        const kept = layers.filter((layer) => !fateOf(layer));
        if (kept.length > 0) left.push([work, kept]);
      }
      set.push([blockPos, "sugAttrs", left.length > 0 ? Object.fromEntries(left) : null]);
    }
    if (!block.isTextblock) return true;
    block.forEach((child, offset) => {
      const from = blockPos + 1 + offset;
      const to = from + child.nodeSize;
      for (const mark of child.marks) {
        if (mark.type !== ins && mark.type !== del) continue;
        const fate = fateOf(mark.attrs as SuggestionAttrs);
        if (!fate) continue;
        if ((mark.type === ins) === (fate === "reject")) remove.push([from, to]);
        else unmark.push([from, to, mark]);
      }
    });
    return false;
  });
  for (const [from, to, mark] of unmark) tr.removeMark(from, to, mark);
  for (const [pos, key, value] of set) tr.setNodeAttribute(pos, key, value);
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
      for (const proposal of [node.attrs.sug, ...Object.values(proposals(node)).flat()])
        if (matches(proposal, filter)) chosen.add(proposal.id);
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

/**
 * One change as a view shows it: what it adds and removes, where it starts, and for a pending
 * change to a block's attributes, the attributes it sets.
 */
export type Change = SuggestionAttrs & {
  inserted: string;
  deleted: string;
  attrs: Attrs | null;
  from: number;
  to: number;
};

/** The view's own changes, in document order, for review: what `kindOf` shows as its own. */
export function list(doc: Node, view: View): Change[] {
  const work = view.work;
  if (work === null || view.hidden.has(work)) return [];
  const byId = new Map<string, Change>();
  const note = (attrs: SuggestionAttrs, from: number, to: number, add: Partial<Change>) => {
    const change = byId.get(attrs.id) ?? {
      ...attrs,
      inserted: "",
      deleted: "",
      attrs: null,
      from,
      to,
    };
    change.inserted += add.inserted ?? "";
    change.deleted += add.deleted ?? "";
    change.attrs = add.attrs ?? change.attrs;
    change.from = Math.min(change.from, from);
    change.to = Math.max(change.to, to);
    byId.set(attrs.id, change);
  };
  doc.descendants((block, blockPos) => {
    if (block.isInline) return false;
    const owner = "sug" in block.attrs ? blockKind(block, view) : "live";
    if (owner === "hidden") return false;
    const end = blockPos + block.nodeSize;
    if (owner === "own") {
      note(block.attrs.sug, blockPos, end, { inserted: `${block.textContent}\n` });
      return false;
    }
    const layers = proposals(block)[work] ?? [];
    const attrs = shownChange(block, layers);
    if (attrs) note(layers[0], blockPos, end, { attrs });
    // A removed block: its text, if any, is listed struck below; the break is what it removes.
    const removal = layers.find((layer) => layer.remove);
    if (removal) note(removal, blockPos, end, { deleted: "\n" });
    if (!block.isTextblock) return true;
    block.forEach((child, offset) => {
      const kind = kindOf(child.marks, block, view);
      if (kind !== "own-ins" && kind !== "own-del") return;
      const name = kind === "own-ins" ? "suggest_ins" : "suggest_del";
      const from = blockPos + 1 + offset;
      const side = kind === "own-ins" ? "inserted" : "deleted";
      // Two tabs of one Work can each mark the same text: every one of them is a change to review.
      for (const mark of child.marks)
        if (mark.type.name === name && mark.attrs.work === work)
          note(mark.attrs as SuggestionAttrs, from, from + child.nodeSize, {
            [side]: child.textContent,
          });
    });
    return false;
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

/** What a Work's layers change on a block, compared with Live; null when they change nothing. */
function shownChange(block: Node, layers: readonly AttrProposal[]): Attrs | null {
  const attrs: Record<string, unknown> = { ...layered(layers) };
  for (const key of Object.keys(attrs))
    if (JSON.stringify(attrs[key] ?? null) === JSON.stringify(block.attrs[key] ?? null))
      delete attrs[key];
  return Object.keys(attrs).length > 0 ? attrs : null;
}
