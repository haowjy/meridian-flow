import {
  type BlockId,
  changedBlocks,
  type RoomDocs,
  type ShapeBlock,
  type WordPart,
  wordDiff,
} from "@meridian/document-model";

/**
 * One paragraph of a change as Review changes paints it: the reference's text (Live's, another
 * draft's or another file's) above or beside the draft's, the words each side alone has marked.
 * `kind` says which sides hold it.
 */
export type ReviewParagraph = {
  /** The draft's paragraph; for a `removed` one, the reference's. */
  id: BlockId;
  kind: "edited" | "added" | "removed";
  /** The reference's paragraph; null when the draft added it. */
  reference: TextBlock | null;
  /** The words of the reference's text and the draft's, aligned; empty for an added or removed paragraph. */
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
  /** Every paragraph is the reference's alone: the pair offers Restore in place of Discard. */
  removed: boolean;
};

export type TextBlock = Extract<ShapeBlock, { kind: "text" }>;

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
 * Reading order over both sides by block id: a block only the reference holds sorts after the
 * draft block before it. `anchorFrom` is the first draft block at or after a place in that order.
 */
function readingOrder(reference: Map<BlockId, TextBlock>, fork: Map<BlockId, TextBlock>) {
  const merged: BlockId[] = [];
  const referenceIds = [...reference.keys()];
  const referenceIndex = new Map(referenceIds.map((id, index) => [id, index]));
  let cursor = 0;
  const takeUpTo = (end: number) => {
    for (; cursor < end; cursor++)
      if (!fork.has(referenceIds[cursor])) merged.push(referenceIds[cursor]);
  };
  for (const id of fork.keys()) {
    const index = referenceIndex.get(id);
    if (index !== undefined && index >= cursor) {
      takeUpTo(index);
      cursor = index + 1;
    }
    merged.push(id);
  }
  takeUpTo(referenceIds.length);
  const order = new Map(merged.map((id, index) => [id, index]));
  const anchorFrom = (index: number): BlockId | null => {
    for (let at = index; at < merged.length; at++) if (fork.has(merged[at])) return merged[at];
    return null;
  };
  return { merged, order, anchorFrom };
}

/** A row of one paragraph. */
function single(paragraph: ReviewParagraph, anchor: BlockId | null): ReviewRow {
  return {
    id: paragraph.id,
    paragraphs: [paragraph],
    anchor,
    removed: paragraph.kind === "removed",
  };
}

function paragraphOf(
  id: BlockId,
  reference: TextBlock | null,
  draft: TextBlock | null,
  before: BlockId | null,
): ReviewParagraph | null {
  if (reference && draft) {
    const words = wordDiff(blockText(reference), blockText(draft));
    if (words.every((part) => part.kind === "same") && reference.node === draft.node) return null;
    return { id, kind: "edited", reference, words, before: id };
  }
  if (draft) return { id, kind: "added", reference: null, words: [], before: id };
  if (reference) return { id, kind: "removed", reference, words: [], before };
  return null;
}

/** A 53-bit hash of `text`, as a number (cyrb53). */
export function textHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The id `Take` gives a paragraph it copies from another draft into `draft`: one Live and the
 * other draft never hold, so applying both drafts can't merge two paragraphs into one text, and
 * the same on every Take, so the copy pairs with where it came from (`draftDifferenceRows`).
 */
export function takenBlockId(source: BlockId, draft: string): BlockId {
  return `t${textHash(`${draft}\u0000${source}`).toString(36)}`;
}

/**
 * The draft's differences from another draft of the document, a row per differing paragraph in
 * reading order, aligned by block id: both drafts fork the same Live, so a paragraph keeps its id
 * in each, and one either draft took from the other has its source's id in `takenBlockId`.
 */
export function draftDifferenceRows(
  reference: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
  drafts: { own: string; other: string },
): ReviewRow[] {
  const forkText = textBlocks(fork);
  const takenByOther = new Map<BlockId, BlockId>();
  for (const id of forkText.keys()) takenByOther.set(takenBlockId(id, drafts.other), id);
  // Keyed by the draft paragraph each pairs with.
  const referenceText = new Map<BlockId, TextBlock>();
  for (const [id, block] of textBlocks(reference)) {
    const copy = takenBlockId(id, drafts.own);
    const pair = forkText.has(id) ? id : forkText.has(copy) ? copy : (takenByOther.get(id) ?? id);
    referenceText.set(pair, block);
  }
  const { merged, anchorFrom } = readingOrder(referenceText, forkText);
  const rows: ReviewRow[] = [];
  merged.forEach((id, index) => {
    const paragraph = paragraphOf(
      id,
      referenceText.get(id) ?? null,
      forkText.get(id) ?? null,
      anchorFrom(index),
    );
    if (paragraph) rows.push(single(paragraph, paragraph.before));
  });
  return rows;
}

/**
 * The draft's differences from another file, a row per differing paragraph: the two files' ids
 * share nothing, so paragraphs of equal text pair by their longest common subsequence, and the
 * unpaired ones between two pairs pair in order, the rest added or removed.
 */
export function fileDifferenceRows(
  reference: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
): ReviewRow[] {
  const left = [...textBlocks(reference).values()];
  const right = [...textBlocks(fork).values()];
  const leftText = left.map(blockText);
  const rightText = right.map(blockText);
  // lengths[i][j]: the longest common run of left[i..] and right[j..].
  const lengths = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      lengths[i][j] =
        leftText[i] === rightText[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const rows: ReviewRow[] = [];
  const gap = (fromLeft: number, toLeft: number, fromRight: number, toRight: number) => {
    const next = right[toRight]?.id ?? null;
    for (let k = 0; k < Math.max(toLeft - fromLeft, toRight - fromRight); k++) {
      const ref = fromLeft + k < toLeft ? left[fromLeft + k] : null;
      const draft = fromRight + k < toRight ? right[fromRight + k] : null;
      const paragraph = paragraphOf(draft?.id ?? (ref as TextBlock).id, ref, draft, next);
      if (paragraph) rows.push(single(paragraph, draft ? draft.id : next));
    }
  };
  let i = 0;
  let j = 0;
  let fromLeft = 0;
  let fromRight = 0;
  while (i < left.length && j < right.length) {
    if (leftText[i] === rightText[j]) {
      gap(fromLeft, i, fromRight, j);
      i++;
      j++;
      fromLeft = i;
      fromRight = j;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  gap(fromLeft, left.length, fromRight, right.length);
  return rows;
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
  const { order, anchorFrom } = readingOrder(liveText, forkText);

  const rows: (ReviewRow & { at: number })[] = [];
  for (const change of changedBlocks(draft)) {
    const paragraphs: ReviewParagraph[] = [];
    for (const id of change.blocks) {
      const paragraph = paragraphOf(
        id,
        liveText.get(id) ?? null,
        forkText.get(id) ?? null,
        anchorFrom(order.get(id) ?? 0),
      );
      if (paragraph) paragraphs.push(paragraph);
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
