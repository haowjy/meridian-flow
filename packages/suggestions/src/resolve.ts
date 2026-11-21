import type { Attrs, Mark, Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { type Authors, changeAuthor, type SuggestionAttrs } from "./change.js";
import { RAW_META } from "./rewrite.js";
import {
  type AttrLayer,
  blockKind,
  isSuggestionMark,
  kindOf,
  layered,
  layersOf,
  proposals,
  sameValue,
  type View,
  viewBlock,
} from "./view.js";

/** The turns with suggestions still in `doc`: where a reject of `{ turn }` would change it. */
export function pendingTurns(doc: Node, authors: Authors): Set<string> {
  return pendingBy(doc, (attrs) => authors.get(attrs.id)?.turn ?? null);
}

/** What one draft has pending in a document: its changes, the chats that wrote them, and whether
 * a change is no chat's (the writer's own typing). */
export type DraftPending = { changes: number; chats: string[]; writer: boolean };

/**
 * The drafts with suggestions still in `doc`, each with what it has pending: the views that read it
 * differently from Live, counted as their review lists them (`list`).
 */
export function pendingChanges(doc: Node, authors: Authors): Record<string, DraftPending> {
  const out: Record<string, DraftPending> = {};
  for (const draft of [...pendingBy(doc, (attrs) => attrs.draft)].sort()) {
    const changes = list(doc, { draft }, authors);
    const chats = new Set(changes.flatMap((change) => (change.chat ? [change.chat] : [])));
    out[draft] = {
      changes: changes.length,
      chats: [...chats].sort(),
      writer: changes.some((change) => !change.chat),
    };
  }
  return out;
}

function pendingBy(doc: Node, key: (attrs: SuggestionAttrs) => string | null): Set<string> {
  const found = new Set<string>();
  const note = (attrs: SuggestionAttrs | null) => {
    const value = attrs && key(attrs);
    if (value) found.add(value);
  };
  doc.descendants((node) => {
    note(node.attrs.sug);
    for (const layer of layersOf(node)) note(layer);
    for (const mark of node.marks) if (isSuggestionMark(mark)) note(mark.attrs as SuggestionAttrs);
    return true;
  });
  return found;
}

/** Which suggestions an accept or reject takes: one change, a draft's turn, or a whole draft's. */
export type Filter = { id: string } | { draft: string } | { turn: string };

type Match = (attrs: SuggestionAttrs | null) => boolean;

/** Which suggestions `filter` takes; a turn's are the changes `authors` gives that turn. */
function matcher(filter: Filter, authors: Authors): Match {
  if ("id" in filter) return (attrs) => attrs?.id === filter.id;
  if ("draft" in filter) return (attrs) => attrs?.draft === filter.draft;
  return (attrs) => !!attrs && authors.get(attrs.id)?.turn === filter.turn;
}

/** How a resolve decided a change. */
export type Verdict = "accept" | "reject";

/**
 * On an accept or reject: how it decided each change whose text, block or attribute layer it
 * changed, by id (`ReadonlyMap<string, Verdict>`). The filter's changes take its verdict; an
 * accept also rejects the other drafts' changes deleting the same text. Whoever applies the
 * transaction records them beside the document, in the same transaction, so an Undo of the
 * resolve takes them back with its text.
 */
export const DECIDED_META = "suggestions:decided";

/**
 * Accept: an insertion becomes Live text, a deletion removes its text. One local transaction, which
 * only deletes text and blocks and removes marks and attributes: everything else stays as it is.
 */
export function accept(state: EditorState, filter: Filter, authors: Authors): Transaction {
  return resolve(state, matcher(filter, authors), "accept");
}

/** Reject: an insertion goes, a deletion's text stays Live. Writes as `accept` does. */
export function reject(state: EditorState, filter: Filter, authors: Authors): Transaction {
  return resolve(state, matcher(filter, authors), "reject");
}

function resolve(state: EditorState, matches: Match, action: Verdict): Transaction {
  const tr = state.tr.setMeta(RAW_META, true);
  const { suggest_ins: ins, suggest_del: del } = state.schema.marks;
  const decided = new Map<string, Verdict>();
  const fated = fates(state.doc, matches, action);
  // Every change a fate is read for has a piece the transaction changes or deletes.
  const fateOf = (attrs: SuggestionAttrs | null) => {
    const fate = fated(attrs);
    if (attrs && fate) decided.set(attrs.id, fate);
    return fate;
  };
  const unmark: Array<[number, number, Mark]> = [];
  const remove: Array<[number, number]> = [];
  const set: Array<[number, string, unknown]> = [];
  state.doc.descendants((block, blockPos, parent, index) => {
    if (block.isInline) return false;
    // A block inside it carries the same suggestion, and goes or stays with it. One that stays
    // still holds what later turns layered on it: their deletions inside, a removal of it.
    const blockFate = fateOf(block.attrs.sug);
    if (blockFate === "reject") {
      remove.push([blockPos, blockPos + block.nodeSize]);
      // Later changes inside go with it: the filter's are decided too.
      block.descendants((node) => {
        fateOf(node.attrs.sug ?? null);
        for (const layer of layersOf(node)) fateOf(layer);
        for (const mark of node.marks)
          if (isSuggestionMark(mark)) fateOf(mark.attrs as SuggestionAttrs);
      });
      return false;
    }
    if (blockFate === "accept") set.push([blockPos, "sug", null]);
    const pending = layersOf(block);
    if (pending.some((layer) => fateOf(layer))) {
      // Each layer is its own item: a decided one goes, an earlier one that stays loses only what
      // a later accepted one set (Live has that now), and every other stays the same object.
      const entries: Record<string, AttrLayer> = { ...block.attrs.sugAttrs };
      for (const draft of new Set(pending.map((layer) => layer.draft))) {
        const layers = pending.filter((layer) => layer.draft === draft);
        const accepted = layers.filter((layer) => fateOf(layer) === "accept");
        // A block its container cannot do without (a cell's only block) stays, emptied.
        if (accepted.some((layer) => layer.remove) && parent?.canReplace(index, index + 1))
          remove.push([blockPos, blockPos + block.nodeSize]);
        for (const [key, value] of Object.entries(layered(accepted)))
          set.push([blockPos, key, value]);
        layers.forEach((layer, at) => {
          if (fateOf(layer)) {
            delete entries[layer.layer];
            return;
          }
          const later = layered(accepted.filter((each) => layers.indexOf(each) > at));
          if (!Object.keys(layer.attrs).some((key) => key in later)) return;
          const attrs = Object.fromEntries(
            Object.entries(layer.attrs).filter(([key]) => !(key in later)),
          );
          if (layer.remove || Object.keys(attrs).length > 0)
            entries[layer.layer] = { ...layer, attrs };
          else delete entries[layer.layer];
        });
      }
      set.push([blockPos, "sugAttrs", Object.keys(entries).length > 0 ? entries : null]);
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
  if (decided.size > 0) tr.setMeta(DECIDED_META, decided);
  return tr;
}

/**
 * What happens to each change: the filter's take `action`. Accepting a deletion also rejects
 * every other change that deletes the same text: two drafts' rewrites of one passage, the first
 * applied wins and the other goes whole.
 */
function fates(
  doc: Node,
  matches: Match,
  action: Verdict,
): (attrs: SuggestionAttrs | null) => Verdict | null {
  const chosen = new Set<string>();
  const superseded = new Set<string>();
  if (action === "accept")
    doc.descendants((node) => {
      for (const proposal of [node.attrs.sug, ...layersOf(node)])
        if (matches(proposal)) chosen.add(proposal.id);
      const marks = node.marks.filter(isSuggestionMark);
      for (const mark of marks)
        if (matches(mark.attrs as SuggestionAttrs)) chosen.add(mark.attrs.id);
      if (marks.some((m) => m.type.name === "suggest_del" && matches(m.attrs as SuggestionAttrs)))
        for (const mark of marks)
          if (mark.type.name === "suggest_del" && !matches(mark.attrs as SuggestionAttrs))
            superseded.add(mark.attrs.id);
    });
  for (const id of chosen) superseded.delete(id);
  return (attrs) => (matches(attrs) ? action : attrs && superseded.has(attrs.id) ? "reject" : null);
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
 * One change as a view shows it: who wrote it (null fields when the document has no author for
 * it), what it adds and removes, where it starts, and for a pending change to a block's
 * attributes, the attributes it sets.
 */
export type Change = SuggestionAttrs & {
  chat: string | null;
  turn: string | null;
  by: string | null;
  inserted: string;
  deleted: string;
  attrs: Attrs | null;
  from: number;
  to: number;
};

/** The view's own changes, in document order, for review: what `kindOf` shows as its own. */
export function list(doc: Node, view: View, authors: Authors): Change[] {
  const draft = view.draft;
  if (draft === null) return [];
  const byId = new Map<string, Change>();
  /** Where each change's last listed piece on a side ended. */
  const ends = new Map<string, { inserted: number; deleted: number }>();
  const note = (attrs: SuggestionAttrs, from: number, to: number, add: Partial<Change>) => {
    const change = byId.get(attrs.id) ?? {
      ...(changeAuthor(attrs, authors) ?? { ...attrs, chat: null, turn: null, by: null }),
      inserted: "",
      deleted: "",
      attrs: null,
      from,
      to,
    };
    const end = ends.get(attrs.id) ?? { inserted: from, deleted: from };
    for (const side of ["inserted", "deleted"] as const) {
      const piece = add[side];
      if (!piece) continue;
      // Pieces with Live text between them read as separate words, not one run.
      const gap = change[side] && from > end[side] ? " " : "";
      change[side] += gap + piece;
      end[side] = to;
    }
    ends.set(attrs.id, end);
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
    const layers = proposals(block, draft);
    for (const id of new Set(layers.map((layer) => layer.id))) {
      const ofChange = layers.filter((layer) => layer.id === id);
      const attrs = shownChange(block, ofChange);
      if (attrs) note(ofChange[0], blockPos, end, { attrs });
      // A removed block: its text, if any, is listed struck below; the break is what it removes.
      const removal = ofChange.find((layer) => layer.remove);
      if (removal) note(removal, blockPos, end, { deleted: "\n" });
    }
    if (owner === "own") {
      const shown = viewBlock(block, view)?.textContent ?? "";
      note(block.attrs.sug, blockPos, end, { inserted: `${shown}\n` });
      // Within a block the draft added, what is listed beyond it is a later turn's deletion.
      if (!block.isTextblock) return false;
    }
    if (!block.isTextblock) return true;
    block.forEach((child, offset) => {
      const kind = kindOf(child.marks, block, view);
      if (kind !== "own-ins" && kind !== "own-del") return;
      // The block's own text is listed with the block, above.
      if (owner === "own" && kind === "own-ins") return;
      const name = kind === "own-ins" ? "suggest_ins" : "suggest_del";
      const from = blockPos + 1 + offset;
      const side = kind === "own-ins" ? "inserted" : "deleted";
      // Two tabs of one draft can each mark the same text: every one of them is a change to review.
      for (const mark of child.marks)
        if (mark.type.name === name && mark.attrs.draft === draft)
          note(mark.attrs as SuggestionAttrs, from, from + child.nodeSize, {
            [side]: child.textContent,
          });
    });
    return false;
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

/** What a draft's layers change on a block, compared with Live; null when they change nothing. */
function shownChange(block: Node, layers: readonly AttrLayer[]): Attrs | null {
  const attrs: Record<string, unknown> = { ...layered(layers) };
  for (const key of Object.keys(attrs))
    if (sameValue(attrs[key], block.attrs[key])) delete attrs[key];
  return Object.keys(attrs).length > 0 ? attrs : null;
}
