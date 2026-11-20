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
export function blockKind(block: Node, view: View): "live" | "own" | "hidden" {
  const sug = (block.attrs.sug ?? null) as SuggestionAttrs | null;
  if (!sug) return "live";
  return mine(sug, view) ? "own" : "hidden";
}

export function kindOf(marks: readonly Mark[], block: Node, view: View): RunKind {
  const owner = blockKind(block, view);
  if (owner === "hidden") return "hidden";
  if (owner === "own") return "own-ins";
  let ownDel = false;
  let ownIns = false;
  for (const mark of marks) {
    const attrs = mark.attrs as SuggestionAttrs;
    if (mark.type.name === "suggest_ins") {
      // Another Work's insertion, or a discarded Work's, is absent.
      if (!mine(attrs, view)) return "hidden";
      ownIns = true;
    }
    if (mark.type.name === "suggest_del" && mine(attrs, view)) ownDel = true;
  }
  // An own insertion a later turn removes reads as a deletion: shown struck, absent once applied.
  return ownDel ? "own-del" : ownIns ? "own-ins" : "live";
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
 * One top-level block as a view means it, or null when the view does not contain it: Live with
 * the view's own suggestions accepted, and no other Work's. Every reader goes through it (the
 * model's port projects with it); one that reads the stored block shows pending text as real.
 */
export function viewBlock(block: Node, view: View): Node | null {
  if (!carriesSuggestion(block)) return block;
  if (blockKind(block, view) === "hidden") return null;
  const content = viewContent(block, view);
  // A block whose whole text the view proposes to remove is removed.
  if (content === null) return null;
  const attrs = block.attrs.sug ? { ...block.attrs, sug: null } : block.attrs;
  return block.type.create(attrs, content, block.marks);
}

function carriesSuggestion(block: Node): boolean {
  if (block.attrs.sug) return true;
  let found = false;
  block.descendants((node) => {
    if (found) return false;
    if (node.marks.some(isSuggestionMark)) found = true;
    return !found;
  });
  return found;
}

/** A node's content in a view; null for a textblock whose whole text the view removes. */
function viewContent(node: Node, view: View): Fragment | null {
  const children: Node[] = [];
  if (!node.isTextblock) {
    node.forEach((child) => {
      children.push(
        child.isLeaf
          ? child
          : child.type.create(child.attrs, viewContent(child, view) ?? Fragment.empty, child.marks),
      );
    });
    return Fragment.from(children);
  }
  let removed = false;
  node.forEach((child) => {
    const kind = kindOf(child.marks, node, view);
    if (kind === "own-del") removed = true;
    if (visible(kind)) children.push(child.mark(child.marks.filter((m) => !isSuggestionMark(m))));
  });
  return removed && children.length === 0 ? null : Fragment.from(children);
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

/** A copy carries what the view shows, and no suggestion. `parent` holds the slice's open text. */
export function visibleSlice(slice: Slice, parent: Node, view: View): Slice {
  const keep = (fragment: Fragment, block: Node): Fragment => {
    const nodes: Node[] = [];
    fragment.forEach((node) => {
      if (node.isInline) {
        if (visible(kindOf(node.marks, block, view))) nodes.push(node);
      } else if (blockKind(node, view) !== "hidden") {
        nodes.push(node.copy(node.isTextblock ? keep(node.content, node) : node.content));
      }
    });
    return Fragment.from(nodes);
  };
  return stripSlice(new Slice(keep(slice.content, parent), slice.openStart, slice.openEnd));
}

/** The document's root that lists, by Work, the drafts discarded in it. */
const HIDDEN_ROOT = "suggest_hidden";

type HiddenMap = {
  keys(): IterableIterator<string>;
  set(work: string, at: number): unknown;
  delete(work: string): void;
  observe(listener: () => void): void;
  unobserve(listener: () => void): void;
};

/** Works whose suggestions in this document are discarded: absent from every view. */
export function hiddenWorks(doc: { getMap(name: string): HiddenMap }): Set<string> {
  return new Set(doc.getMap(HIDDEN_ROOT).keys());
}

/** Discard a Work's draft in this document: its suggestions stay stored, in no view. */
export function discard(doc: { getMap(name: string): HiddenMap }, work: string): void {
  doc.getMap(HIDDEN_ROOT).set(work, Date.now());
}

export function restore(doc: { getMap(name: string): HiddenMap }, work: string): void {
  doc.getMap(HIDDEN_ROOT).delete(work);
}

/** Calls `onChange` with the discarded Works whenever they change; returns the unsubscribe. */
export function observeHidden(
  doc: { getMap(name: string): HiddenMap },
  onChange: (hidden: Set<string>) => void,
): () => void {
  const map = doc.getMap(HIDDEN_ROOT);
  const listener = () => onChange(hiddenWorks(doc));
  map.observe(listener);
  return () => map.unobserve(listener);
}
