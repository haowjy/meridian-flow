import type { BlockId } from "@meridian/document-model";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

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
    const ranges: [number, number][] = [];
    map.forEach((from, to) => {
      ranges.push([from, to]);
    });
    if (ranges.length === 0) return;
    // Back through the maps before this one only: `Mapping.slice(0, i).invert()` would read
    // them all, and widen the range by what this step and the later ones deleted.
    const back = (pos: number, assoc: number) => {
      for (let j = i - 1; j >= 0; j--) pos = mapping.maps[j].invert().map(pos, assoc);
      return pos;
    };
    for (const [from, to] of ranges) replaced.push([back(from, -1), back(to, 1)]);
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

/**
 * Text that replaces a selection across textblocks without a keypress (`insertText` from
 * dictation, an autocorrect replacement, CDP): ProseMirror would read it back from the DOM, and its
 * diff stops at the joined block, whose id is the first block's, so the kept tail is rewritten as
 * new text and `movedPieces` sees nothing moved. Insert it as ProseMirror's keypress handler does.
 * Composition text cannot be cancelled and still takes the DOM path.
 */
export function insertAcrossBlocks(view: EditorView, event: InputEvent): boolean {
  const { $from, $to } = view.state.selection;
  if (event.inputType !== "insertText" && event.inputType !== "insertReplacementText") return false;
  if ($from.sameParent($to)) return false;
  const text = event.data ?? event.dataTransfer?.getData("text/plain");
  if (!text) return false;
  event.preventDefault();
  const insert = () => view.state.tr.insertText(text);
  if (!view.someProp("handleTextInput", (f) => f(view, $from.pos, $to.pos, text, insert)))
    view.dispatch(insert().scrollIntoView());
  return true;
}
