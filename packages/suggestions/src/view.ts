import { type Attrs, Fragment, type Mark, type Node, Slice } from "prosemirror-model";

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
 * One turn's layer of a Work's pending change to a block's attributes (a heading level, a list),
 * kept in the block's `sugAttrs` by Work, oldest first, all under one change id. The block and
 * its text stay Live: accept sets the layers' attributes, reject drops layers, and nothing
 * anchored in the block moves. Rejecting a later turn leaves the earlier turn's layer, as a later
 * turn's deletion layered over an earlier insertion does for text.
 */
export type AttrProposal = SuggestionAttrs & { attrs: Attrs; remove?: boolean };

/** A block's pending attribute changes: by Work, its layers. */
export function proposals(node: Node): Record<string, AttrProposal[]> {
  return (node.attrs.sugAttrs ?? {}) as Record<string, AttrProposal[]>;
}

/** Whether a view removes a block: one of its own layers on it proposes so. */
export function removedIn(node: Node, view: View): boolean {
  if (view.work === null) return false;
  return (proposals(node)[view.work] ?? []).some((layer) => layer.remove);
}

/** What a Work's layers set, the later over the earlier. */
export function layered(layers: readonly AttrProposal[]): Attrs {
  return Object.assign({}, ...layers.map((layer) => layer.attrs));
}

/** Attribute values compared by content: what a block's attribute holds is plain data. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Attributes that say who suggested what: never themselves suggested, accepted or shown. */
export const SUGGESTION_ATTRS = ["sug", "sugAttrs"];

/** Whose suggestions a view shows: one Work's, or none (`work: null`, the Live view). */
export type View = { work: string | null };

export const liveView: View = { work: null };

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

function mine(attrs: SuggestionAttrs | null, view: View): boolean {
  return !!attrs?.work && attrs.work === view.work;
}

/**
 * A block: Live, the view's own suggested block, or another Work's (not shown). Every block
 * inside a suggested block carries its `sug` too (`suggested`), so a textblock at any depth knows
 * its owner without its ancestors.
 */
export function blockKind(block: Node, view: View): "live" | "own" | "hidden" {
  const sug = (block.attrs.sug ?? null) as SuggestionAttrs | null;
  if (!sug) return "live";
  return mine(sug, view) ? "own" : "hidden";
}

/**
 * Who owns the node at `pos` in a view: the nearest of it and its ancestors that carries `sug`,
 * else Live. A table's rows and cells carry no `sug`, so they belong to their table.
 */
export function ownerOf(
  doc: Node,
  pos: number,
  view: View,
): { kind: "live" | "own" | "hidden"; sug: SuggestionAttrs | null } {
  const $pos = doc.resolve(pos);
  const nodes = [$pos.nodeAfter];
  for (let depth = $pos.depth; depth >= 1; depth--) nodes.push($pos.node(depth));
  for (const node of nodes)
    if (node?.attrs.sug) return { kind: blockKind(node, view), sug: node.attrs.sug };
  return { kind: "live", sug: null };
}

/**
 * Inside a block the view's Work added, text is its insertion, and the Work's own deletion still
 * counts: a later turn that rewrites an earlier turn's paragraph strikes the earlier wording
 * instead of losing it, so rejecting the later turn brings it back, as in a Live paragraph.
 */
export function kindOf(marks: readonly Mark[], block: Node, view: View): RunKind {
  const owner = blockKind(block, view);
  if (owner === "hidden") return "hidden";
  let ownDel = false;
  let ownIns = owner === "own";
  for (const mark of marks) {
    const attrs = mark.attrs as SuggestionAttrs;
    if (mark.type.name === "suggest_ins") {
      // Another Work's insertion is absent.
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
  if (blockKind(block, view) === "hidden" || removedIn(block, view)) return null;
  return block.type.create(viewAttrs(block, view), viewContent(block, view), block.marks);
}

/** A whole document as a view means it: each top-level block through `viewBlock`. */
export function viewDoc(doc: Node, view: View): Node {
  const blocks: Node[] = [];
  doc.forEach((block) => {
    const shown = viewBlock(block, view);
    if (shown) blocks.push(shown);
  });
  return doc.copy(Fragment.from(blocks));
}

/** A block's attributes in a view: Live's, with the view's own pending change applied. */
export function viewAttrs(node: Node, view: View): Attrs {
  if (!("sug" in node.attrs)) return node.attrs;
  const own = view.work !== null ? proposals(node)[view.work] : null;
  return { ...node.attrs, ...layered(own ?? []), sug: null, sugAttrs: null };
}

function carries(node: Node): boolean {
  return !!node.attrs.sug || !!node.attrs.sugAttrs || node.marks.some(isSuggestionMark);
}

function carriesSuggestion(block: Node): boolean {
  if (carries(block)) return true;
  let found = false;
  block.descendants((node) => {
    if (carries(node)) found = true;
    return !found;
  });
  return found;
}

/** A node's content in a view. */
function viewContent(node: Node, view: View): Fragment {
  const children: Node[] = [];
  node.forEach((child) => {
    if (child.isInline) {
      const kind = kindOf(child.marks, node, view);
      if (visible(kind)) children.push(child.mark(child.marks.filter((m) => !isSuggestionMark(m))));
    } else if (child.isLeaf) children.push(child);
    else if (blockKind(child, view) !== "hidden" && !removedIn(child, view))
      children.push(
        child.type.create(viewAttrs(child, view), viewContent(child, view), child.marks),
      );
  });
  return Fragment.from(children);
}

/** Pasted or copied content loses every suggestion: what it is now is decided where it lands. */
export function stripSuggestions(fragment: Fragment): Fragment {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      nodes.push(node.mark(node.marks.filter((mark) => !isSuggestionMark(mark))));
      return;
    }
    nodes.push(
      node.type.create(owned(node.attrs, null), stripSuggestions(node.content), node.marks),
    );
  });
  return Fragment.from(nodes);
}

/**
 * `node` as one Work's suggested block (`sug`), or as no one's (null): it and every block in it
 * carry `sug`, and none carries a pending attribute change, since the Work edits its own block
 * directly. A node that cannot carry `sug` (a table row) is left as it is.
 */
export function suggested(node: Node, sug: SuggestionAttrs | null): Node {
  if (node.isText) return node;
  const content: Node[] = [];
  node.forEach((child) => {
    content.push(suggested(child, sug));
  });
  return node.type.create(owned(node.attrs, sug), Fragment.from(content), node.marks);
}

function owned(attrs: Attrs, sug: SuggestionAttrs | null): Attrs {
  return "sug" in attrs ? { ...attrs, sug, sugAttrs: null } : attrs;
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
  const keep = (fragment: Fragment, parent: Node): Fragment => {
    const nodes: Node[] = [];
    fragment.forEach((node) => {
      if (node.isInline) {
        if (visible(kindOf(node.marks, parent, view))) nodes.push(node);
      } else if (blockKind(node, view) !== "hidden") {
        nodes.push(node.copy(keep(node.content, node)));
      }
    });
    return Fragment.from(nodes);
  };
  return stripSlice(new Slice(keep(slice.content, parent), slice.openStart, slice.openEnd));
}
