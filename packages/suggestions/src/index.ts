/**
 * Suggestions inside the live document, on `prosemirror-suggest-changes`: what a view contains,
 * how an edit made to a view becomes suggestions, and accepting or rejecting them.
 */

import { withBlockIds, withoutBlockIds } from "@meridian/prosemirror-schema";
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  makeDiff,
} from "@sanity/diff-match-patch";
import type { Mark, Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, Selection, type Transaction } from "prosemirror-state";
import { canJoin, type Mapping, Transform } from "prosemirror-transform";
import { transformToSuggestionTransaction } from "./vendor/prosemirror-suggest-changes/index.js";

/** Who suggests: the Work whose draft it is, the chat and turn that wrote it, and `agent` or `user:<id>`. */
export type Suggester = { work: string; chat: string | null; turn: string | null; by: string };

/** Which suggestions to accept or reject: a Work's, a turn's, or one change. */
export type SuggestionFilter = { work?: string; turn?: string; id?: string };

const SUGGESTION_MARKS = ["insertion", "deletion", "modification", "blockBoundarySuggestion"];

export function newSuggestionId(): string {
  return crypto.randomUUID();
}

function isSuggestion(mark: Mark): boolean {
  return SUGGESTION_MARKS.includes(mark.type.name);
}

/** The suggestion marks a block stores in its `suggestion` attribute. */
function storedMarks(node: PMNode): Mark[] {
  const stored = node.attrs.suggestion as unknown[] | null | undefined;
  return stored ? stored.map((json) => node.type.schema.markFromJSON(json)) : [];
}

/**
 * Turns each block's stored suggestions into the library's marks on the block. Positions don't
 * move, so a transaction built on the document stays valid on the result.
 */
function markBlocks(tr: Transform): void {
  tr.doc.descendants((node, pos) => {
    if (node.isInline) return false;
    const marks = storedMarks(node);
    if (marks.length)
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, suggestion: null }, [
        ...node.marks,
        ...marks,
      ]);
    return true;
  });
}

/**
 * The reverse of `markBlocks`: what Yjs keeps. Adds to what a block already stores. The library
 * writes a block's marks without the suggester, so a mark that names no Work becomes `suggester`'s.
 */
function storeBlocks(tr: Transform, suggester: Suggester | null): void {
  tr.doc.descendants((node, pos) => {
    if (node.isInline) return false;
    const marks = node.marks
      .filter(isSuggestion)
      .map((mark) =>
        suggester && mark.attrs.work === null
          ? mark.type.create({ ...mark.attrs, ...suggester })
          : mark,
      );
    if (marks.length)
      tr.setNodeMarkup(
        pos,
        undefined,
        {
          ...node.attrs,
          suggestion: [...storedMarks(node), ...marks].map((mark) => mark.toJSON()),
        },
        node.marks.filter((mark) => !isSuggestion(mark)),
      );
    return true;
  });
}

function marked(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  markBlocks(tr);
  return tr.doc;
}

/** The suggestions on a node: a text's suggestion marks, or what a block stores. */
function marksOf(node: PMNode): readonly Mark[] {
  return node.isInline ? node.marks.filter(isSuggestion) : storedMarks(node);
}

type Decision = "accept" | "reject" | "keep";

/**
 * Accepts or rejects each suggestion as `decide` says, in `tr`. Accepting an insertion or
 * rejecting a deletion keeps the text; the other two remove it. A split, a join and a retype the
 * library made are kept or undone the same way.
 */
function resolve(tr: Transform, decide: (mark: Mark) => Decision): void {
  const edits: { pos: number; edit: (t: Transform) => void }[] = [];
  tr.doc.descendants((node, pos) => {
    const marks = marksOf(node).filter((mark) => decide(mark) !== "keep");
    if (!marks.length) return !node.isInline;
    const end = pos + node.nodeSize;
    if (!node.isInline) {
      const kept = storedMarks(node).filter((mark) => decide(mark) === "keep");
      edits.push({
        pos,
        edit: (t) =>
          t.setNodeAttribute(pos, "suggestion", kept.length ? kept.map((m) => m.toJSON()) : null),
      });
    }
    for (const mark of marks) {
      const accept = decide(mark) === "accept";
      const name = mark.type.name;
      if ((name === "insertion" && !accept) || (name === "deletion" && accept))
        edits.push({ pos, edit: (t) => t.delete(t.mapping.map(pos), t.mapping.map(end)) });
      else if (node.isInline)
        edits.push({
          pos,
          edit: (t) => t.removeMark(t.mapping.map(pos), t.mapping.map(end), mark),
        });
      else if (name === "modification" && !accept && mark.attrs.attrName)
        edits.push({
          pos,
          edit: (t) => t.setNodeAttribute(pos, mark.attrs.attrName, mark.attrs.previousValue),
        });
      else if (name === "blockBoundarySuggestion" && accept === (mark.attrs.type === "deletion"))
        edits.push({ pos, edit: (t) => joinAt(t, t.mapping.map(end)) });
    }
    return !node.isInline;
  });
  // Later positions first, so an edit's start is still the document's (its end maps past what
  // ran inside it); at one position, in the order pushed.
  for (const { edit } of edits.sort((a, b) => b.pos - a.pos)) edit(tr);
}

/**
 * The document a view contains, and the map from the document's positions to the view's. Live
 * (`work` null) rejects every suggestion; a Work's view accepts that Work's and rejects the rest.
 */
export function viewOf(doc: PMNode, work: string | null): { doc: PMNode; mapping: Mapping } {
  const tr = new Transform(doc);
  resolve(tr, (mark) => (mark.attrs.work === work ? "accept" : "reject"));
  return { doc: tr.doc, mapping: tr.mapping };
}

function joinAt(tr: Transform, pos: number): void {
  if (canJoin(tr.doc, pos)) tr.join(pos);
}

/** Blocks as Live shows them, for readers that hold blocks rather than a document. */
export function liveBlocks(blocks: readonly PMNode[]): PMNode[] {
  const first = blocks[0];
  if (!first) return [];
  const doc = first.type.schema.topNodeType.create(null, blocks);
  if (!hasSuggestions(doc)) return [...blocks];
  return children(viewOf(doc, null).doc);
}

/** Whether the document holds any suggestion: a document with none is its own Live view. */
export function hasSuggestions(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.attrs.suggestion || node.marks.some(isSuggestion)) found = true;
    return !found;
  });
  return found;
}

type Change = { from: number; to: number; slice: Slice };

/**
 * An edit made to a view of `doc` (`after` is the view once edited), written into `doc`: as
 * `suggester`'s suggestions, or straight into the text when there is none. Positions at the edge
 * of hidden text land outside it, so an edit never touches what its view hides. Null when the
 * view is unchanged.
 */
export function writeThroughView(
  doc: PMNode,
  work: string | null,
  after: PMNode,
  suggester: Suggester | null,
): PMNode | null {
  const view = viewOf(doc, work);
  const changes = diffDocs(view.doc, after);
  if (changes.length === 0) return null;
  const back = view.mapping.invert();
  const state = EditorState.create({ doc: marked(doc) });
  const tr = state.tr;
  for (const change of changes.reverse()) {
    const from = back.map(change.from, 1);
    const to = Math.max(from, back.map(change.to, -1));
    tr.replace(from, to, change.slice);
  }
  const out = suggester ? suggest(tr, state, suggester) : tr;
  storeBlocks(out, suggester);
  return out.doc;
}

/** `tr` rewritten into `suggester`'s suggestions instead of edits. */
function suggest(tr: Transaction, state: EditorState, suggester: Suggester): Transaction {
  return transformToSuggestionTransaction(
    tr,
    state,
    newSuggestionId,
    () => ({ ...suggester }),
    // A turn's suggestions keep their own id, so Undo of a turn takes back only that turn.
    (existing, next) => existing.turn !== next.turn || existing.work !== next.work,
  );
}

/**
 * `suggest` for an editor, whose document stores block suggestions as attributes: the library
 * reads the marks from the transaction's documents, so `tr` is replayed on the marked document
 * and the result moved back between the steps that convert there and back.
 */
function suggestOnMarked(tr: Transaction, state: EditorState, suggester: Suggester): Transaction {
  const markedState = EditorState.create({ doc: marked(state.doc) });
  const replayed = markedState.tr;
  for (const step of tr.steps) replayed.step(step);
  if (tr.selectionSet)
    replayed.setSelection(Selection.fromJSON(replayed.doc, tr.selection.toJSON()));
  const suggested = suggest(replayed, markedState, suggester);
  const out = state.tr;
  markBlocks(out);
  for (const step of suggested.steps) out.step(step);
  storeBlocks(out, suggester);
  out.setSelection(Selection.fromJSON(out.doc, suggested.selection.toJSON()));
  if (tr.storedMarksSet) out.setStoredMarks(tr.storedMarks);
  if (tr.scrolledIntoView) out.scrollIntoView();
  // Transaction meta has no public copy; the library copies it the same way.
  (out as unknown as { meta: unknown }).meta = (tr as unknown as { meta: unknown }).meta;
  return out;
}

/** Marks a settle's transaction, so `rewrite` lets it through. */
const SETTLE_META = "suggestions$settle";

/**
 * A local editor transaction as its view allows it. In a Work's view (`suggester` given) the
 * edit becomes the Work's suggestions. In Live, what it inserts loses any suggestion mark it
 * picked up from the text around it, so typing inside another Work's deletion stays the
 * writer's. Sync, Undo and accept or reject pass through.
 */
export function rewrite(
  tr: Transaction,
  state: EditorState,
  suggester: Suggester | null,
): Transaction {
  const sync = tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined;
  if (!tr.docChanged || sync?.isChangeOrigin || tr.getMeta(SETTLE_META)) return tr;
  if (suggester) return suggestOnMarked(tr, state, suggester);
  const marks = SUGGESTION_MARKS.map((name) => state.schema.marks[name]).filter(Boolean);
  const inserted: [number, number][] = [];
  // Live shows no insertion, so a deletion inside a paragraph that swept one up only meant the
  // text around it.
  const hidden: { at: number; node: PMNode }[] = [];
  tr.mapping.maps.forEach((map, index) => {
    const later = tr.mapping.slice(index + 1);
    const before = tr.docs[index];
    map.forEach((oldStart, oldEnd, start, end) => {
      if (end > start) inserted.push([later.map(start, 1), later.map(end, -1)]);
      // A deletion across blocks takes their suggestions with them.
      if (!before || before.resolve(oldStart).parent !== before.resolve(oldEnd).parent) return;
      before.nodesBetween(oldStart, oldEnd, (node, pos) => {
        if (!node.isInline || !node.marks.some((mark) => mark.type.name === "insertion"))
          return true;
        const from = Math.max(pos, oldStart) - pos;
        const to = Math.min(pos + node.nodeSize, oldEnd) - pos;
        hidden.push({ at: later.map(map.map(oldStart, -1), -1), node: node.cut(from, to) });
        return false;
      });
    });
  });
  for (const [from, to] of inserted)
    if (to > from) for (const type of marks) tr.removeMark(from, to, type);
  for (const { at, node } of hidden.reverse()) tr.insert(at, node);
  return tr;
}

/** The document's changes from `before` to `after`, in `before`'s positions, in document order. */
function diffDocs(before: PMNode, after: PMNode): Change[] {
  const beforeBlocks = children(before);
  const afterBlocks = children(after);
  const pairs = matchById(beforeBlocks, afterBlocks);
  const changes: Change[] = [];
  let b = 0;
  let a = 0;
  let pos = 0;
  const offsets = beforeBlocks.map((block) => {
    const start = pos;
    pos += block.nodeSize;
    return start;
  });
  const startOf = (index: number) => (index < beforeBlocks.length ? offsets[index] : pos);
  for (const [pb, pa] of [...pairs, [beforeBlocks.length, afterBlocks.length] as const]) {
    if (b < pb || a < pa) {
      const from = startOf(b);
      const to = startOf(pb);
      const inserted = after.slice(afterOffset(afterBlocks, a), afterOffset(afterBlocks, pa));
      changes.push({ from, to, slice: inserted });
    }
    if (pb < beforeBlocks.length && pa < afterBlocks.length)
      changes.push(...diffBlock(beforeBlocks[pb], afterBlocks[pa], offsets[pb]));
    b = pb + 1;
    a = pa + 1;
  }
  return changes;
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => {
    out.push(child);
  });
  return out;
}

function afterOffset(blocks: PMNode[], index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += blocks[i].nodeSize;
  return pos;
}

/**
 * Blocks paired by `id`, in order: block ids are unique, so the pairs are the longest increasing
 * run of `after` indices taken in `before` order.
 */
function matchById(before: PMNode[], after: PMNode[]): (readonly [number, number])[] {
  const afterIndex = new Map<unknown, number>();
  after.forEach((block, j) => {
    if (block.attrs.id) afterIndex.set(block.attrs.id, j);
  });
  const candidates: [number, number][] = [];
  before.forEach((block, i) => {
    const j = block.attrs.id ? afterIndex.get(block.attrs.id) : undefined;
    if (j !== undefined) candidates.push([i, j]);
  });
  // Patience sorting: `tails[k]` ends the best run of length k+1 found so far.
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  candidates.forEach(([, j], c) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[c] = tails[lo - 1];
    tails[lo] = c;
  });
  const pairs: [number, number][] = [];
  for (let c = tails.at(-1) ?? -1; c >= 0; c = previous[c]) pairs.push(candidates[c]);
  return pairs.reverse();
}

/** A paired block's changes: its attributes, then its inline content as text hunks. */
function diffBlock(before: PMNode, after: PMNode, start: number): Change[] {
  if (before.eq(after)) return [];
  // A retyped block is the old one deleted and a new one inserted, as text is: both versions
  // stay in the document, so a writer's edit to either is never mistaken for the other.
  if (
    before.type !== after.type ||
    !before.isTextblock ||
    JSON.stringify(before.attrs) !== JSON.stringify(after.attrs)
  ) {
    const fresh = withBlockIds(withoutBlockIds(after));
    return [{ from: start, to: start + before.nodeSize, slice: sliceOf(fresh) }];
  }
  const changes: Change[] = [];
  let bOff = 0;
  let aOff = 0;
  const hunks = tokenDiff(tokens(before), tokens(after));
  for (let k = 0; k < hunks.length; ) {
    const [op, size] = hunks[k];
    if (op === DIFF_EQUAL) {
      bOff += size;
      aOff += size;
      k++;
      continue;
    }
    let deleted = 0;
    let inserted = 0;
    while (k < hunks.length && hunks[k][0] !== DIFF_EQUAL) {
      if (hunks[k][0] === DIFF_DELETE) deleted += hunks[k][1];
      if (hunks[k][0] === DIFF_INSERT) inserted += hunks[k][1];
      k++;
    }
    changes.push({
      from: start + 1 + bOff,
      to: start + 1 + bOff + deleted,
      slice: after.slice(aOff, aOff + inserted),
    });
    bOff += deleted;
    aOff += inserted;
  }
  return changes;
}

/** A textblock's content as units to diff: each word, space run or sign with its marks, and each inline leaf. */
function tokens(block: PMNode): { key: string; size: number }[] {
  const out: { key: string; size: number }[] = [];
  block.forEach((child) => {
    const marks = JSON.stringify(child.marks.map((mark) => mark.toJSON()));
    if (!child.isText) {
      out.push({ key: JSON.stringify(child.toJSON()), size: child.nodeSize });
      return;
    }
    for (const word of child.text?.match(/\w+|\s+|[^\w\s]/gu) ?? [])
      out.push({ key: `${word}\u0000${marks}`, size: word.length });
  });
  return out;
}

/** The diff of two token runs, as `[op, size]` hunks: each token is one character to the differ. */
function tokenDiff(
  before: { key: string; size: number }[],
  after: { key: string; size: number }[],
): [number, number][] {
  const codes = new Map<string, string>();
  const sizes: number[] = [];
  const encode = (run: { key: string; size: number }[]) =>
    run
      .map(({ key, size }) => {
        let code = codes.get(key);
        if (code === undefined) {
          code = String.fromCharCode(0xe000 + sizes.length);
          codes.set(key, code);
          sizes.push(size);
        }
        return code;
      })
      .join("");
  return cleanupSemantic(makeDiff(encode(before), encode(after))).map(([op, text]) => [
    op,
    [...text].reduce((sum, code) => sum + sizes[code.charCodeAt(0) - 0xe000], 0),
  ]);
}

function sliceOf(block: PMNode): Slice {
  const doc = block.type.schema.topNodeType.create(null, block);
  return doc.slice(0, doc.content.size);
}

/** One suggestion of a Work: its id, turn, and what it adds and removes. */
export type SuggestionChange = {
  id: string;
  turn: string | null;
  chat: string | null;
  by: string | null;
  inserted: string;
  deleted: string;
  from: number;
  to: number;
};

/** The suggestions in document order, one per id: a Work's, or every Work's when `work` is omitted. */
export function listSuggestions(doc: PMNode, work?: string): SuggestionChange[] {
  const byId = new Map<string, SuggestionChange>();
  doc.descendants((node, pos) => {
    for (const mark of marksOf(node)) {
      if (work !== undefined && mark.attrs.work !== work) continue;
      const id = String(mark.attrs.id);
      const change = byId.get(id) ?? {
        id,
        turn: mark.attrs.turn,
        chat: mark.attrs.chat,
        by: mark.attrs.by,
        inserted: "",
        deleted: "",
        from: pos,
        to: pos,
      };
      const text = node.isText ? (node.text ?? "") : node.isInline ? "\uFFFC" : node.textContent;
      if (mark.type.name === "insertion") change.inserted += text;
      if (mark.type.name === "deletion") change.deleted += text;
      change.to = pos + node.nodeSize;
      byId.set(id, change);
    }
    return !node.isInline;
  });
  return [...byId.values()];
}

/**
 * Accepts or rejects the suggestions `filter` names, as one transaction on `state`, so one Undo
 * takes it back. Null when there is nothing to settle.
 */
export function settleSuggestions(
  state: EditorState,
  filter: SuggestionFilter,
  how: "accept" | "reject",
): Transaction | null {
  const ids = new Set(
    listSuggestions(state.doc, filter.work)
      .filter((change) => filter.turn === undefined || change.turn === filter.turn)
      .filter((change) => filter.id === undefined || change.id === filter.id)
      .map((change) => change.id),
  );
  if (ids.size === 0) return null;
  const tr = state.tr.setMeta(SETTLE_META, true);
  resolve(tr, (mark) => (ids.has(String(mark.attrs.id)) ? how : "keep"));
  return tr;
}

/** `settleSuggestions` for a caller that holds a document rather than an editor. */
export function settleInDoc(
  doc: PMNode,
  filter: SuggestionFilter,
  how: "accept" | "reject",
): PMNode | null {
  return settleSuggestions(EditorState.create({ doc }), filter, how)?.doc ?? null;
}
