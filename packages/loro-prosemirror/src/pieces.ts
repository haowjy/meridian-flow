import type { BlockId } from "@meridian/document-model";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

/**
 * The pairs of blocks `tr` moved text between: text the transaction kept that stands in a
 * textblock with another id than the one it stood in before (Enter inside a paragraph, a join, a
 * delete or a paste across a paragraph boundary). Read from the steps' position maps, so it is the
 * same characters and never a guess from what the text spells. A draft's write records the pairs,
 * and the two blocks are one change (design §2).
 */
export function movedPieces(tr: Transaction): [BlockId, BlockId][] {
  const { before, doc, mapping } = tr;
  // What the steps replaced, in the old document's positions.
  const replaced: [number, number][] = [];
  mapping.maps.forEach((map, i) => {
    const back = mapping.slice(0, i).invert();
    map.forEach((from, to) => {
      replaced.push([back.map(from, -1), back.map(to, 1)]);
    });
  });
  if (replaced.length === 0) return [];
  const pairs = new Map<string, [BlockId, BlockId]>();
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
          const parent = doc.resolve(now.pos).parent;
          const id = parent.attrs.id;
          if (parent.isTextblock && typeof id === "string" && id !== was)
            pairs.set(`${was}\u0000${id}`, [was, id]);
        }
        return false;
      },
    );
  return [...pairs.values()];
}
