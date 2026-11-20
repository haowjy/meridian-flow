import { Fragment, type Mark, type Node, type Schema, type Slice } from "prosemirror-model";
import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import {
  AddMarkStep,
  Mapping,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
} from "prosemirror-transform";
import {
  blockKind,
  isSuggestionMark,
  kindOf,
  type RunKind,
  type SuggestionAttrs,
  stripSlice,
  stripSuggestions,
  type View,
  visibleContent,
} from "./view.js";

/** A transaction already in stored form (accept, reject, a peer's or Undo's): never rewritten. */
export const RAW_META = "suggestions:raw";

/** On a rewritten transaction: per step of the original, the change a Work's edit belongs to. */
export const CHANGE_META = "suggestions:change";

/** Who is writing: everything but the change id, which the rewrite picks, and the Work, the view's. */
export type Author = Omit<SuggestionAttrs, "id" | "work">;

/** A fresh change id. Unique across Works and tabs without reading the document. */
export function newChangeId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Turns a local transaction into what the view allows, on `state` (the transaction's start).
 * In a Work's view, typing becomes that Work's insertion, deleting Live text becomes its
 * deletion, deleting its own insertion is a real delete, and another Work's text is never
 * touched. In the Live view (`view.work === null`) edits land, but hidden suggestions are kept
 * and nothing typed or pasted carries a suggestion. Returns the original transaction when it
 * needs no rewrite.
 */
export function rewrite(
  tr: Transaction,
  state: EditorState,
  view: View,
  author: Author | null,
): Transaction {
  if (!tr.docChanged || tr.getMeta(RAW_META)) return tr;
  if (
    view.work === null &&
    !tr.steps.some((step, index) => touchesSuggestions(step, tr.docs[index], view))
  )
    return tr;
  const out = state.tr;
  for (const [key, value] of Object.entries(
    (tr as unknown as { meta: Record<string, unknown> }).meta,
  ))
    out.setMeta(key, value);
  if (tr.storedMarksSet) out.setStoredMarks(tr.storedMarks);
  let caret: number | null = null;
  const changes: Array<SuggestionAttrs | null> = [];
  tr.steps.forEach((step, index) => {
    // `Mapping.slice(...).invert()` inverts every map, not the slice's: build it from the maps.
    const back = new Mapping(tr.mapping.maps.slice(0, index)).invert();
    const at = (pos: number, assoc = 1) => out.mapping.map(back.map(pos, assoc), assoc);
    caret =
      rewriteStep(
        out,
        step,
        at,
        view,
        author,
        state.selection.empty ? state.selection.head : null,
        (change) => {
          changes[index] = change;
        },
      ) ?? caret;
  });
  out.setMeta(CHANGE_META, changes);
  if (caret !== null)
    out.setSelection(TextSelection.near(out.doc.resolve(Math.min(caret, out.doc.content.size))));
  if (tr.scrolledIntoView) out.scrollIntoView();
  return out;
}

type At = (pos: number, assoc?: number) => number;

/**
 * Maps a position read from `out.doc` now through the steps added after this call: `out.mapping`
 * also holds the steps before it, which the position has already passed.
 */
function since(out: Transaction): At {
  const start = out.mapping.maps.length;
  return (pos, assoc = 1) => out.mapping.slice(start).map(pos, assoc);
}

/** Whether a Live-view step must be rewritten: it removes hidden text or carries a suggestion. */
function touchesSuggestions(step: Step, doc: Node, view: View): boolean {
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const { from, to } = step as unknown as { from: number; to: number };
    return pieces(doc, from, to, view).some((piece) => piece.kind === "hidden");
  }
  if (!(step instanceof ReplaceStep)) return false;
  const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
  let carries = false;
  slice.content.descendants((node) => {
    if (node.attrs.sug || node.marks.some(isSuggestionMark)) carries = true;
    return !carries;
  });
  if (carries) return true;
  const hiddenAt = (pos: number) => {
    const block = topBlock(doc, pos);
    return !!block && blockKind(block.node, view) === "hidden";
  };
  return (
    hiddenAt(from) ||
    hiddenAt(to) ||
    pieces(doc, from, to, view).some((piece) => piece.kind === "hidden") ||
    wholeBlocks(doc, from, to).some(({ node }) => blockKind(node, view) === "hidden")
  );
}

function rewriteStep(
  out: Transaction,
  step: Step,
  at: At,
  view: View,
  author: Author | null,
  caretBefore: number | null,
  changed: (change: SuggestionAttrs) => void,
): number | null {
  if (step instanceof ReplaceStep) {
    const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
    // An edit that reaches into a block the view hides reaches the nearest block it shows.
    const a = shownEdge(out.doc, at(from, -1), view, -1);
    const b = Math.max(a, shownEdge(out.doc, at(to, 1), view, 1));
    const forward = caretBefore !== null && caretBefore === a && slice.size === 0;
    return view.work === null || !author
      ? replaceLive(out, a, b, stripSlice(slice), view, forward)
      : replaceInWork(
          out,
          a,
          b,
          stripSlice(slice),
          view,
          { ...author, work: view.work },
          forward,
          changed,
        );
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const { from, to, mark } = step as unknown as { from: number; to: number; mark: Mark };
    const a = at(from, 1);
    const b = at(to, -1);
    const add = step instanceof AddMarkStep;
    // A mark reaches only what the view shows. In a Work's view a comment anchors on any of it,
    // and formatting only on the Work's own insertions (suggested formatting is not built).
    const reaches = (kind: RunKind) =>
      view.work === null
        ? kind === "live"
        : mark.type.name === "comment"
          ? kind !== "hidden"
          : kind === "own-ins";
    for (const piece of pieces(out.doc, a, b, view))
      if (reaches(piece.kind))
        add ? out.addMark(piece.from, piece.to, mark) : out.removeMark(piece.from, piece.to, mark);
    return null;
  }
  // Attribute and wrapping steps: Live takes them; a Work's view only on its own blocks.
  const mapped = step.map(out.mapping);
  if (!mapped) return null;
  if (view.work !== null) {
    const range = stepRange(mapped);
    if (!range) return null;
    let own = true;
    out.doc.nodesBetween(range.from, Math.max(range.to, range.from + 1), (node, pos) => {
      if (
        pos >= 0 &&
        node.isBlock &&
        out.doc.resolve(pos).depth === 0 &&
        blockKind(node, view) !== "own"
      )
        own = false;
      return false;
    });
    if (!own) return null;
  }
  out.maybeStep(mapped);
  return null;
}

function stepRange(step: Step): { from: number; to: number } | null {
  const range = step as unknown as { from?: number; to?: number; pos?: number };
  if (typeof range.from === "number" && typeof range.to === "number")
    return { from: range.from, to: range.to };
  if (typeof range.pos === "number") return { from: range.pos, to: range.pos + 1 };
  return null;
}

/** An inline stretch, with the textblock it sits in. */
type Piece = { from: number; to: number; kind: RunKind; block: Node; blockPos: number };

/** The inline pieces of `[from, to)`, cut to the range, in document order. */
function pieces(doc: Node, from: number, to: number, view: View): Piece[] {
  const out: Piece[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isInline || !parent) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start >= end) return false;
    const blockPos = doc.resolve(pos).before();
    const kind = kindOf(node.marks, parent, view);
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === start && last.blockPos === blockPos)
      last.to = end;
    else out.push({ from: start, to: end, kind, block: parent, blockPos });
    return false;
  });
  return out;
}

/** Top-level blocks wholly inside `[from, to)`. */
function wholeBlocks(doc: Node, from: number, to: number): { node: Node; pos: number }[] {
  const out: { node: Node; pos: number }[] = [];
  doc.forEach((node, pos) => {
    if (pos >= from && pos + node.nodeSize <= to) out.push({ node, pos });
  });
  return out;
}

/** `pos`, or when it lies in a hidden block, the near edge of the closest shown textblock that way. */
function shownEdge(doc: Node, pos: number, view: View, direction: -1 | 1): number {
  const block = topBlock(doc, pos);
  if (!block || blockKind(block.node, view) !== "hidden") return pos;
  let edge = direction < 0 ? 0 : doc.content.size;
  doc.forEach((node, at) => {
    if (blockKind(node, view) === "hidden" || !node.isTextblock) return;
    if (direction < 0 && at < block.pos) edge = at + node.nodeSize - 1;
    if (direction > 0 && at > block.pos && edge === doc.content.size) edge = at + 1;
  });
  return edge;
}

/** The top-level block a position inside a block lies in. */
function topBlockAt(doc: Node, pos: number): { node: Node; pos: number } {
  const block = topBlock(doc, pos);
  if (!block) throw new Error(`Position ${pos} is not inside a block`);
  return block;
}

function topBlock(doc: Node, pos: number): { node: Node; pos: number } | null {
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return null;
  return { node: $pos.node(1), pos: $pos.before(1) };
}

// ─── The Live view ──────────────────────────────────────────────────

function replaceLive(
  out: Transaction,
  from: number,
  to: number,
  slice: Slice,
  view: View,
  forward: boolean,
): number | null {
  const doc = out.doc;
  const hiddenInside =
    pieces(doc, from, to, view).some((piece) => piece.kind === "hidden") ||
    wholeBlocks(doc, from, to).some(({ node }) => blockKind(node, view) === "hidden");
  if (!hiddenInside) {
    out.replace(from, to, slice);
    return null;
  }
  // Delete only what is shown; hidden suggestions stay where they are.
  const map = since(out);
  const startBlock = topBlock(doc, from);
  const endBlock = topBlock(doc, to);
  const removed: Array<[number, number]> = [];
  for (const piece of pieces(doc, from, to, view))
    if (piece.kind !== "hidden") removed.push([piece.from, piece.to]);
  for (const { node, pos } of wholeBlocks(doc, from, to))
    if (blockKind(node, view) !== "hidden") removed.push([pos, pos + node.nodeSize]);
  for (const [a, b] of removed.sort((x, y) => y[0] - x[0])) out.delete(map(a, 1), map(b, -1));
  // A join across hidden blocks moves the last block's text to the end of the first; the hidden
  // blocks stay between, where they were.
  if (startBlock && endBlock && startBlock.pos !== endBlock.pos) {
    const endAt = map(endBlock.pos, 1);
    const end = out.doc.nodeAt(endAt);
    const target = map(startBlock.pos + startBlock.node.nodeSize - 1, -1);
    if (end?.isTextblock) {
      out.delete(endAt, endAt + end.nodeSize);
      out.insert(target, end.content);
    }
  }
  const insertAt = map(from, -1);
  if (slice.size > 0) {
    const inserted = since(out);
    out.replace(insertAt, insertAt, slice);
    return inserted(insertAt, 1);
  }
  return forward && removed.length === 0 ? map(to, 1) : insertAt;
}

// ─── A Work's view ──────────────────────────────────────────────────

function marked(schema: Schema, content: Fragment, attrs: SuggestionAttrs): Fragment {
  const mark = schema.marks.suggest_ins.create(attrs);
  const nodes: Node[] = [];
  content.forEach((node) => {
    nodes.push(node.isInline ? node.mark(mark.addToSet(node.marks)) : node);
  });
  return Fragment.from(nodes);
}

function sameAuthor(attrs: SuggestionAttrs, author: Omit<SuggestionAttrs, "id">): boolean {
  return (
    attrs.work === author.work &&
    attrs.turn === author.turn &&
    attrs.chat === author.chat &&
    attrs.by === author.by
  );
}

/** The id an edit at `pos` continues: the same author's neighbouring change of the same turn. */
function continuedId(doc: Node, pos: number, author: Omit<SuggestionAttrs, "id">): string | null {
  const $pos = doc.resolve(pos);
  for (const node of [$pos.nodeBefore, $pos.nodeAfter])
    for (const mark of node?.marks ?? [])
      if (isSuggestionMark(mark) && sameAuthor(mark.attrs as SuggestionAttrs, author))
        return mark.attrs.id as string;
  const block = $pos.depth >= 1 ? $pos.node(1) : null;
  const sug = block?.attrs.sug as SuggestionAttrs | null;
  return sug && sameAuthor(sug, author) ? sug.id : null;
}

/**
 * Remove `[from, to)` as the view sees it: Live text gets this Work's deletion mark, its own
 * insertions go, and own deletions and hidden text stay. Applied right to left.
 */
function suggestRemoval(
  out: Transaction,
  from: number,
  to: number,
  view: View,
  attrs: SuggestionAttrs,
): void {
  const schema = out.doc.type.schema;
  const del = schema.marks.suggest_del.create(attrs);
  const own = wholeBlocks(out.doc, from, to).filter(({ node }) => blockKind(node, view) === "own");
  const inOwn = (pos: number) =>
    own.some((block) => pos >= block.pos && pos < block.pos + block.node.nodeSize);
  const work = pieces(out.doc, from, to, view).filter((piece) => !inOwn(piece.from));
  const map = since(out);
  for (const piece of work.reverse()) {
    if (piece.kind === "live") out.addMark(piece.from, piece.to, del);
    else if (piece.kind === "own-ins") retract(out, piece.from, piece.to, del, attrs);
  }
  for (const block of own.reverse()) {
    const a = map(block.pos, 1);
    out.delete(a, a + block.node.nodeSize);
  }
}

/**
 * Remove the view's own insertion in `[from, to)`. One the same turn wrote, or the writer's (no
 * turn), goes. An earlier turn's stays under this turn's deletion: rejecting this turn, as the
 * card's Undo does, brings it back. A block the Work added is one insertion, resolved whole:
 * text inside it just goes.
 */
function retract(out: Transaction, from: number, to: number, del: Mark, attrs: SuggestionAttrs) {
  const ranges: Array<[number, number, boolean]> = [];
  out.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isInline) return true;
    const ins = node.marks.find((mark) => mark.type.name === "suggest_ins");
    const layered = attrs.turn !== null && !parent?.attrs.sug && ins?.attrs.turn !== attrs.turn;
    ranges.push([Math.max(from, pos), Math.min(to, pos + node.nodeSize), layered]);
    return false;
  });
  for (const [a, b, layered] of ranges.reverse()) {
    if (layered) out.addMark(a, b, del);
    else out.delete(a, b);
  }
}

/**
 * The id of the view's own insertion an edit over `[from, to)` replaces, from an earlier turn: an
 * inline insertion's, or the block's when the Work added the whole block.
 */
function replacedId(doc: Node, from: number, to: number, view: View): string | null {
  let id: string | null = null;
  doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (id || !node.isInline || !parent) return !id;
    if (kindOf(node.marks, parent, view) !== "own-ins") return false;
    id =
      (node.marks.find((mark) => mark.type.name === "suggest_ins")?.attrs.id as string) ??
      (parent.attrs.sug as SuggestionAttrs | null)?.id ??
      null;
    return false;
  });
  return id;
}

/** Inside a stretch of its own deletion, typing goes to the stretch's end. */
function pastOwnDeletion(doc: Node, pos: number, view: View): number {
  let $pos = doc.resolve(pos);
  const isOwnDel = (node: Node | null | undefined) =>
    !!node && node.isInline && kindOf(node.marks, $pos.parent, view) === "own-del";
  for (
    let after = $pos.nodeAfter;
    after && isOwnDel($pos.nodeBefore) && isOwnDel(after);
    after = $pos.nodeAfter
  ) {
    pos += after.nodeSize;
    $pos = doc.resolve(pos);
  }
  return pos;
}

function replaceInWork(
  out: Transaction,
  from: number,
  to: number,
  slice: Slice,
  view: View,
  author: Omit<SuggestionAttrs, "id">,
  forward: boolean,
  changed: (change: SuggestionAttrs) => void,
): number | null {
  const startBlock = topBlock(out.doc, from);
  const endBlock = topBlock(out.doc, to);
  // Between blocks (a gap cursor, a whole-block paste): new blocks are this Work's blocks.
  if (!startBlock || !endBlock || !startBlock.node.isTextblock || !endBlock.node.isTextblock) {
    if (from !== to || slice.openStart !== 0 || slice.size === 0) return null;
    const attrs = { ...author, id: newChangeId() };
    changed(attrs);
    const blocks: Node[] = [];
    slice.content.forEach((block) => {
      blocks.push(block.type.create({ ...block.attrs, sug: attrs }, block.content, block.marks));
    });
    out.insert(from, blocks);
    return null;
  }
  const attrs: SuggestionAttrs = {
    ...author,
    id:
      continuedId(out.doc, from, author) ??
      continuedId(out.doc, to, author) ??
      (author.turn === null ? null : replacedId(out.doc, from, to, view)) ??
      newChangeId(),
  };
  // Text cut from a block the Work added stays that block's insertion, whoever cuts it.
  const startOwn = blockKind(startBlock.node, view) === "own";
  const change = startOwn ? (startBlock.node.attrs.sug as SuggestionAttrs) : attrs;
  changed(change);
  const schema = out.doc.type.schema;
  const joining = startBlock.pos !== endBlock.pos;
  const endOwn = blockKind(endBlock.node, view) === "own";
  // What follows the cut in the last block moves to where the cut closes: kept as a copy, since
  // Live text never moves in a Work's view. Into a block the Work added it does not move at all:
  // the copy would become that block's insertion, gone with it. The Live block stays after it.
  const keepEnd = joining && startOwn && !endOwn;
  const tail =
    joining && !keepEnd
      ? visibleContent(endBlock.node, to - endBlock.pos - 1, endBlock.node.content.size, view)
      : Fragment.empty;
  const map = since(out);
  suggestRemoval(
    out,
    from,
    joining && !keepEnd ? endBlock.pos + endBlock.node.nodeSize - 1 : to,
    view,
    attrs,
  );
  if (joining && endOwn) {
    // An own block goes whole; its text is already copied as the tail.
    const a = map(endBlock.pos, 1);
    const own = out.doc.nodeAt(a);
    if (own?.attrs.sug) out.delete(a, a + own.nodeSize);
  }
  const blockEnd = map(startBlock.pos + startBlock.node.nodeSize - 1, -1);
  let insertAt = joining ? blockEnd : pastOwnDeletion(out.doc, map(to, 1), view);
  const target = topBlockAt(out.doc, insertAt);
  const ownTarget = blockKind(target.node, view) === "own";
  const inline = (content: Fragment) => (ownTarget ? content : marked(schema, content, attrs));

  const parts = sliceParts(slice);
  if (!parts.split) {
    const head = parts.head.append(tail);
    if (head.size > 0) out.insert(insertAt, inline(head));
    if (slice.size > 0) return insertAt + parts.head.size;
    if (joining) return insertAt;
    return forward ? map(to, 1) : map(from, -1);
  }
  // A split: the target keeps its text up to the cut; the rest is suggested as new blocks.
  if (parts.head.size > 0) {
    out.insert(insertAt, inline(parts.head));
    insertAt += parts.head.size;
  }
  const targetNow = topBlockAt(out.doc, insertAt);
  if (keepEnd) {
    // The Live block kept after the cut is the split's second half: the paste's whole blocks go
    // before it and its last line opens it, all the writer's.
    const opensAt = map(to, 1);
    const blocks = parts.middle.map((block) =>
      block.type.create({ ...block.attrs, id: null, sug: attrs }, block.content, block.marks),
    );
    const opening = parts.last?.content ?? Fragment.empty;
    if (opening.size > 0) out.insert(opensAt, marked(schema, opening, attrs));
    if (blocks.length > 0) out.insert(targetNow.pos + targetNow.node.nodeSize, blocks);
    return opensAt + blocks.reduce((size, block) => size + block.nodeSize, 0) + opening.size;
  }
  const targetEnd = targetNow.pos + targetNow.node.nodeSize - 1;
  const rest = visibleContent(
    targetNow.node,
    insertAt - targetNow.pos - 1,
    targetNow.node.content.size,
    view,
  ).append(tail);
  const cut = since(out);
  if (ownTarget) out.delete(insertAt, targetEnd);
  else suggestRemoval(out, insertAt, targetEnd, view, attrs);
  const after = cut(targetNow.pos + targetNow.node.nodeSize, 1);
  const template = parts.last ?? targetNow.node;
  const blocks = [
    ...parts.middle.map((block) =>
      block.type.create({ ...block.attrs, id: null, sug: change }, block.content, block.marks),
    ),
    template.type.create(
      { ...template.attrs, id: null, sug: change },
      (parts.last?.content ?? Fragment.empty).append(rest),
    ),
  ];
  out.insert(after, blocks);
  const lastStart =
    after + blocks.slice(0, -1).reduce((size, block) => size + block.nodeSize, 0) + 1;
  return lastStart + (parts.last?.content.size ?? 0);
}

/** A slice as inline content for the cut's block, whole blocks after it, and the block it ends in. */
function sliceParts(slice: Slice): {
  head: Fragment;
  middle: Node[];
  last: Node | null;
  split: boolean;
} {
  const content = stripSuggestions(slice.content);
  if (content.childCount === 0 || content.child(0).isInline)
    return { head: content, middle: [], last: null, split: false };
  const children: Node[] = [];
  content.forEach((child) => {
    children.push(child);
  });
  if (children.length === 1 && slice.openStart > 0 && slice.openEnd > 0)
    return { head: children[0].content, middle: [], last: null, split: false };
  const head = slice.openStart > 0 ? (children.shift()?.content ?? Fragment.empty) : Fragment.empty;
  const last = slice.openEnd > 0 ? (children.pop() ?? null) : null;
  return { head, middle: children, last, split: true };
}
