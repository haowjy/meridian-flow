import type { BlockId, MovedText } from "@meridian/document-model";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

/**
 * The pairs of blocks `tr` moved text between, read from its steps, never from what the text
 * spells. A draft's write records the pairs, and the two blocks are one change (design §2):
 * - a step's replaced range that starts in one textblock and ends in another joins the two (a
 *   join, a delete or typing across a paragraph boundary, text read back from the page);
 * - text the steps kept that stands in a textblock with another id than before (Enter inside a
 *   paragraph, a paste of paragraphs into one);
 * - a drop (`uiEvent: "drop"`) moves text from the textblocks it deleted from into those it
 *   inserted into.
 */
export function movedPieces(tr: Transaction): [BlockId, BlockId][] {
  return movedText(tr).map(({ from, to }) => [from, to]);
}

/**
 * The exact text ranges a transaction kept while moving them between blocks. The ranges are in
 * the old and new ProseMirror documents; the model turns the old range into Loro character ids
 * before writing either text doc. A range is emitted only for text that survived the step maps.
 */
export function movedText(tr: Transaction): MovedText[] {
  const { before, doc, mapping } = tr;
  // What the steps replaced, in the old document's positions, and what they inserted, in the new.
  const replaced: [number, number][] = [];
  const inserted: [number, number][] = [];
  mapping.maps.forEach((map, i) => {
    // Back through the maps before this one only: `Mapping.slice(0, i).invert()` would read
    // them all, and widen the range by what this step and the later ones deleted.
    const back = (pos: number, assoc: number) => {
      for (let j = i - 1; j >= 0; j--) pos = mapping.maps[j].invert().map(pos, assoc);
      return pos;
    };
    const ahead = (pos: number, assoc: number) => {
      for (let j = i + 1; j < mapping.maps.length; j++) pos = mapping.maps[j].map(pos, assoc);
      return pos;
    };
    map.forEach((from, to, newFrom, newTo) => {
      replaced.push([back(from, -1), back(to, 1)]);
      inserted.push([ahead(newFrom, -1), ahead(newTo, 1)]);
    });
  });
  if (replaced.length === 0) return [];
  const pairs = new Map<string, [BlockId, BlockId]>();
  const spans = new Map<string, MovedText>();
  const pair = (a: BlockId | null, b: BlockId | null) => {
    if (a !== null && b !== null && a !== b) pairs.set(a < b ? `${a}/${b}` : `${b}/${a}`, [a, b]);
  };
  const span = (
    from: BlockId | null,
    to: BlockId | null,
    sourceFrom: number,
    length: number,
    destinationFrom: number,
  ) => {
    if (from === null || to === null || from === to || length <= 0) return;
    const key = `${from}/${to}/${sourceFrom}/${destinationFrom}`;
    spans.set(key, { from, to, sourceFrom, length, destinationFrom });
  };

  for (const [from, to] of replaced) pair(textblockAt(before, from), textblockAt(before, to));

  const seen = new Set<Node>();
  for (const [from, to] of replaced)
    before.nodesBetween(
      Math.max(0, from - 1),
      Math.min(before.content.size, to + 1),
      (node, pos) => {
        if (!node.isTextblock) return true;
        const was = node.attrs.id;
        if (seen.has(node) || typeof was !== "string") return false;
        seen.add(node);
        const [start, end] = [pos + 1, pos + 1 + node.content.size];
        const cuts = new Set([start, end]);
        for (const range of replaced)
          for (const at of range) if (at > start && at < end) cuts.add(at);
        const points = [...cuts].sort((a, b) => a - b);
        for (let i = 0; i + 1 < points.length; i++) {
          const at = points[i];
          if (replaced.some(([a, b]) => a <= at && at < b)) continue;
          // The character after `at` was kept: where it stands now.
          const now = mapping.mapResult(at, 1);
          if (now.deleted || mapping.map(at + 1, -1) !== now.pos + 1) continue;
          const into = textblockAt(doc, now.pos);
          pair(was, into);
          span(was, into, at - start, points[i + 1] - at, textOffsetAt(doc, now.pos));
        }
        return false;
      },
    );

  if (tr.getMeta("uiEvent") === "drop") {
    const from = textblocksIn(before, replaced);
    const into = textblocksIn(doc, inserted);
    for (const a of from) for (const b of into) pair(a, b);
  }
  const dropped = dropSpans(tr, replaced, inserted, pair);
  const exact = [...spans.values(), ...dropped];
  return exact.length > 0
    ? exact
    : [...pairs.values()].map(([from, to]) => ({
        from,
        to,
        sourceFrom: 0,
        length: 0,
        destinationFrom: 0,
      }));
}

function textblockAt(doc: Node, pos: number): BlockId | null {
  const parent = doc.resolve(pos).parent;
  const id = parent.attrs.id;
  return parent.isTextblock && typeof id === "string" ? id : null;
}

function textOffsetAt(doc: Node, pos: number): number {
  const resolved = doc.resolve(pos);
  return pos - resolved.start(resolved.depth);
}

function dropSpans(
  tr: Transaction,
  replaced: readonly [number, number][],
  inserted: readonly [number, number][],
  pair: (a: BlockId | null, b: BlockId | null) => void,
): MovedText[] {
  if (tr.getMeta("uiEvent") !== "drop") return [];
  const from = rangesInTextblocks(tr.before, replaced);
  const into = rangesInTextblocks(tr.doc, inserted);
  const out: MovedText[] = [];
  for (const source of from)
    for (const destination of into) {
      pair(source.id, destination.id);
      out.push({
        from: source.id,
        to: destination.id,
        sourceFrom: source.from,
        length: source.length,
        destinationFrom: destination.from,
      });
    }
  return out;
}

function rangesInTextblocks(
  doc: Node,
  ranges: readonly [number, number][],
): { id: BlockId; from: number; length: number }[] {
  const out: { id: BlockId; from: number; length: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock || typeof node.attrs.id !== "string") return false;
    const start = pos + 1;
    const end = start + node.content.size;
    for (const [from, to] of ranges) {
      const left = Math.max(from, start);
      const right = Math.min(to, end);
      if (right > left) out.push({ id: node.attrs.id, from: left - start, length: right - left });
    }
    return false;
  });
  return out;
}

/** The ids of the textblocks holding any of `ranges`, an end included. */
function textblocksIn(doc: Node, ranges: readonly [number, number][]): Set<BlockId> {
  const out = new Set<BlockId>();
  for (const [from, to] of ranges) {
    for (const at of [from, to]) {
      const id = textblockAt(doc, at);
      if (id !== null) out.add(id);
    }
    if (from < to)
      doc.nodesBetween(from, to, (node) => {
        if (!node.isTextblock) return true;
        if (typeof node.attrs.id === "string") out.add(node.attrs.id);
        return false;
      });
  }
  return out;
}
