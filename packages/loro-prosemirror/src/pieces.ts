import type { BlockId } from "@meridian/document-model";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

export function movedPieces(tr: Transaction): [BlockId, BlockId][] {
  const { before, doc, mapping } = tr;
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
  const pair = (a: BlockId | null, b: BlockId | null) => {
    if (a !== null && b !== null && a !== b) pairs.set(a < b ? `${a}/${b}` : `${b}/${a}`, [a, b]);
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
          pair(was, textblockAt(doc, now.pos));
        }
        return false;
      },
    );

  if (tr.getMeta("uiEvent") === "drop") {
    const from = textblocksIn(before, replaced);
    const into = textblocksIn(doc, inserted);
    for (const a of from) for (const b of into) pair(a, b);
  }
  return [...pairs.values()];
}

function textblockAt(doc: Node, pos: number): BlockId | null {
  const parent = doc.resolve(pos).parent;
  const id = parent.attrs.id;
  return parent.isTextblock && typeof id === "string" ? id : null;
}

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
