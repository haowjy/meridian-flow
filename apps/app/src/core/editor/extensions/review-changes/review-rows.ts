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

export type ReviewParagraph = {
  id: BlockId;
  kind: "edited" | "added" | "removed" | "moved" | "restyled" | "comment";
  reference: ShapeBlock | null;
  words: readonly WordPart[];
  before: BlockId | null;
};

export type ReviewRow = {
  id: string;
  members?: readonly string[];
  paragraphs: readonly ReviewParagraph[];
  anchor: BlockId | null;
  removed: boolean;
};

export type TextBlock = Extract<ShapeBlock, { kind: "text" }>;

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

function single(paragraph: ReviewParagraph, anchor: BlockId | null): ReviewRow {
  return {
    id: paragraph.id,
    paragraphs: [paragraph],
    anchor,
    removed: paragraph.kind === "removed",
  };
}

function allBlocks(blocks: readonly ShapeBlock[], into = new Map<BlockId, ShapeBlock>()) {
  for (const block of blocks) {
    into.set(block.id, block);
    if (block.kind === "container") allBlocks(block.children, into);
  }
  return into;
}

const sameStyle = (a: ShapeBlock, b: ShapeBlock) =>
  a.node === b.node &&
  JSON.stringify(a.attrs) === JSON.stringify(b.attrs) &&
  (a.kind !== "text" || b.kind !== "text" || JSON.stringify(a.inline) === JSON.stringify(b.inline));

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

export function draftDifferenceRows(
  reference: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
  drafts: { own: string; other: string },
): ReviewRow[] {
  const forkText = textBlocks(fork);
  const takenByOther = new Map<BlockId, BlockId>();
  for (const id of forkText.keys()) takenByOther.set(takenBlockId(id, drafts.other), id);
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

export function fileDifferenceRows(
  reference: readonly ShapeBlock[],
  fork: readonly ShapeBlock[],
): ReviewRow[] {
  const left = [...textBlocks(reference).values()];
  const right = [...textBlocks(fork).values()];
  const leftText = left.map(blockText);
  const rightText = right.map(blockText);
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

function carrierOf(text: ReadonlyMap<BlockId, TextBlock>, id: string): TextBlock | null {
  const style = `${COMMENT_STYLE_PREFIX}${id}`;
  for (const block of text.values())
    if (block.inline.some((item) => style in item.marks)) return block;
  return null;
}

const bodyOf = (docs: RoomDocs, comment: string) =>
  (structureValues(docs).value("comments", comment) as CommentBody | null | undefined)?.body ?? "";

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
    for (const [id, block] of shown) {
      const own = forkBlocks.get(id) ?? liveBlocks.get(id);
      if (block.kind !== "edited" && own && descendants(own).some((inner) => shown.has(inner)))
        shown.delete(id);
    }
    if (shown.size === 0) {
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
