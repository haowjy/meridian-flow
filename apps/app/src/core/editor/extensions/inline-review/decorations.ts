/**
 * Decoration builder — turns the resolved hunk model into a ProseMirror
 * `DecorationSet` scoped to the current draft-doc positions.
 *
 * All position resolution routes through `Y.RelativePosition` → absolute
 * position via `y-prosemirror`'s binding mapping, so decorations survive
 * remote sync and are never coupled to a specific insert index.
 *
 * Insertions style text that exists in the draft projection. Removed live text
 * is a read-only widget (`removal-widget.ts`) beside the insertion that replaced
 * it, struck through like suggestion mode. It is DOM only: the editor document
 * never contains it.
 */
import { i18n } from "@lingui/core";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type * as Y from "yjs";
import {
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "../../relative-position-runtime";

import {
  blockRemovalKind,
  changeOperationIds,
  hunkTone,
  type InlineReviewModel,
  indexOperations,
  type ResolvedBlockReviewHunk,
  type ResolvedReviewHunk,
  type ResolvedTextReviewHunk,
  type ReviewTone,
} from "./model";
import {
  createBarSlotElement,
  createRemovalElement,
  planRemovals,
  type RemovalHandlers,
  type RemovalInput,
  type RemovalPlan,
  type RemovalSegment,
} from "./removal-widget";

/**
 * Everything the builder needs from the editor state to resolve anchors.
 * Injected rather than pulled from state so the builder can be tested
 * with fakes.
 */
export interface DecorationResolver {
  doc: PMNode;
  yDoc: Y.Doc;
  yFragment: Y.XmlFragment;
  /** The ProseMirror↔Yjs node mapping owned by y-prosemirror's binding. */
  mapping: Map<Y.AbstractType<unknown>, PMNode>;
}

const ADDED_CLASS = "meridian-review-added";
const WRITER_CLASS = "meridian-review-writer";
/** Neutral dashed seam for a CRDT merge artifact (spec §6.2) — not an author tint. */
const MERGED_CLASS = "meridian-review-merged";
const EMPHASIS_CLASS = "meridian-review-emphasized";
/** A change that arrived while the writer was reviewing pulses once. */
const ARRIVED_CLASS = "meridian-review-arrived";
/** Modifier on the insert classes when the decoration covers a whole block node. */
const BLOCK_CLASS = "meridian-review-block";
const HUNK_ATTR = "data-review-hunk";
const OPERATION_ATTR = "data-review-operations";

/** What the painter needs besides the model: which change is selected and which folds are open. */
export interface ReviewPaintState {
  activeOperationId: string | null;
  /** Operations of changes that just arrived; their marks carry the pulse class. */
  pulsedOperationIds: ReadonlySet<string>;
  expandedRemovals: ReadonlySet<string>;
  /** The removal whose fold the writer just used from the keyboard; its rebuilt widget takes focus. */
  refocusRemoval: string | null;
  /** Open a block for the focused change's bar after the paragraph the change ends in. */
  barSlot: boolean;
}

/** One tinted range of a hunk: a text insertion, one author's span of it, or a whole inserted block. */
interface MarkGeometry {
  from: number;
  to: number;
  tone: ReviewTone;
  /** A decoration over exactly one top-level node, not inline text. */
  node: boolean;
  /** Written on the DOM so a click or the stepper finds the change. */
  operationAttr: string;
  /** The operation a span belongs to, when it is painted for one author inside a larger hunk. */
  spanOperationId: string | null;
}

interface HunkGeometry {
  hunkId: string;
  operationIds: readonly string[];
  /** Where the hunk ends, for placing the focused change's bar after it. */
  end: number;
  marks: MarkGeometry[];
}

/**
 * A model resolved against one document: every position, tone and removal plan
 * the painter needs, and nothing that depends on which change is focused,
 * pulsing or unfolded. Resolving costs a relative-position lookup per anchor;
 * painting from it does not, so a focus step repaints without re-resolving.
 * Valid for exactly the `model` and `doc` it was built from.
 */
export interface ReviewGeometry {
  readonly model: InlineReviewModel;
  readonly doc: PMNode;
  readonly hunks: readonly HunkGeometry[];
  readonly removals: readonly RemovalPlan[];
}

/**
 * Resolve the model's anchors in `resolver.doc`. When an anchor no longer
 * resolves (the underlying Yjs items were deleted, or the mapping is
 * mid-rebuild), the hunk is silently dropped for this pass: the next model
 * refresh will produce anchors that resolve, or the plugin will just render
 * fewer decorations until then. Never throws.
 */
export function resolveGeometry(
  model: InlineReviewModel,
  resolver: DecorationResolver,
): ReviewGeometry {
  const operationsById = indexOperations(model.operations);
  const hunks: HunkGeometry[] = [];
  const removals: RemovalInput[] = [];

  for (const hunk of model.hunks) {
    const startPos = resolveAnchor(hunk.relStart, resolver);
    if (startPos == null) continue;
    const endPos = resolveAnchor(hunk.relEnd, resolver);

    const removed = removedSegments(hunk, operationsById);
    if (removed.length > 0) {
      removals.push({
        position: startPos,
        block: isBlockPosition(resolver.doc, startPos),
        segments: removed,
        tight: endsBeforePunctuation(resolver.doc, startPos),
        hunkId: hunk.hunkId,
        operationIds: hunk.operationIds,
      });
    }

    hunks.push({
      hunkId: hunk.hunkId,
      operationIds: hunk.operationIds,
      end: Math.max(startPos, endPos ?? startPos),
      marks:
        endPos == null || endPos <= startPos
          ? []
          : hunk.kind === "block"
            ? blockMarks(hunk, startPos, endPos, operationsById, resolver)
            : textMarks(hunk, startPos, endPos, operationsById, resolver),
    });
  }

  return { model, doc: resolver.doc, hunks, removals: planRemovals(removals) };
}

/**
 * Paint resolved geometry: the focused change emphasised, the arrived change
 * pulsing, long removals folded or open, and the bar's block after the focused
 * change. Pure over `geometry` and `paint`.
 */
export function paintDecorations(
  geometry: ReviewGeometry,
  paint: ReviewPaintState,
  handlersFor: (view: EditorView) => RemovalHandlers,
): DecorationSet {
  const { model, doc } = geometry;
  if (geometry.hunks.length === 0 && geometry.removals.length === 0) return DecorationSet.empty;
  const focusedIds = changeOperationIds(model.operations, paint.activeOperationId);
  const isFocused = (ids: readonly string[]) => ids.some((id) => focusedIds.has(id));
  const isPulsed = (ids: readonly string[]) => ids.some((id) => paint.pulsedOperationIds.has(id));
  const decorations: Decoration[] = [];
  /** Where the focused change ends: the bar's block goes after the paragraph holding this. */
  let focusedEnd: number | null = null;

  for (const hunk of geometry.hunks) {
    const hunkFocused = isFocused(hunk.operationIds);
    const pulsed = isPulsed(hunk.operationIds);
    if (hunkFocused) focusedEnd = Math.max(focusedEnd ?? hunk.end, hunk.end);
    for (const mark of hunk.marks) {
      const focused =
        hunkFocused || (mark.spanOperationId !== null && focusedIds.has(mark.spanOperationId));
      const attrs = {
        class: markClassName(mark, focused, pulsed),
        [HUNK_ATTR]: hunk.hunkId,
        [OPERATION_ATTR]: mark.operationAttr,
      };
      const spec = { [HUNK_ATTR]: hunk.hunkId, [OPERATION_ATTR]: mark.operationAttr };
      decorations.push(
        mark.node
          ? Decoration.node(mark.from, mark.to, attrs, spec)
          : Decoration.inline(mark.from, mark.to, attrs, spec),
      );
    }
  }

  for (const plan of geometry.removals) {
    const focused = isFocused(plan.operationIds);
    const pulsed = isPulsed(plan.operationIds);
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
            hunkAttr: HUNK_ATTR,
            operationAttr: OPERATION_ATTR,
          }),
        {
          // The locale is part of the key: the fold's label is copy, redrawn when it changes.
          key: `removal:${plan.identity}:${plan.kind}${plan.tight ? ":tight" : ""}:${focused ? "focused" : "idle"}:${pulsed ? "arrived" : "settled"}:${expanded ? "open" : "folded"}:${i18n.locale}`,
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
          // One slot per focused change, so the bar's DOM survives refetches.
          key: `bar-slot:${paint.activeOperationId}`,
          side: 1,
          stopEvent: () => true,
          ignoreSelection: true,
        },
      ),
    );
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Build a `DecorationSet` straight from the model: resolve, then paint. The
 * plugin keeps the geometry between paints; this is for callers that paint once.
 */
export function buildDecorations(
  model: InlineReviewModel | null,
  paint: ReviewPaintState,
  resolver: DecorationResolver,
  handlersFor: (view: EditorView) => RemovalHandlers,
): DecorationSet {
  if (!model || model.hunks.length === 0) return DecorationSet.empty;
  return paintDecorations(resolveGeometry(model, resolver), paint, handlersFor);
}

/** After the paragraph a position is in, or the position itself when it is already between blocks. */
function slotPosition(doc: PMNode, position: number): number {
  const $position = doc.resolve(position);
  return $position.parent.inlineContent ? $position.after() : position;
}

/**
 * What a hunk took out of live, in its removers' colours. A text hunk says who
 * removed each stretch (`deletedSpans`); a block hunk does not, so its owning
 * operations decide. Without spans the text reads as the AI's.
 */
function removedSegments(
  hunk: ResolvedReviewHunk,
  operationsById: ReadonlyMap<string, ReviewOperation>,
): RemovalSegment[] {
  if (hunk.kind === "block") {
    const text = hunk.deletedBlock?.display;
    return text ? [{ text, kind: blockRemovalKind(hunk, operationsById) }] : [];
  }
  const text = hunk.deletedText;
  if (!text) return [];
  if (!hunk.deletedSpans?.length) {
    // Nobody is named for an unclassified removal; elsewhere the AI is the default remover.
    return [{ text, kind: hunk.unclassified ? "unattributed" : "agent" }];
  }
  return hunk.deletedSpans.map((span) => ({
    text: text.slice(span.from, span.to),
    kind: span.deletedBy,
  }));
}

/** Closing punctuation never takes a space before it, so a removal ahead of it keeps none. */
const CLOSING_PUNCTUATION = /^[,.;:!?)\]}…’”]/;

/** The removal sits at the end of its line, or right before punctuation. */
function endsBeforePunctuation(doc: PMNode, position: number): boolean {
  const next = doc.textBetween(position, Math.min(position + 1, doc.content.size), "", "");
  return next === "" || CLOSING_PUNCTUATION.test(next);
}

/** A position between blocks (or inside a container), where an inline widget would be invalid. */
function isBlockPosition(doc: PMNode, position: number): boolean {
  return !doc.resolve(position).parent.inlineContent;
}

/**
 * The inserted draft block of a whole-block replace hunk: one node decoration
 * (the anchor spans exactly that node), painting the same tint family as text
 * hunks at node granularity. A deleted live block is a removal, planned
 * separately. Falls back to an inline decoration over the same range when the
 * doc shifted under us (mid-sync): a tinted range beats an invisible hunk.
 */
function blockMarks(
  hunk: ResolvedBlockReviewHunk,
  startPos: number,
  endPos: number,
  operationsById: ReadonlyMap<string, ReviewOperation>,
  resolver: DecorationResolver,
): MarkGeometry[] {
  if (!hunk.insertedBlock) return [];
  const node = resolver.doc.nodeAt(startPos);
  return [
    {
      from: startPos,
      to: endPos,
      tone: hunkTone(hunk, operationsById),
      // The server anchors block hunks from before to after one top-level node.
      node: node != null && startPos + node.nodeSize === endPos,
      operationAttr: hunk.operationIds.join(" "),
      spanOperationId: null,
    },
  ];
}

/**
 * The insertion marks of a text hunk. A neutral hunk is one seam over its whole
 * range; otherwise one mark per span, so nested authorship (a writer edit
 * inside an AI insertion) paints in each owner's colour, falling back to the
 * whole hunk when spans are missing or none of their anchors resolve.
 */
function textMarks(
  hunk: ResolvedTextReviewHunk,
  startPos: number,
  endPos: number,
  operationsById: ReadonlyMap<string, ReviewOperation>,
  resolver: DecorationResolver,
): MarkGeometry[] {
  const tone = hunkTone(hunk, operationsById);
  const whole: MarkGeometry = {
    from: startPos,
    to: endPos,
    tone,
    node: false,
    operationAttr: hunk.operationIds.join(" "),
    spanOperationId: null,
  };
  if (tone === "neutral") return [whole];
  const spanRanges = resolveSpanRanges(hunk, resolver);
  if (spanRanges.length === 0) return [whole];
  return spanRanges.map((span) => ({
    from: span.from,
    to: span.to,
    tone: operationsById.get(span.operationId)?.kind === "writer" ? "writer" : "agent",
    node: false,
    operationAttr: span.operationId,
    spanOperationId: span.operationId,
  }));
}

interface ResolvedSpanRange {
  operationId: string;
  from: number;
  to: number;
}

/**
 * Resolve a hunk's per-operation spans into absolute-position ranges. Spans
 * whose anchors don't resolve (stale after edits) are dropped; the caller
 * degrades to whole-hunk coloring when none survive. Adjacent or overlapping
 * spans that belong to the same operation are merged so the DOM shows one
 * continuous highlight — never scrabble tiles at a keystroke boundary.
 * Author boundaries (writer↔agent) are preserved because they have
 * different operationIds.
 */
function resolveSpanRanges(
  hunk: ResolvedTextReviewHunk,
  resolver: DecorationResolver,
): ResolvedSpanRange[] {
  const raw: ResolvedSpanRange[] = [];
  for (const span of hunk.spans) {
    const from = resolveAnchor(span.from, resolver);
    const to = resolveAnchor(span.to, resolver);
    if (from == null || to == null || to <= from) continue;
    raw.push({ operationId: span.operationId, from, to });
  }
  if (raw.length <= 1) return raw;
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: ResolvedSpanRange[] = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && last.operationId === range.operationId && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Pull the resolver context out of an EditorState. Returns `null` if the
 * y-sync plugin hasn't finished binding yet (mapping is empty on the first
 * frame after mount), which the plugin treats as "no decorations this tick."
 */
export function resolverFromState(state: {
  doc: PMNode;
  plugins?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: EditorState.field is typed via generics we can't parameterise here without pulling prosemirror-state.
  [key: string]: any;
}): DecorationResolver | null {
  const runtime = relativePositionRuntimeFromState(state as never);
  if (!runtime) return null;
  return {
    doc: runtime.doc,
    yDoc: runtime.yDoc,
    yFragment: runtime.yFragment,
    mapping: runtime.mapping,
  };
}

function resolveAnchor(anchor: Y.RelativePosition, resolver: DecorationResolver): number | null {
  return resolveRelativePosition(resolver, anchor);
}

function markClassName(mark: MarkGeometry, focused: boolean, pulsed: boolean): string {
  const base =
    mark.tone === "neutral" ? MERGED_CLASS : mark.tone === "writer" ? WRITER_CLASS : ADDED_CLASS;
  return classNames(
    base,
    mark.node && BLOCK_CLASS,
    focused && EMPHASIS_CLASS,
    pulsed && ARRIVED_CLASS,
  );
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** Class name constants exported for tests + optional consumer selectors. */
export const inlineReviewClassNames = {
  added: ADDED_CLASS,
  writer: WRITER_CLASS,
  merged: MERGED_CLASS,
  emphasized: EMPHASIS_CLASS,
  arrived: ARRIVED_CLASS,
  block: BLOCK_CLASS,
} as const;
