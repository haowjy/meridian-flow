/**
 * Decoration builder: turns the browser-computed review into a ProseMirror
 * `DecorationSet` over the draft document the projection was computed on.
 *
 * Draft text a change added is green (inline marks, or a block mark over a
 * wholly new block). Base text a change removed is a red read-only widget
 * (`removal-widget.ts`) at the hunk's anchor, ahead of the green text that
 * replaced it. It is DOM only: the editor document never contains it. Only
 * red and green exist; who wrote a change is not painted.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, type DecorationSet, type EditorView } from "@tiptap/pm/view";
import { type ProjectedReview, removedParagraphs } from "./model";
import {
  BAR_SLOT_CLASS,
  createBarSlotElement,
  createRemovalElement,
  planRemovals,
  REMOVAL_BLOCK_CLASS,
  REMOVAL_CLASS,
  type RemovalHandlers,
  type RemovalInput,
  type RemovalPlan,
} from "./removal-widget";

const ADDED_CLASS = "meridian-review-added";
const EMPHASIS_CLASS = "meridian-review-emphasized";
/** A change that arrived while the writer was reviewing pulses once. */
const ARRIVED_CLASS = "meridian-review-arrived";
/** Modifier on the insert class when the decoration covers a whole block node. */
const BLOCK_CLASS = "meridian-review-block";
/** Written on every mark and removal so a click, and the bar, find their change. */
export const CHANGE_ATTR = "data-review-change";

/** Stable identity in decoration equality; semantic IDs are attached by the view owner. */
export const RENDER_ATTR = "data-review-render";

export function paintDecorations(
  review: ProjectedReview,
  keys: ReadonlyMap<number, string>,
  previous: DecorationSet,
  activeChangeId: string | null,
  barSlot: boolean,
  handlersFor: (view: EditorView) => RemovalHandlers,
): { decorations: DecorationSet; removals: ReadonlyMap<string, RemovalPlan> } {
  const { doc, groups } = review;
  const decorations: Decoration[] = [];
  const removals: RemovalInput[] = [];
  /** Where the focused change ends: the bar's block goes after the paragraph holding this. */
  let focusedEnd: number | null = null;

  for (const group of groups) {
    const focused = group.id === activeChangeId;
    for (const hunk of group.hunks) {
      const key = keys.get(hunk.index) ?? "";
      if (focused) focusedEnd = Math.max(focusedEnd ?? 0, hunk.inserted?.to ?? hunk.anchor);
      if (hunk.inserted) {
        for (const mark of addedMarks(doc, hunk.inserted.from, hunk.inserted.to)) {
          const attrs = {
            class: [ADDED_CLASS, mark.node && BLOCK_CLASS].filter(Boolean).join(" "),
            [RENDER_ATTR]: key,
          };
          const spec = {
            renderKey: key,
            side: "added",
            node: mark.node,
            inclusiveStart: true,
            inclusiveEnd: true,
          };
          decorations.push(
            mark.node
              ? Decoration.node(mark.from, mark.to, attrs, spec)
              : Decoration.inline(mark.from, mark.to, attrs, spec),
          );
        }
      }
      // Format and whitespace hunks keep their text: the green mark says it, a struck copy would not.
      if (hunk.kind === "text" && hunk.removed.length > 0) {
        const block = !doc.resolve(hunk.anchor).parent.inlineContent;
        const paragraphs = removedParagraphs(hunk.removed);
        removals.push({
          position: hunk.anchor,
          block,
          // An inline widget cannot hold paragraphs: a removal that crossed blocks reads as one run.
          paragraphs: block ? paragraphs : [paragraphs.join(" ")],
          tight: endsBeforePunctuation(doc, hunk.anchor),
          changeId: group.id,
          identity: key,
        });
      }
    }
  }

  removals.sort((a, b) => a.position - b.position);
  const plans = new Map<string, RemovalPlan>();
  for (const plan of planRemovals(removals)) {
    plans.set(plan.identity, plan);
    decorations.push(
      Decoration.widget(
        plan.position,
        (view) =>
          createRemovalElement(view.dom.ownerDocument, plan, {
            handlers: handlersFor(view),
            changeAttr: CHANGE_ATTR,
            renderAttr: RENDER_ATTR,
          }),
        {
          key: `removal:${plan.identity}:${plan.block ? "block" : "inline"}`,
          renderKey: plan.identity,
          side: -1,
          stopEvent: () => true,
        },
      ),
    );
  }

  if (barSlot && focusedEnd !== null) {
    decorations.push(
      Decoration.widget(
        slotPosition(doc, focusedEnd),
        (view) => createBarSlotElement(view.dom.ownerDocument),
        {
          // One slot per focused change, so the bar's DOM survives recomputes.
          key: "bar-slot",
          side: 1,
          stopEvent: () => true,
          ignoreSelection: true,
        },
      ),
    );
  }

  // Preserve the mapped tree and its unchanged decorations. Equality includes ranges and attrs;
  // widget payload is updated by the view, never smuggled into its key.
  const before = previous.find();
  const byIdentity = new Map<string, Decoration[]>();
  const identity = (decoration: Decoration) =>
    decoration.spec.key ??
    `${decoration.spec.renderKey}:${decoration.spec.side}:${decoration.spec.node}`;
  for (const decoration of before) {
    const key = identity(decoration);
    const entries = byIdentity.get(key) ?? [];
    entries.push(decoration);
    byIdentity.set(key, entries);
  }
  const retained = new Set<Decoration>();
  const added: Decoration[] = [];
  for (const decoration of decorations) {
    const same = byIdentity
      .get(identity(decoration))
      ?.find(
        (old) => !retained.has(old) && old.from === decoration.from && old.to === decoration.to,
      );
    if (same) retained.add(same);
    else added.push(decoration);
  }
  return {
    decorations: previous.remove(before.filter((old) => !retained.has(old))).add(doc, added),
    removals: plans,
  };
}

/** After the paragraph a position is in, or the position itself when it is already between blocks. */
function slotPosition(doc: PMNode, position: number): number {
  const $position = doc.resolve(Math.min(position, doc.content.size));
  return $position.parent.inlineContent ? $position.after() : position;
}

/** Closing punctuation never takes a space before it, so a removal ahead of it keeps none. */
const CLOSING_PUNCTUATION = /^[,.;:!?)\]}…’”]/;

/** The removal sits at the end of its line, or right before punctuation. */
function endsBeforePunctuation(doc: PMNode, position: number): boolean {
  const next = doc.textBetween(position, Math.min(position + 1, doc.content.size), "", "");
  return next === "" || CLOSING_PUNCTUATION.test(next);
}

interface AddedMark {
  from: number;
  to: number;
  /** A decoration over exactly one top-level node, not inline text. */
  node: boolean;
}

/**
 * The green marks of one inserted range: a block mark over every text block or atom the range holds
 * whole (a new paragraph), an inline mark over the part of any other text block it touches.
 */
function addedMarks(doc: PMNode, from: number, to: number): AddedMark[] {
  const marks: AddedMark[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (node.isTextblock) {
      // A new block's range starts at the block and ends at its content's end.
      if (pos >= from && end - 1 <= to) marks.push({ from: pos, to: end, node: true });
      else {
        const stop = Math.min(to, end - 1);
        // A token carries the space before it; the mark starts at the word.
        let start = Math.max(from, pos + 1);
        start += /^\s*/.exec(doc.textBetween(start, stop, "", "\ufffc"))?.[0].length ?? 0;
        if (stop > start) marks.push({ from: start, to: stop, node: false });
      }
      return false;
    }
    if (node.isLeaf) {
      if (pos >= from && end <= to) marks.push({ from: pos, to: end, node: true });
      return false;
    }
    return true;
  });
  return marks;
}

/** Class name constants exported for tests + optional consumer selectors. */
export const inlineReviewClassNames = {
  added: ADDED_CLASS,
  emphasized: EMPHASIS_CLASS,
  arrived: ARRIVED_CLASS,
  block: BLOCK_CLASS,
  removal: REMOVAL_CLASS,
  removalBlock: REMOVAL_BLOCK_CLASS,
  barSlot: BAR_SLOT_CLASS,
} as const;
