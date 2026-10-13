/**
 * Which change a plain writer click means. The click's caret position is
 * resolved against the painted marks and removals of each change, in tiers:
 *
 * 1. the caret is inside a change's extent (first mark or removal to last,
 *    boundaries inclusive, so the junction of a struck word and its
 *    replacement counts);
 * 2. a near miss: the pointer is within a few pixels of a mark or removal, or
 *    the caret sits in the same word as one;
 * 3. the caret is in a block that holds changes.
 *
 * The first tier with candidates wins, nearest mark first. The result is the
 * whole candidate list so a surface could show every change of a paragraph;
 * today the editor focuses the first.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { ReviewGeometry } from "./decorations";

/** Pointer distance from a painted mark that still counts as the mark. */
export const CLICK_FOCUS_SLOP_PX = 10;

type Span = { from: number; to: number };

/** One change as painted: every operation it spans and where its marks and removals sit. */
export interface ClickChange {
  /** The operation the focus intent names. */
  operationId: string;
  operationIds: ReadonlySet<string>;
  /** Marks are ranges; a removal widget is a point. */
  spans: readonly Span[];
}

export interface ClickCandidate {
  operationId: string;
  tier: 1 | 2 | 3;
  /** Distance from the caret to the change's nearest mark, in document positions. */
  distance: number;
}

export interface ClickProbe {
  /** The caret ProseMirror resolved for the click. */
  pos: number;
  /** The word the caret is in, when it is in one. */
  word: Span | null;
  /** The textblock holding the caret. */
  block: Span | null;
  /** Operations with a painted element within the slop of the pointer. */
  nearOperationIds: ReadonlySet<string>;
}

/** The painted changes of a geometry. Changes being discarded paint nothing, so they are absent. */
export function clickChanges(geometry: ReviewGeometry): ClickChange[] {
  const closureOf = new Map(
    geometry.model.operations.map((op) => [op.operationId, op.closureClassId]),
  );
  const byClosure = new Map<string, { operationId: string; ids: Set<string>; spans: Span[] }>();
  const entry = (operationIds: readonly string[]) => {
    const [first] = operationIds;
    if (!first) return null;
    const key = closureOf.get(first) ?? first;
    let change = byClosure.get(key);
    if (!change) {
      change = { operationId: first, ids: new Set(), spans: [] };
      byClosure.set(key, change);
    }
    for (const id of operationIds) change.ids.add(id);
    return change;
  };
  for (const hunk of geometry.hunks) {
    if (hunk.restoring) continue;
    const change = entry(hunk.operationIds);
    for (const mark of hunk.marks) {
      if (!mark.hide) change?.spans.push({ from: mark.from, to: mark.to });
    }
  }
  for (const removal of geometry.removals) {
    if (removal.restored) continue;
    entry(removal.operationIds)?.spans.push({ from: removal.position, to: removal.position });
  }
  return [...byClosure.values()]
    .filter((change) => change.spans.length > 0)
    .map((change) => ({
      operationId: change.operationId,
      operationIds: change.ids,
      spans: change.spans,
    }));
}

function gap(span: Span, pos: number): number {
  return pos < span.from ? span.from - pos : pos > span.to ? pos - span.to : 0;
}

function nearest(change: ClickChange, pos: number): number {
  return Math.min(...change.spans.map((span) => gap(span, pos)));
}

function touches(change: ClickChange, range: Span): boolean {
  return change.spans.some((span) => span.to >= range.from && span.from <= range.to);
}

/** Candidates for a click, best first; empty when the click means no change. */
export function resolveClickFocus(
  changes: readonly ClickChange[],
  probe: ClickProbe,
): ClickCandidate[] {
  const tiers: Array<[1 | 2 | 3, (change: ClickChange) => boolean]> = [
    [
      1,
      (change) =>
        probe.pos >= Math.min(...change.spans.map((span) => span.from)) &&
        probe.pos <= Math.max(...change.spans.map((span) => span.to)),
    ],
    [
      2,
      (change) =>
        [...change.operationIds].some((id) => probe.nearOperationIds.has(id)) ||
        Boolean(probe.word && touches(change, probe.word)),
    ],
    [3, (change) => Boolean(probe.block && touches(change, probe.block))],
  ];
  for (const [tier, matches] of tiers) {
    const found = changes
      .filter(matches)
      .map((change) => ({
        operationId: change.operationId,
        tier,
        distance: nearest(change, probe.pos),
      }))
      .sort((a, b) => a.distance - b.distance);
    if (found.length > 0) return found;
  }
  return [];
}

/** The textblock and the word around `pos`; both null where there is no text. */
export function textAround(doc: PMNode, pos: number): { block: Span | null; word: Span | null } {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return { block: null, word: null };
  const start = $pos.start();
  const block = { from: start, to: $pos.end() };
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");
  const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}'’_-]/u.test(char);
  let from = $pos.parentOffset;
  let to = from;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return { block, word: to > from ? { from: start + from, to: start + to } : null };
}

/** Operations whose painted elements lie within the slop of a point. */
export function operationsNearPoint(
  root: ParentNode,
  attr: string,
  x: number,
  y: number,
  slop = CLICK_FOCUS_SLOP_PX,
): Set<string> {
  const near = new Set<string>();
  for (const element of root.querySelectorAll(`[${attr}]`)) {
    const hit = [...element.getClientRects()].some(
      (rect) =>
        x >= rect.left - slop &&
        x <= rect.right + slop &&
        y >= rect.top - slop &&
        y <= rect.bottom + slop,
    );
    if (!hit) continue;
    for (const id of (element.getAttribute(attr) ?? "").split(" ")) if (id) near.add(id);
  }
  return near;
}
