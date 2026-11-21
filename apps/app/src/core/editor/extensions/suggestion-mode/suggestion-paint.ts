import {
  blockKind,
  kindOf,
  proposals,
  removedIn,
  sameValue,
  type View,
  viewAttrs,
} from "@meridian/suggestions";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createBarSlotElement } from "./bar-slot";

/** The change a review's mark at a DOM element belongs to: its bar and focus find it by this. */
export const SUGGESTION_CHANGE_ATTR = "data-review-change";

/**
 * What the paint depends on besides the document: the view, the change in focus, and whether the
 * focused change's bar opens in a slot after its block because the margin has no room for it.
 * Whether changes are marked at all is the editor's `data-suggestion-marks`, which
 * suggestion-mode.css reads, so turning marks off and on redraws nothing.
 */
export type Paint = { view: View; focus: string | null; slot: boolean };

/** Each decoration's spec: the change it draws, so a focus move repaints only that change's blocks. */
type Spec = { change?: string; key?: string };

const SLOT_KEY = "bar-slot";

/** The whole document's decorations. */
export function paintAll(doc: PMNode, paint: Paint): DecorationSet {
  const decorations: Decoration[] = [];
  doc.forEach((block, offset) => {
    paintNode(block, offset, paint, decorations);
  });
  return withSlot(DecorationSet.create(doc, decorations), doc, paint);
}

/**
 * `set`, painted with `was` for `before`, painted again with `paint` for `doc`: only the
 * top-level blocks the edit reached and those holding the old or new focused change. The bar's
 * slot is placed again after every repaint, since an edit or a focus move can shift where the
 * focused change ends.
 */
export function repaint(
  set: DecorationSet,
  before: PMNode,
  doc: PMNode,
  was: Paint,
  paint: Paint,
): DecorationSet {
  let next = before === doc ? set : repaintEdit(set, before, doc, paint);
  if (was.focus !== paint.focus) next = repaintFocus(next, doc, was.focus, paint);
  return withSlot(next, doc, paint);
}

/**
 * The decorations map through the edit, and only the top-level blocks whose content differs are
 * painted again. A block is the unit because a block's decorations depend on its ancestors (a
 * block the Work added, a removed list). The difference is read from the documents, not the
 * transaction's steps, so the binding's redraw of the whole document (Undo, a peer's edit, the
 * tab's Apply) repaints only what it changed.
 */
function repaintEdit(set: DecorationSet, before: PMNode, doc: PMNode, paint: Paint): DecorationSet {
  const start = before.content.findDiffStart(doc.content);
  if (start === null) return set;
  const end = before.content.findDiffEnd(doc.content) ?? {
    a: before.content.size,
    b: doc.content.size,
  };
  // A diff can end before it starts when the edit repeats the text beside it.
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  const oldEnd = end.a + overlap;
  const newEnd = end.b + overlap;
  const mapped = set.map(new Mapping([new StepMap([start, oldEnd - start, newEnd - start])]), doc);
  return repaintRange(mapped, doc, start, newEnd, paint);
}

/** The blocks holding `before`'s focused change and `paint`'s, painted again. */
function repaintFocus(
  set: DecorationSet,
  doc: PMNode,
  before: string | null,
  paint: Paint,
): DecorationSet {
  const blocks = new Set<number>();
  for (const change of [before, paint.focus]) {
    if (!change) continue;
    for (const decoration of changeDecorations(set, change)) {
      const $from = doc.resolve(decoration.from);
      blocks.add($from.depth > 0 ? $from.before(1) : decoration.from);
    }
  }
  let next = set;
  for (const pos of blocks) next = repaintRange(next, doc, pos + 1, pos + 1, paint);
  return next;
}

/** Paints again every top-level block that `from`..`to` reaches. */
function repaintRange(
  set: DecorationSet,
  doc: PMNode,
  from: number,
  to: number,
  paint: Paint,
): DecorationSet {
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  // One position wider, so an edit at a block's edge (a join, a split) reaches both blocks.
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
    blocks.push({ node, pos });
    return false;
  });
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) return set;
  const start = first.pos;
  const end = last.pos + last.node.nodeSize;
  const stale = set.find(start, end, (spec: Spec) => spec.key !== SLOT_KEY);
  const fresh: Decoration[] = [];
  for (const { node, pos } of blocks) paintNode(node, pos, paint, fresh);
  return set
    .remove(stale.filter((decoration) => decoration.from >= start && decoration.to <= end))
    .add(doc, fresh);
}

function changeDecorations(set: DecorationSet, change: string): Decoration[] {
  return set.find(undefined, undefined, (spec: Spec) => spec.change === change);
}

/**
 * The focused change's bar slot: after the top-level block its last decoration ends in. One keyed
 * widget, so it keeps its DOM as focus moves.
 */
function withSlot(set: DecorationSet, doc: PMNode, paint: Paint): DecorationSet {
  const old = set.find(undefined, undefined, (spec: Spec) => spec.key === SLOT_KEY);
  const focusEnd =
    paint.slot && paint.focus
      ? Math.max(-1, ...changeDecorations(set, paint.focus).map((decoration) => decoration.to))
      : -1;
  const $end = focusEnd >= 0 ? doc.resolve(focusEnd) : null;
  const at = $end ? ($end.depth > 0 ? $end.after(1) : focusEnd) : -1;
  if (old.length === (at >= 0 ? 1 : 0) && (at < 0 || old[0]?.from === at)) return set;
  const without = set.remove(old);
  if (at < 0) return without;
  return without.add(doc, [
    Decoration.widget(at, (editorView) => createBarSlotElement(editorView.dom.ownerDocument), {
      key: SLOT_KEY,
      side: 1,
      stopEvent: () => true,
      ignoreSelection: true,
    }),
  ]);
}

/**
 * One block's decorations, and its descendants'. Text another Work added is hidden. The view's own
 * insertions are green and its deletions struck red, as the draft review's marks; the focused
 * change is emphasized.
 */
function paintNode(block: PMNode, blockPos: number, paint: Paint, out: Decoration[]): void {
  if (block.isInline) return;
  const { view, focus } = paint;
  const decorate = (
    from: number,
    to: number,
    attrs: Record<string, string>,
    node?: "node",
  ): void => {
    const spec: Spec = attrs[SUGGESTION_CHANGE_ATTR]
      ? { change: attrs[SUGGESTION_CHANGE_ATTR] }
      : {};
    out.push(
      node ? Decoration.node(from, to, attrs, spec) : Decoration.inline(from, to, attrs, spec),
    );
  };
  const added = (id: string | undefined, isBlock = false) => ({
    class: [
      "meridian-review-added",
      isBlock && "meridian-review-block",
      id === focus && "meridian-review-emphasized",
    ]
      .filter(Boolean)
      .join(" "),
    ...(id ? { [SUGGESTION_CHANGE_ATTR]: id } : {}),
  });
  const removed = (id: string | undefined, className: string) => ({
    class: [className, id === focus && "sug-focused"].filter(Boolean).join(" "),
    ...(id ? { [SUGGESTION_CHANGE_ATTR]: id } : {}),
  });
  const end = blockPos + block.nodeSize;
  const owner = "sug" in block.attrs ? blockKind(block, view) : "live";
  if (owner === "hidden") {
    decorate(blockPos, end, { class: "sug-hidden" }, "node");
    return;
  }
  if (owner === "own") decorate(blockPos, end, added(block.attrs.sug?.id, true), "node");
  const own = view.draft ? proposals(block, view.draft) : [];
  if (removedIn(block, view))
    decorate(
      blockPos,
      end,
      removed(own.find((layer) => layer.remove)?.id, "sug-del-block"),
      "node",
    );
  // A pending change to the block's attributes shows them; the element is still Live's.
  const shown = viewAttrs(block, view);
  if (
    owner === "live" &&
    block.attrs.sugAttrs &&
    !sameValue(shown, { ...block.attrs, sug: null, sugAttrs: null })
  )
    decorate(
      blockPos,
      end,
      {
        class: "sug-attrs",
        ...(own[0] ? { [SUGGESTION_CHANGE_ATTR]: own[own.length - 1]?.id } : {}),
        "data-view-level": String(shown.level ?? 0),
        // After the element's own `text-align`, so the proposed alignment wins.
        ...(block.isTextblock && "align" in shown
          ? { style: `text-align: ${shown.align ?? "start"}` }
          : {}),
      },
      "node",
    );
  if (!block.isTextblock) {
    block.forEach((child, offset) => {
      paintNode(child, blockPos + 1 + offset, paint, out);
    });
    return;
  }
  block.forEach((child, offset) => {
    const kind = kindOf(child.marks, block, view);
    // The Work's own block shows its text as added already; a later turn's deletion is struck.
    if (kind === "live" || (owner === "own" && kind === "own-ins")) return;
    const from = blockPos + 1 + offset;
    const id = ownChange(child.marks, view, kind === "own-ins" ? "suggest_ins" : "suggest_del");
    const attrs =
      kind === "hidden"
        ? { class: "sug-hidden" }
        : kind === "own-ins"
          ? added(id)
          : removed(id, "sug-del");
    decorate(from, from + child.nodeSize, attrs);
  });
}

/** The view's own change a run's mark of `name` belongs to: the one its review lists it under. */
function ownChange(marks: readonly PMMark[], view: View, name: string): string | undefined {
  return marks.find((mark) => mark.type.name === name && mark.attrs.draft === view.draft)?.attrs.id;
}
