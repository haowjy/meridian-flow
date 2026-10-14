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
import { i18n } from "@lingui/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
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
} from "./removal-widget";

const ADDED_CLASS = "meridian-review-added";
const EMPHASIS_CLASS = "meridian-review-emphasized";
/** A change that arrived while the writer was reviewing pulses once. */
const ARRIVED_CLASS = "meridian-review-arrived";
/** Modifier on the insert class when the decoration covers a whole block node. */
const BLOCK_CLASS = "meridian-review-block";
/** Written on every mark and removal so a click, and the bar, find their change. */
export const CHANGE_ATTR = "data-review-change";

/** What the painter needs besides the review: which change is selected and which folds are open. */
export interface ReviewPaintState {
  activeChangeId: string | null;
  /** Changes that just arrived; their marks carry the pulse class. */
  pulsedChangeIds: ReadonlySet<string>;
  expandedRemovals: ReadonlySet<string>;
  /** The removal whose fold the writer just used from the keyboard; its rebuilt widget takes focus. */
  refocusRemoval: string | null;
  /** Open a block for the focused change's bar after the paragraph the change ends in. */
  barSlot: boolean;
}

export function paintDecorations(
  review: ProjectedReview,
  paint: ReviewPaintState,
  handlersFor: (view: EditorView) => RemovalHandlers,
): DecorationSet {
  const { doc, groups } = review;
  if (groups.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  const removals: RemovalInput[] = [];
  /** Where the focused change ends: the bar's block goes after the paragraph holding this. */
  let focusedEnd: number | null = null;

  for (const group of groups) {
    const focused = group.id === paint.activeChangeId;
    const pulsed = paint.pulsedChangeIds.has(group.id);
    for (const hunk of group.hunks) {
      if (focused) focusedEnd = Math.max(focusedEnd ?? 0, hunk.inserted?.to ?? hunk.anchor);
      if (hunk.inserted) {
        for (const mark of addedMarks(doc, hunk.inserted.from, hunk.inserted.to)) {
          const attrs = {
            class: [
              ADDED_CLASS,
              mark.node && BLOCK_CLASS,
              focused && EMPHASIS_CLASS,
              pulsed && ARRIVED_CLASS,
            ]
              .filter(Boolean)
              .join(" "),
            [CHANGE_ATTR]: group.id,
          };
          const spec = { [CHANGE_ATTR]: group.id };
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
        });
      }
    }
  }

  removals.sort((a, b) => a.position - b.position);
  for (const plan of planRemovals(removals)) {
    const focused = plan.changeId === paint.activeChangeId;
    const pulsed = paint.pulsedChangeIds.has(plan.changeId);
    const expanded = paint.expandedRemovals.has(plan.identity);
    decorations.push(
      Decoration.widget(
        plan.position,
        (view) =>
          createRemovalElement(view.dom.ownerDocument, plan, {
            focused,
            pulsed,
            expanded,
            refocusToggle: paint.refocusRemoval === plan.identity,
            handlers: handlersFor(view),
            changeAttr: CHANGE_ATTR,
          }),
        {
          // The locale is part of the key: the fold's label is copy, redrawn when it changes.
          key: `removal:${plan.identity}:${JSON.stringify([plan.block, plan.tight])}:${focused ? "focused" : "idle"}:${pulsed ? "arrived" : "settled"}:${expanded ? "open" : "folded"}:${i18n.locale}`,
          side: -1,
          // The widget owns its pointer events; ProseMirror must not move the
          // caret or start a drag from them.
          stopEvent: () => true,
        },
      ),
    );
  }

  if (paint.barSlot && focusedEnd !== null) {
    decorations.push(
      Decoration.widget(
        slotPosition(doc, focusedEnd),
        (view) => createBarSlotElement(view.dom.ownerDocument),
        {
          // One slot per focused change, so the bar's DOM survives recomputes.
          key: `bar-slot:${paint.activeChangeId}`,
          side: 1,
          stopEvent: () => true,
          ignoreSelection: true,
        },
      ),
    );
  }

  return DecorationSet.create(doc, decorations);
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
