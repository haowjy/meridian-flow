import {
  type BlockId,
  changedBlocks,
  type RoomDocs,
  type ShapeBlock,
  type WordPart,
  wordDiff,
} from "@meridian/document-model";

/**
 * One paragraph of a change as Review changes paints it: Live's text above (or beside) the draft's,
 * the words each side alone has marked. `kind` says which sides hold it.
 */
export type ReviewParagraph = {
  id: BlockId;
  kind: "edited" | "added" | "removed";
  /** The Live paragraph, for the reference text; null when the draft added it. */
  live: Extract<ShapeBlock, { kind: "text" }> | null;
  /** The words of Live's text and the draft's, aligned; empty for an added or removed paragraph. */
  words: readonly WordPart[];
  /** The draft paragraph it paints before: itself, or for a removal the next one the draft holds; null at the end. */
  before: BlockId | null;
};

/**
 * One change of the draft (`changedBlocks`'s `BlockChange`): its paragraphs, in the order a reader
 * meets them. `id` is the id of one of its members, the one a press and the address name it by.
 */
export type ReviewRow = {
  id: string;
  paragraphs: readonly ReviewParagraph[];
  /** The draft paragraph the row paints before: its first, or for a removal the next both show; null at the end. */
  anchor: BlockId | null;
  /** Every paragraph is Live's alone: the pair offers Restore in place of Discard. */
  removed: boolean;
};

type TextBlock = Extract<ShapeBlock, { kind: "text" }>;

/** Each text block by id, in reading order. */
function textBlocks(blocks: readonly ShapeBlock[], into = new Map<BlockId, TextBlock>()) {
  for (const block of blocks)
    if (block.kind === "text") into.set(block.id, block);
    else textBlocks(block.children, into);
  return into;
}

export function blockText(block: TextBlock): string {
  let text = "";
  for (const item of block.inline) if (item.kind === "text") text += item.text;
  return text;
}

/**
 * The draft's changes against Live, as rows in reading order: a row sits where its first draft
 * paragraph is, and a row Live alone holds sits where Live has it, before the next paragraph both
 * show. `live` and `fork` are the two sides' blocks as read now (`readDocument`). A change that
 * holds no text paragraph (a comment body, a container's attributes) has no row to paint.
 */
export function reviewRows(
  draft: RoomDocs,
  live: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
): ReviewRow[] {
  const liveText = textBlocks(live);
  const forkText = textBlocks(fork);
  // Reading order over both sides: a block only Live holds sorts after the draft block before it.
  const merged: BlockId[] = [];
  const liveIds = [...liveText.keys()];
  const liveIndex = new Map(liveIds.map((id, index) => [id, index]));
  let liveCursor = 0;
  const takeLiveUpTo = (end: number) => {
    for (; liveCursor < end; liveCursor++)
      if (!forkText.has(liveIds[liveCursor])) merged.push(liveIds[liveCursor]);
  };
  for (const id of forkText.keys()) {
    const index = liveIndex.get(id);
    if (index !== undefined && index >= liveCursor) {
      takeLiveUpTo(index);
      liveCursor = index + 1;
    }
    merged.push(id);
  }
  takeLiveUpTo(liveIds.length);
  const order = new Map(merged.map((id, index) => [id, index]));
  const anchorFrom = (index: number): BlockId | null => {
    for (let at = index; at < merged.length; at++) if (forkText.has(merged[at])) return merged[at];
    return null;
  };

  const rows: (ReviewRow & { at: number })[] = [];
  for (const change of changedBlocks(draft)) {
    const paragraphs: ReviewParagraph[] = [];
    for (const id of change.blocks) {
      const before = liveText.get(id) ?? null;
      const after = forkText.get(id) ?? null;
      if (!before && !after) continue;
      if (before && after) {
        const words = wordDiff(blockText(before), blockText(after));
        if (words.every((part) => part.kind === "same") && before.node === after.node) continue;
        paragraphs.push({ id, kind: "edited", live: before, words, before: id });
      } else if (after) paragraphs.push({ id, kind: "added", live: null, words: [], before: id });
      else
        paragraphs.push({
          id,
          kind: "removed",
          live: before,
          words: [],
          before: anchorFrom(order.get(id) ?? 0),
        });
    }
    if (paragraphs.length === 0) continue;
    paragraphs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const at = order.get(paragraphs[0].id) ?? 0;
    rows.push({
      id: paragraphs[0].id,
      paragraphs,
      anchor: anchorFrom(at),
      removed: paragraphs.every((paragraph) => paragraph.kind === "removed"),
      at,
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows.map(({ at: _at, ...row }) => row);
}
