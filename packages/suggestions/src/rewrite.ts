import { ChangeSet, type TokenEncoder } from "prosemirror-changeset";
import { type Attrs, Fragment, type Mark, type Node, type Schema, Slice } from "prosemirror-model";
import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import {
  AddMarkStep,
  Mapping,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
  StepMap,
  Transform,
} from "prosemirror-transform";
import {
  type AttrProposal,
  blockKind,
  isSuggestionMark,
  kindOf,
  layered,
  ownerOf,
  proposals,
  type RunKind,
  SUGGESTION_ATTRS,
  type SuggestionAttrs,
  stripSlice,
  stripSuggestions,
  suggested,
  type View,
  viewAttrs,
  visibleContent,
} from "./view.js";

/** A transaction already in stored form (accept, reject, a peer's or Undo's): never rewritten. */
export const RAW_META = "suggestions:raw";

/** On a rewritten transaction (`ChangeAt[]`): per range it replaced, the change a Work's edit took. */
export const CHANGE_META = "suggestions:change";

/** On a rewritten transaction: part of the original could not be suggested and was left out. */
export const DROPPED_META = "suggestions:dropped";

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
  const changes: ChangeAt[] = [];
  let caret: { pos: number; map: At } | null = null;
  const head = tr.selection.head;
  // Text and blocks: what the transaction replaced, as ranges of the start document, applied
  // right to left so each range is still where it was read. Content one step makes and a later
  // step edits (type then split) is one range, so it needs no position mapping.
  // A step that only formats keeps every position, so to the change set it is no change.
  const replaced = ChangeSet.create(state.doc, undefined, wholeText).addSteps(
    tr.doc,
    tr.steps.map((step, index) => (changesContent(step) ? tr.mapping.maps[index] : StepMap.empty)),
    null,
  ).changes;
  for (const range of [...replaced].reverse()) {
    const slice = stripSlice(tr.doc.slice(range.fromB, range.toB));
    const a = shownEdge(out.doc, range.fromA, view, -1);
    const b = Math.max(a, shownEdge(out.doc, range.toA, view, 1));
    const forward = state.selection.empty && state.selection.head === a && slice.size === 0;
    let change: SuggestionAttrs | null = null;
    const changed = (c: SuggestionAttrs) => {
      change = c;
    };
    const work = view.work === null || !author ? null : { ...author, work: view.work };
    const at = !work
      ? replaceLive(out, a, b, slice, view, forward)
      : textblockAt(out.doc, a) && textblockAt(out.doc, b)
        ? replaceInWork(out, a, b, slice, view, work, forward, changed)
        : replaceBlocks(out, a, b, slice, view, work, changed);
    changes.push({ from: range.fromA, to: range.toA, change });
    if (at !== null && head >= range.fromB && head <= range.toB)
      caret = { pos: at, map: since(out) };
  }
  // Formatting and block attributes reach what the transaction left in place, read in the start
  // document: what it replaced or made already has its final form, from the final document.
  tr.steps.forEach((step, index) => {
    if (changesContent(step)) return;
    const back = new Mapping(
      tr.mapping.maps
        .slice(0, index)
        .map((map) => map.invert())
        .reverse(),
    );
    const start = step.map(back);
    if (!start) return;
    for (const part of leftInPlace(start, replaced))
      rewriteFormat(out, part, out.mapping.slice(), view, author);
  });
  out.setMeta(CHANGE_META, changes);
  if (caret !== null)
    out.setSelection(
      TextSelection.near(out.doc.resolve(Math.min(caret.map(caret.pos), out.doc.content.size))),
    );
  if (tr.scrolledIntoView) out.scrollIntoView();
  return out;
}

/** On a rewritten transaction (`CHANGE_META`): per range of the start document it replaced, the change a Work's edit there took. */
export type ChangeAt = { from: number; to: number; change: SuggestionAttrs | null };

/**
 * Tokens for the change set: no two characters or inline nodes compare equal, so a replacement
 * stays one range (one change to review) instead of being cut down to the characters that
 * differ; a block's own tokens compare by type, so an attribute change is no content change.
 */
const wholeText: TokenEncoder<unknown> = {
  encodeCharacter: () => ({}),
  encodeNodeStart: (node) => (node.isInline ? {} : node.type.name),
  encodeNodeEnd: (node) => (node.isInline ? {} : `/${node.type.name}`),
  compareTokens: (a, b) => a === b,
};

/** A mark step cut around the ranges a transaction replaced; any other step as it is. */
function leftInPlace(step: Step, replaced: readonly { fromA: number; toA: number }[]): Step[] {
  if (!(step instanceof AddMarkStep || step instanceof RemoveMarkStep)) return [step];
  const parts: Step[] = [];
  let from = step.from;
  for (const range of replaced) {
    if (range.toA < from || range.fromA > step.to) continue;
    if (range.fromA > from) parts.push(cut(step, from, range.fromA));
    from = Math.max(from, range.toA);
  }
  if (from < step.to) parts.push(cut(step, from, step.to));
  return parts;
}

function cut(step: AddMarkStep | RemoveMarkStep, from: number, to: number): Step {
  return step instanceof AddMarkStep
    ? new AddMarkStep(from, to, step.mark)
    : new RemoveMarkStep(from, to, step.mark);
}

/** A step that replaces content, as opposed to one that changes marks or a block's attributes. */
function changesContent(step: Step): boolean {
  if (step instanceof ReplaceStep) return true;
  let resized = false;
  step.getMap().forEach((fromA, toA, fromB, toB) => {
    if (toA - fromA !== toB - fromB) resized = true;
  });
  return resized;
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
    const block = textblockAt(doc, pos);
    return !!block && blockKind(block.node, view) === "hidden";
  };
  return (
    hiddenAt(from) ||
    hiddenAt(to) ||
    pieces(doc, from, to, view).some((piece) => piece.kind === "hidden") ||
    wholeBlocks(doc, from, to).some(({ node }) => blockKind(node, view) === "hidden")
  );
}

function rewriteFormat(
  out: Transaction,
  step: Step,
  map: Mapping,
  view: View,
  author: Author | null,
): void {
  const at: At = (pos, assoc = 1) => map.map(pos, assoc);
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const { from, to, mark } = step as unknown as { from: number; to: number; mark: Mark };
    const add = step instanceof AddMarkStep;
    const format = (node: Node) =>
      node.mark(add ? mark.addToSet(node.marks) : mark.removeFromSet(node.marks));
    // A mark reaches only what the view shows. A comment anchors on any of it. In a Work's view,
    // formatting Live text is suggested as that text struck and inserted again, formatted.
    for (const piece of pieces(out.doc, at(from, 1), at(to, -1), view).reverse()) {
      if (piece.kind === "hidden" || (piece.kind === "own-del" && mark.type.name !== "comment"))
        continue;
      if (view.work !== null && author && piece.kind === "live" && mark.type.name !== "comment") {
        const start = piece.blockPos + 1;
        const copy = piece.block.slice(piece.from - start, piece.to - start).content;
        const formatted: Node[] = [];
        copy.forEach((node) => {
          formatted.push(format(node));
        });
        replaceInWork(
          out,
          piece.from,
          piece.to,
          new Slice(Fragment.from(formatted), 0, 0),
          view,
          { ...author, work: view.work },
          false,
          () => {},
        );
      } else if (add) out.addMark(piece.from, piece.to, mark);
      else out.removeMark(piece.from, piece.to, mark);
    }
    return;
  }
  // Attribute and structure steps. Live takes them; a Work's view takes them on its own blocks.
  const mapped = step.map(map);
  if (!mapped) return;
  const range = stepRange(mapped);
  if (view.work === null || !author || !range) {
    if (view.work === null) out.maybeStep(mapped);
    return;
  }
  // Read against what the Work sees: each Live block with its pending change applied, so an edit
  // that sets a block back to how Live has it withdraws the change.
  const shown = withPending(out.doc, range.from, range.to, view);
  const after = mapped.apply(shown).doc;
  const changes = after && attrChanges(shown, after, range.from, range.to);
  if (!changes) {
    if (after && ownStructure(out.doc, range.from, range.to, view)) out.maybeStep(mapped);
    else out.setMeta(DROPPED_META, true);
    return;
  }
  // An attribute change to a Live block is the Work's pending change to it: the block stays Live.
  for (const { pos, node, attrs } of changes) {
    const owner = ownerOf(out.doc, pos, view).kind;
    if (owner === "own") out.setNodeMarkup(pos, undefined, attrs);
    if (owner !== "live" || !("sug" in node.attrs)) {
      if (owner !== "own") out.setMeta(DROPPED_META, true);
      continue;
    }
    proposeAttrs(out, pos, node.attrs, attrs, { ...author, work: view.work });
  }
}

/**
 * The Work's pending change to the Live block at `pos`, from attributes `shown` (as the Work sees
 * them) to `attrs`. Who suggests and a block's identity are never themselves proposed.
 */
function proposeAttrs(
  out: Transaction,
  pos: number,
  shown: Attrs,
  attrs: Attrs,
  author: Omit<SuggestionAttrs, "id">,
): void {
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(attrs))
    if (!SUGGESTION_ATTRS.includes(key) && key !== "id" && !same(attrs[key], shown[key]))
      set[key] = attrs[key];
  if (Object.keys(set).length === 0) return;
  const stored = out.doc.nodeAt(pos) as Node;
  const layers = proposals(stored)[author.work] ?? [];
  const id = layers[0]?.id ?? newChangeId();
  setLayers(out, pos, author.work, addLayer(stored, layers, { ...author, id, attrs: set }));
}

/** Store a Work's layers on the block at `pos`; none drops its entry. */
function setLayers(out: Transaction, pos: number, work: string, layers: AttrProposal[]): void {
  const entries = { ...proposals(out.doc.nodeAt(pos) as Node) };
  if (layers.length > 0) entries[work] = layers;
  else delete entries[work];
  out.setNodeAttribute(pos, "sugAttrs", Object.keys(entries).length > 0 ? entries : null);
}

/** `doc` with the view's pending attribute changes applied to the blocks in `[from, to)`. */
function withPending(doc: Node, from: number, to: number, view: View): Node {
  const work = view.work;
  if (work === null || view.hidden.has(work)) return doc;
  const shown = new Transform(doc);
  doc.nodesBetween(from, Math.max(to, from + 1), (node, pos) => {
    for (const [key, value] of Object.entries(layered(proposals(node)[work] ?? [])))
      shown.setNodeAttribute(pos, key, value);
  });
  return shown.doc;
}

/**
 * A Work's layers on a Live block once an edit adds `layer`: one change's layer per turn, so the
 * edit extends its turn's layer of the same change, or adds one. A lone layer that leaves the
 * block as Live has it is no change.
 */
function addLayer(
  node: Node,
  layers: readonly AttrProposal[],
  layer: AttrProposal,
): AttrProposal[] {
  const next = [...layers];
  const last = next.at(-1);
  if (last && last.id === layer.id && sameAuthor(last, layer))
    next[next.length - 1] = {
      ...last,
      attrs: { ...last.attrs, ...layer.attrs },
      remove: last.remove || layer.remove,
    };
  else next.push(layer);
  const attrs = layered(next);
  const changes =
    next.some((each) => each.remove) ||
    Object.keys(attrs).some((key) => !same(attrs[key], node.attrs[key]));
  return changes || next.length > 1 ? next : [];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The nodes in `[from, to)` whose attributes alone differ in `after`; null when more differs. */
function attrChanges(
  before: Node,
  after: Node,
  from: number,
  to: number,
): Array<{ pos: number; node: Node; attrs: Attrs }> | null {
  if (before.content.size !== after.content.size) return null;
  const changes: Array<{ pos: number; node: Node; attrs: Attrs }> = [];
  let more = false;
  before.nodesBetween(from, Math.max(to, from + 1), (node, pos) => {
    if (more) return false;
    const now = after.nodeAt(pos);
    if (!now || now.type !== node.type || now.nodeSize !== node.nodeSize) more = true;
    else if (now.isTextblock && !now.content.eq(node.content)) more = true;
    else if (!same(now.attrs, node.attrs)) changes.push({ pos, node, attrs: now.attrs });
    return !more && !node.isTextblock;
  });
  return more ? null : changes;
}

/** Whether a structure change in `[from, to)` lies inside the view's own blocks. */
function ownStructure(doc: Node, from: number, to: number, view: View): boolean {
  let own = true;
  doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (!own || !("sug" in node.attrs)) return own;
    if (blockKind(node, view) !== "own") own = false;
    return false;
  });
  return own;
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

/** The outermost blocks wholly inside `[from, to)`, at any depth. */
function wholeBlocks(doc: Node, from: number, to: number): { node: Node; pos: number }[] {
  const out: { node: Node; pos: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline) return false;
    if (pos < from || pos + node.nodeSize > to) return !node.isTextblock;
    out.push({ node, pos });
    return false;
  });
  return out;
}

/** `pos`, or when it lies in a hidden block, the near edge of the closest shown textblock that way. */
function shownEdge(doc: Node, pos: number, view: View, direction: -1 | 1): number {
  const block = textblockAt(doc, pos);
  if (!block || blockKind(block.node, view) !== "hidden") return pos;
  let edge = direction < 0 ? 0 : doc.content.size;
  doc.descendants((node, at) => {
    if (!node.isTextblock) return true;
    if (blockKind(node, view) === "hidden") return false;
    if (direction < 0 && at < block.pos) edge = at + node.nodeSize - 1;
    if (direction > 0 && at > block.pos && edge === doc.content.size) edge = at + 1;
    return false;
  });
  return edge;
}

/** The textblock a position lies in, at any depth; null between blocks. */
function textblockAt(doc: Node, pos: number): { node: Node; pos: number } | null {
  const $pos = doc.resolve(pos);
  return $pos.parent.isTextblock ? { node: $pos.parent, pos: $pos.before() } : null;
}

function textblockAtOrThrow(doc: Node, pos: number): { node: Node; pos: number } {
  const block = textblockAt(doc, pos);
  if (!block) throw new Error(`Position ${pos} is not inside a textblock`);
  return block;
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
  const startBlock = textblockAt(doc, from);
  const endBlock = textblockAt(doc, to);
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
  for (const { node, pos } of wholeBlocks(out.doc, from, to))
    if (blockKind(node, view) === "live" && "sug" in node.attrs)
      setLayers(
        out,
        pos,
        attrs.work,
        addLayer(node, proposals(node)[attrs.work] ?? [], { ...attrs, attrs: {}, remove: true }),
      );
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
  const startBlock = textblockAtOrThrow(out.doc, from);
  const endBlock = textblockAtOrThrow(out.doc, to);
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
  // Live text never moves in a Work's view. A Live end block the view keeps nothing of before the
  // cut stays instead, as the edit's second half: after a block the Work added (a copy would be
  // that block's insertion, gone with it), or when the cut is at its shown start.
  const keepEnd =
    !endOwn &&
    (joining
      ? startOwn
      : visibleContent(startBlock.node, 0, from - startBlock.pos - 1, view).size === 0);
  const tail =
    joining && !keepEnd
      ? visibleContent(endBlock.node, to - endBlock.pos - 1, endBlock.node.content.size, view)
      : Fragment.empty;
  const map = since(out);
  // A joined end block goes whole, its shown text carried on as the tail.
  suggestRemoval(
    out,
    from,
    joining && !keepEnd ? endBlock.pos + endBlock.node.nodeSize : to,
    view,
    attrs,
  );
  const blockEnd = map(startBlock.pos + startBlock.node.nodeSize - 1, -1);
  let insertAt = joining ? blockEnd : pastOwnDeletion(out.doc, map(to, 1), view);
  const target = textblockAtOrThrow(out.doc, insertAt);
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
  // A split: the target keeps its text up to the cut; the rest is suggested as new blocks. A kept
  // block the edit also starts in gets its first line as a block of its own, before it.
  const headFirst = keepEnd && !joining;
  if (parts.head.size > 0 && !headFirst) {
    out.insert(insertAt, inline(parts.head));
    insertAt += parts.head.size;
  }
  const targetNow = textblockAtOrThrow(out.doc, insertAt);
  if (keepEnd) {
    // The Live block kept after the cut is the split's second half: the edit's whole blocks go
    // right before it and its last line opens it, all the edit's change.
    const endAt = map(endBlock.pos, 1);
    const opensAt = pastOwnDeletion(out.doc, map(to, 1), view);
    const blocks = pasted(
      headFirst && parts.first ? [parts.first, ...parts.middle] : parts.middle,
      attrs,
    );
    const opening = parts.last?.content ?? Fragment.empty;
    if (opening.size > 0) out.insert(opensAt, marked(schema, opening, attrs));
    // The block takes the attributes the edit leaves it with, as the Work's pending change.
    if (parts.last)
      proposeAttrs(out, endAt, viewAttrs(endBlock.node, view), parts.last.attrs, author);
    if (blocks.length > 0) out.insert(endAt, blocks);
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
    ...pasted(parts.middle, attrs),
    template.type.create(
      { ...template.attrs, id: null, sug: change, sugAttrs: null },
      (parts.last?.content ?? Fragment.empty).append(rest),
    ),
  ];
  out.insert(after, blocks);
  const lastStart =
    after + blocks.slice(0, -1).reduce((size, block) => size + block.nodeSize, 0) + 1;
  return lastStart + (parts.last?.content.size ?? 0);
}

/**
 * A Work's edit between blocks (a gap cursor, a whole-block paste, a table row): inside a block
 * the Work added it is that block's content; elsewhere what it removes is struck and the blocks
 * it brings are its own. A table's rows and columns outside the Work's own table cannot be
 * suggested, and are left out.
 */
function replaceBlocks(
  out: Transaction,
  from: number,
  to: number,
  slice: Slice,
  view: View,
  author: Omit<SuggestionAttrs, "id">,
  changed: (change: SuggestionAttrs) => void,
): null {
  // Whoever owns the node holding both ends owns the edit: inside the Work's own block it is that
  // block's content, as typed.
  const $from = out.doc.resolve(from);
  const depth = $from.sharedDepth(to);
  const owner = depth > 0 ? ownerOf(out.doc, $from.before(depth), view) : null;
  if (owner?.kind === "own" && owner.sug) {
    out.replace(
      from,
      to,
      new Slice(suggestedAll(slice.content, owner.sug), slice.openStart, slice.openEnd),
    );
    return null;
  }
  // Elsewhere only whole blocks that can carry a suggestion come and go: not a table's rows.
  const blocks: Node[] = [];
  slice.content.forEach((block) => {
    blocks.push(block);
  });
  const suggestible = (node: Node) => !node.isInline && "sug" in node.attrs;
  if (
    owner?.kind === "hidden" ||
    slice.openStart > 0 ||
    slice.openEnd > 0 ||
    !blocks.every(suggestible) ||
    !wholeBlocks(out.doc, from, to).every(({ node }) => suggestible(node))
  ) {
    out.setMeta(DROPPED_META, true);
    return null;
  }
  const attrs = { ...author, id: newChangeId() };
  changed(attrs);
  const map = since(out);
  if (from < to) suggestRemoval(out, from, to, view, attrs);
  if (blocks.length > 0) out.insert(map(from, -1), pasted(blocks, attrs));
  return null;
}

function suggestedAll(content: Fragment, sug: SuggestionAttrs): Fragment {
  const nodes: Node[] = [];
  content.forEach((node) => {
    nodes.push(suggested(node, sug));
  });
  return Fragment.from(nodes);
}

/** Whole blocks an edit brings: that edit's change, wherever they land. */
function pasted(blocks: readonly Node[], attrs: SuggestionAttrs): Node[] {
  return blocks.map((block) =>
    suggested(block.type.create({ ...block.attrs, id: null }, block.content, block.marks), attrs),
  );
}

/** A slice as the block it starts in (`head`, its inline content), whole blocks after it, and the block it ends in. */
function sliceParts(slice: Slice): {
  head: Fragment;
  first: Node | null;
  middle: Node[];
  last: Node | null;
  split: boolean;
} {
  const content = stripSuggestions(slice.content);
  if (content.childCount === 0 || content.child(0).isInline)
    return { head: content, first: null, middle: [], last: null, split: false };
  const children: Node[] = [];
  content.forEach((child) => {
    children.push(child);
  });
  if (children.length === 1 && slice.openStart > 0 && slice.openEnd > 0)
    return { head: children[0].content, first: null, middle: [], last: null, split: false };
  const first = slice.openStart > 0 ? (children.shift() ?? null) : null;
  const last = slice.openEnd > 0 ? (children.pop() ?? null) : null;
  return { head: first?.content ?? Fragment.empty, first, middle: children, last, split: true };
}
