/**
 * Suggestions inside the live document, on `prosemirror-suggest-changes`: what a view contains,
 * how an edit made to a view becomes suggestions, and accepting or rejecting them.
 */
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  makeDiff,
} from "@sanity/diff-match-patch";
import type { Mark, Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { type Mapping, Transform } from "prosemirror-transform";
import {
  applySuggestion,
  revertSuggestion,
  transformToSuggestionTransaction,
} from "./vendor/prosemirror-suggest-changes/index.js";

/** Who suggests: the Work whose draft it is, the chat and turn that wrote it, and `agent` or `user:<id>`. */
export type Suggester = { work: string; chat: string | null; turn: string | null; by: string };

/** Which suggestions to accept or reject: a Work's, one turn of it, or one change. */
export type SuggestionFilter = { work: string; turn?: string; id?: string };

const SUGGESTION_MARKS = ["insertion", "deletion", "modification", "blockBoundarySuggestion"];

export function newSuggestionId(): string {
  return crypto.randomUUID();
}

function suggestionMark(marks: readonly Mark[], name: "insertion" | "deletion"): Mark | undefined {
  return marks.find((mark) => mark.type.name === name);
}

/**
 * The document a view contains, and the map from the document's positions to the view's. Live
 * (`work` null) hides every insertion and reads every deletion as plain text. A Work's view is
 * Live with that Work's suggestions applied. Blocks are never removed, so the view's block `i` is
 * the document's block `i`.
 */
export function viewOf(doc: PMNode, work: string | null): { doc: PMNode; mapping: Mapping } {
  const hidden: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const insertion = suggestionMark(node.marks, "insertion");
    const deletion = suggestionMark(node.marks, "deletion");
    if ((insertion && insertion.attrs.work !== work) || (deletion && deletion.attrs.work === work))
      hidden.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  const tr = new Transform(doc);
  for (const range of hidden.reverse()) tr.delete(range.from, range.to);
  for (const name of SUGGESTION_MARKS) {
    const type = doc.type.schema.marks[name];
    if (type) tr.removeMark(0, tr.doc.content.size, type);
  }
  return { doc: tr.doc, mapping: tr.mapping };
}

/** Whether the document holds any suggestion: a document with none is its own Live view. */
export function hasSuggestions(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.marks.some((mark) => SUGGESTION_MARKS.includes(mark.type.name))) found = true;
    return !found;
  });
  return found;
}

type Change =
  | { kind: "replace"; from: number; to: number; slice: Slice }
  | { kind: "attrs"; pos: number; attrs: PMNode["attrs"] };

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
  const state = EditorState.create({ doc });
  const tr = state.tr;
  for (const change of changes.reverse()) {
    if (change.kind === "attrs") {
      tr.setNodeMarkup(back.map(change.pos, 1), undefined, change.attrs);
      continue;
    }
    const from = back.map(change.from, 1);
    const to = Math.max(from, back.map(change.to, -1));
    tr.replace(from, to, change.slice);
  }
  return suggester ? suggest(tr, state, suggester).doc : tr.doc;
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
  if (suggester) return suggest(tr, state, suggester);
  const marks = SUGGESTION_MARKS.map((name) => state.schema.marks[name]).filter(Boolean);
  const inserted: [number, number][] = [];
  tr.mapping.maps.forEach((map, index) => {
    const later = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, start, end) => {
      if (end > start) inserted.push([later.map(start, 1), later.map(end, -1)]);
    });
  });
  for (const [from, to] of inserted)
    if (to > from) for (const type of marks) tr.removeMark(from, to, type);
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
      changes.push({ kind: "replace", from, to, slice: inserted });
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

/** Blocks paired by `id`, in order: the longest common subsequence of the two id lists. */
function matchById(before: PMNode[], after: PMNode[]): (readonly [number, number])[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        before[i].attrs.id && before[i].attrs.id === after[j].attrs.id
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i].attrs.id && before[i].attrs.id === after[j].attrs.id) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** A paired block's changes: its attributes, then its inline content as text hunks. */
function diffBlock(before: PMNode, after: PMNode, start: number): Change[] {
  if (before.eq(after)) return [];
  if (before.type !== after.type || !before.isTextblock) {
    return [{ kind: "replace", from: start, to: start + before.nodeSize, slice: sliceOf(after) }];
  }
  const changes: Change[] = [];
  if (JSON.stringify(before.attrs) !== JSON.stringify(after.attrs))
    changes.push({ kind: "attrs", pos: start, attrs: after.attrs });
  const hunks = wordDiff(inlineText(before), inlineText(after));
  let bOff = 0;
  let aOff = 0;
  for (let k = 0; k < hunks.length; ) {
    const [op, text] = hunks[k];
    if (op === DIFF_EQUAL) {
      bOff += text.length;
      aOff += text.length;
      k++;
      continue;
    }
    let deleted = 0;
    let inserted = 0;
    while (k < hunks.length && hunks[k][0] !== DIFF_EQUAL) {
      if (hunks[k][0] === DIFF_DELETE) deleted += hunks[k][1].length;
      if (hunks[k][0] === DIFF_INSERT) inserted += hunks[k][1].length;
      k++;
    }
    changes.push({
      kind: "replace",
      from: start + 1 + bOff,
      to: start + 1 + bOff + deleted,
      slice: after.slice(aOff, aOff + inserted),
    });
    bOff += deleted;
    aOff += inserted;
  }
  return changes;
}

/** A character diff of two strings, aligned to words: each word, space run or mark is one unit. */
function wordDiff(before: string, after: string): [number, string][] {
  const codes = new Map<string, string>();
  const words: string[] = [];
  const encode = (text: string) =>
    (text.match(/\w+|\s+|[^\w\s]/gu) ?? [])
      .map((word) => {
        let code = codes.get(word);
        if (code === undefined) {
          code = String.fromCharCode(0xe000 + words.length);
          codes.set(word, code);
          words.push(word);
        }
        return code;
      })
      .join("");
  const decode = (codesText: string) =>
    [...codesText].map((code) => words[code.charCodeAt(0) - 0xe000]).join("");
  return cleanupSemantic(makeDiff(encode(before), encode(after))).map(([op, text]) => [
    op,
    decode(text),
  ]);
}

function sliceOf(block: PMNode): Slice {
  const doc = block.type.schema.topNodeType.create(null, block);
  return doc.slice(0, doc.content.size);
}

/** A textblock's content as one character per position: text as itself, an inline leaf as U+FFFC. */
function inlineText(block: PMNode): string {
  let out = "";
  block.forEach((child) => {
    out += child.isText ? (child.text ?? "") : "￼";
  });
  return out;
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

/** A Work's suggestions in document order, one per id. */
export function listSuggestions(doc: PMNode, work: string): SuggestionChange[] {
  const byId = new Map<string, SuggestionChange>();
  doc.descendants((node, pos) => {
    // A whole block the library marks on the block node; text inside it carries no mark.
    for (const name of ["insertion", "deletion"] as const) {
      const mark = suggestionMark(node.marks, name);
      if (!mark || mark.attrs.work !== work) continue;
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
      if (name === "insertion") change.inserted += text;
      else change.deleted += text;
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
  const ids = listSuggestions(state.doc, filter.work)
    .filter((change) => filter.turn === undefined || change.turn === filter.turn)
    .filter((change) => filter.id === undefined || change.id === filter.id)
    .map((change) => change.id);
  if (ids.length === 0) return null;
  const tr = state.tr.setMeta(SETTLE_META, true);
  let current = state;
  for (const id of ids) {
    const command = how === "accept" ? applySuggestion(id) : revertSuggestion(id);
    command(current, (step) => {
      for (const s of step.steps) tr.step(s);
      current = current.apply(step);
    });
  }
  return tr;
}
