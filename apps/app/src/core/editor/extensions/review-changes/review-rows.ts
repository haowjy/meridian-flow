import { type WordPart, wordDiff } from "@meridian/agent-edit/diff";
import {
  type BlockId,
  COMMENT_STYLE_PREFIX,
  type CommentBody,
  changedBlocks,
  type RoomDocs,
  type ShapeBlock,
  structureValues,
} from "@meridian/document-model";

/**
 * One block of a change as Review changes paints it: the reference's (Live's, another draft's or
 * another file's) above or beside the draft's, the words each side alone has marked. Any block is
 * one, a paragraph or one with no text of its own (a rule, an image, a list). `kind` says which
 * sides hold it, or what changed when its text did not: its place (`moved`), its attributes or
 * marks (`restyled`: a heading's level, a bold word), or a comment's body on it (`comment`).
 */
export type ReviewParagraph = {
  /**
   * The draft's block; for a `removed` one, the reference's; for a `comment`, the paragraph it is
   * on, or with none the comment's own id.
   */
  id: BlockId;
  kind: "edited" | "added" | "removed" | "moved" | "restyled" | "comment";
  /** The reference's block; null when the draft added it. */
  reference: ShapeBlock | null;
  /**
   * The words of the reference's text and the draft's, aligned (a `comment`'s: of its two
   * bodies); empty for an added or removed paragraph.
   */
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
  /** Every block and comment id of the change: a link may name it by any of them. */
  members?: readonly string[];
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
function readingOrder(
  reference: ReadonlyMap<BlockId, unknown>,
  fork: ReadonlyMap<BlockId, unknown>,
) {
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

/** Every block by id, containers included, in reading order. */
function allBlocks(blocks: readonly ShapeBlock[], into = new Map<BlockId, ShapeBlock>()) {
  for (const block of blocks) {
    into.set(block.id, block);
    if (block.kind === "container") allBlocks(block.children, into);
  }
  return into;
}

/** Same type, attributes and, for a paragraph, marks: what is left to differ is its place. */
const sameStyle = (a: ShapeBlock, b: ShapeBlock) =>
  a.node === b.node &&
  JSON.stringify(a.attrs) === JSON.stringify(b.attrs) &&
  (a.kind !== "text" || b.kind !== "text" || JSON.stringify(a.inline) === JSON.stringify(b.inline));

/**
 * A changed block as it is painted, on the block itself: added or removed whole, a paragraph's
 * words edited, else what changed of it when its text did not: its style, a comment's body on it
 * (`body`: the words of the change's comment it carries, if any), or its place. Null where neither
 * side shows it: a block inside one the draft removed, which that removal paints.
 */
function changedBlock(
  id: BlockId,
  reference: ShapeBlock | undefined,
  draft: ShapeBlock | undefined,
  before: BlockId | null,
  body: (block: TextBlock) => readonly WordPart[] | null,
): ReviewParagraph | null {
  if (reference && draft) {
    if (reference.kind === "text" && draft.kind === "text") {
      const words = wordDiff(blockText(reference), blockText(draft));
      if (words.some((part) => part.kind !== "same"))
        return { id, kind: "edited", reference, words, before: id };
    }
    if (!sameStyle(reference, draft))
      return { id, kind: "restyled", reference, words: [], before: id };
    const words = draft.kind === "text" ? body(draft) : null;
    if (words) return { id, kind: "comment", reference, words, before: id };
    return { id, kind: "moved", reference, words: [], before: id };
  }
  if (draft) return { id, kind: "added", reference: null, words: [], before: id };
  if (reference) return { id, kind: "removed", reference, words: [], before };
  return null;
}

/** Every block under `block`, at any depth. */
function descendants(block: ShapeBlock, into: BlockId[] = []): BlockId[] {
  if (block.kind === "container")
    for (const child of block.children) {
      into.push(child.id);
      descendants(child, into);
    }
  return into;
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

/** The first paragraph carrying comment `id`'s anchor. */
function carrierOf(text: ReadonlyMap<BlockId, TextBlock>, id: string): TextBlock | null {
  const style = `${COMMENT_STYLE_PREFIX}${id}`;
  for (const block of text.values())
    if (block.inline.some((item) => style in item.marks)) return block;
  return null;
}

const bodyOf = (docs: RoomDocs, comment: string) =>
  (structureValues(docs).value("comments", comment) as CommentBody | null | undefined)?.body ?? "";

/**
 * The draft's changes against Live, as rows in reading order: a row sits where its first draft
 * block is, and a row Live alone holds sits where Live has it, before the next block both show.
 * `live` and `fork` are the two sides' blocks as read now (`readDocument`). Every change
 * `changedBlocks` lists is a row, so the steps agree with the list's `changeCount`: each changed
 * block shows on itself, whatever it holds, and a comment body's change on the paragraph it is on.
 */
export function reviewRows(
  draft: RoomDocs,
  live: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
): ReviewRow[] {
  const liveText = textBlocks(live);
  const forkText = textBlocks(fork);
  const liveBlocks = allBlocks(live);
  const forkBlocks = allBlocks(fork);
  const { order, anchorFrom } = readingOrder(liveBlocks, forkBlocks);

  const rows: (ReviewRow & { at: number })[] = [];
  const bodyWords = (comment: string) =>
    wordDiff(bodyOf(draft.live ?? draft, comment), bodyOf(draft, comment));
  for (const change of changedBlocks(draft)) {
    const body = (block: TextBlock) => {
      const comment = change.comments.find((each) =>
        block.inline.some((item) => `${COMMENT_STYLE_PREFIX}${each}` in item.marks),
      );
      return comment === undefined ? null : bodyWords(comment);
    };
    const shown = new Map<BlockId, ReviewParagraph>();
    for (const id of change.blocks) {
      const block = changedBlock(
        id,
        liveBlocks.get(id),
        forkBlocks.get(id),
        anchorFrom(order.get(id) ?? 0),
        body,
      );
      if (block) shown.set(id, block);
    }
    // A container whose own blocks show the change (a list added with its items) shows nothing more.
    for (const [id, block] of shown) {
      const own = forkBlocks.get(id) ?? liveBlocks.get(id);
      if (block.kind !== "edited" && own && descendants(own).some((inner) => shown.has(inner)))
        shown.delete(id);
    }
    if (shown.size === 0) {
      // A comment body alone: on the paragraph it is on, or at the end where none holds it. Every
      // change of blocks shows one on a side (`changedBlocks`), so this one names a comment.
      const comment = change.comments[0] as string;
      const carrier = carrierOf(forkText, comment) ?? carrierOf(liveText, comment);
      const id = carrier?.id ?? comment;
      shown.set(id, {
        id,
        kind: "comment",
        reference: carrier ? (liveText.get(carrier.id) ?? null) : null,
        words: bodyWords(comment),
        before: !carrier
          ? null
          : forkText.has(carrier.id)
            ? carrier.id
            : anchorFrom(order.get(carrier.id) ?? 0),
      });
    }
    const sorted = [...shown.values()].sort(
      (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
    );
    const first = sorted[0];
    const at = order.get(first.id) ?? Infinity;
    const members = [...change.blocks, ...change.comments];
    rows.push({
      // A member's id, which the press names it by: a comment's paragraph may not be one.
      id: members.includes(first.id) ? first.id : members[0],
      members,
      paragraphs: sorted,
      anchor: first.kind === "comment" ? first.before : anchorFrom(at),
      removed: sorted.every((block) => block.kind === "removed"),
      at,
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows.map(({ at: _at, ...row }) => row);
}
