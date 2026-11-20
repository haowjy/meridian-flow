import { Fragment, type Mark, type Node, Slice } from "prosemirror-model";

/** Who suggested a stretch: carried by `suggest_ins`, `suggest_del` and a block's `sug`. */
export type SuggestionAttrs = {
  /** One change: an insertion and the deletion it replaces share it. */
  id: string;
  /** The Work whose draft this is. */
  work: string;
  chat: string | null;
  turn: string | null;
  /** `user:<id>` or `agent`. */
  by: string;
};

/**
 * Whose suggestions a view shows: one Work's, or none (`work: null`, the Live view). A Work in
 * `hidden` (its draft is discarded) is absent from every view, its own included.
 */
export type View = { work: string | null; hidden: ReadonlySet<string> };

export const liveView: View = { work: null, hidden: new Set() };

/**
 * The one decision table every writer uses. `live`: Live text the view shows and may suggest
 * removing. `own-ins`: the view's own insertion. `own-del`: Live text the view proposes to
 * remove. `hidden`: another Work's insertion, which the view neither shows nor touches.
 */
export type RunKind = "live" | "own-ins" | "own-del" | "hidden";

/** A stretch of one textblock's inline content, in offsets inside the block. */
export type Run = { from: number; to: number; kind: RunKind };

/** What the table reads of a mark and a block: a ProseMirror one, or one read from Yjs. */
export type MarkLike = { type: { name: string }; attrs: Record<string, unknown> };
export type BlockLike = { attrs: Record<string, unknown> };

export function isSuggestionMark(mark: Mark): boolean {
  return mark.type.name === "suggest_ins" || mark.type.name === "suggest_del";
}

function present(attrs: SuggestionAttrs | null, view: View): attrs is SuggestionAttrs {
  return !!attrs?.work && !view.hidden.has(attrs.work);
}

function mine(attrs: SuggestionAttrs | null, view: View): boolean {
  return present(attrs, view) && attrs.work === view.work;
}

/** A top-level block: Live, the view's own suggested block, or another Work's (not shown). */
export function blockKind(block: BlockLike, view: View): "live" | "own" | "hidden" {
  const sug = (block.attrs.sug ?? null) as SuggestionAttrs | null;
  if (!sug) return "live";
  return mine(sug, view) ? "own" : "hidden";
}

export function kindOf(marks: readonly MarkLike[], block: BlockLike, view: View): RunKind {
  const owner = blockKind(block, view);
  if (owner === "hidden") return "hidden";
  if (owner === "own") return "own-ins";
  let ownDel = false;
  for (const mark of marks) {
    const attrs = mark.attrs as SuggestionAttrs;
    if (mark.type.name === "suggest_ins") {
      // A discarded Work's insertion is absent everywhere.
      if (!present(attrs, view)) return "hidden";
      return attrs.work === view.work ? "own-ins" : "hidden";
    }
    if (mark.type.name === "suggest_del" && mine(attrs, view)) ownDel = true;
  }
  return ownDel ? "own-del" : "live";
}

export function runs(block: Node, view: View): Run[] {
  const out: Run[] = [];
  block.forEach((child, offset) => {
    const kind = kindOf(child.marks, block, view);
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === offset) last.to = offset + child.nodeSize;
    else out.push({ from: offset, to: offset + child.nodeSize, kind });
  });
  return out;
}

/** Shown in the view, as it would read if its suggestions were accepted. */
export function visible(kind: RunKind): boolean {
  return kind === "live" || kind === "own-ins";
}

/**
 * The document a view means: Live with the view's own suggestions accepted, and no other
 * Work's. Every reader goes through it (the Markdown copy, search, counts, the model's read);
 * one that reads the stored document shows pending text as real.
 */
export function viewOf(doc: Node, view: View): Node {
  const blocks: Node[] = [];
  doc.forEach((block) => {
    const kept = viewBlock(block, view);
    if (kept) blocks.push(kept);
  });
  if (blocks.length === 0) {
    const empty = doc.type.contentMatch.defaultType?.createAndFill();
    if (empty) blocks.push(empty);
  }
  return doc.type.create(doc.attrs, blocks);
}

/** One top-level block in a view, or null when the view does not contain it. */
export function viewBlock(block: Node, view: View): Node | null {
  if (blockKind(block, view) === "hidden") return null;
  const attrs = block.attrs.sug ? { ...block.attrs, sug: null } : block.attrs;
  if (!block.isTextblock) return block.type.create(attrs, block.content, block.marks);
  const children: Node[] = [];
  let removed = false;
  block.forEach((child) => {
    const kind = kindOf(child.marks, block, view);
    if (kind === "own-del") removed = true;
    if (visible(kind)) children.push(child.mark(child.marks.filter((m) => !isSuggestionMark(m))));
  });
  // A block whose whole text the view proposes to remove is removed.
  if (removed && children.length === 0) return null;
  return block.type.create(attrs, children, block.marks);
}

/** Pasted or copied content loses every suggestion: what it is now is decided where it lands. */
export function stripSuggestions(fragment: Fragment): Fragment {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      nodes.push(node.mark(node.marks.filter((mark) => !isSuggestionMark(mark))));
      return;
    }
    const attrs = node.attrs.sug ? { ...node.attrs, sug: null } : node.attrs;
    nodes.push(node.type.create(attrs, stripSuggestions(node.content), node.marks));
  });
  return Fragment.from(nodes);
}

/** Content a view shows, out of a slice of a block: what a copy or a moved tail carries. */
export function visibleContent(block: Node, from: number, to: number, view: View): Fragment {
  const nodes: Node[] = [];
  block.forEach((child, offset) => {
    const end = offset + child.nodeSize;
    if (end <= from || offset >= to) return;
    if (!visible(kindOf(child.marks, block, view))) return;
    const piece = child.isText
      ? child.cut(Math.max(0, from - offset), Math.min(child.nodeSize, to - offset))
      : child;
    nodes.push(piece.mark(piece.marks.filter((mark) => !isSuggestionMark(mark))));
  });
  return Fragment.from(nodes);
}

/** A slice with every suggestion removed. */
export function stripSlice(slice: Slice): Slice {
  return new Slice(stripSuggestions(slice.content), slice.openStart, slice.openEnd);
}

/** The document's root that lists, by Work, the drafts discarded in it. */
export const HIDDEN_ROOT = "suggest_hidden";

/** Works whose suggestions in this document are discarded: absent from every view. */
export function hiddenWorks(doc: {
  getMap(name: string): { keys(): IterableIterator<string> };
}): Set<string> {
  return new Set(doc.getMap(HIDDEN_ROOT).keys());
}
