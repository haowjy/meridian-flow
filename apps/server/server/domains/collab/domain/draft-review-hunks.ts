/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import { type AgentEditModel, type BlockRef, toDocHandle, unwrapBlock } from "@meridian/agent-edit";
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  type Diff,
  makeDiff,
} from "@sanity/diff-match-patch";
import * as Y from "yjs";
import { enrichAcceptClosureOperationIds } from "./draft-accept-closure.js";
import {
  type ClockRange,
  computeDraftReviewOperations,
  type IndexedDraftUpdate,
} from "./draft-review-operations.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

const TEXT_DIFF_BLOCK_TYPES = new Set(["paragraph", "heading"]);

type YId = { client: number; clock: number };

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
};

export type DraftReviewHunkResult = {
  operations: DraftReviewOperationInternal[];
  hunks: DraftReviewHunkInternal[];
};

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  if (blockContentShapesMatch(liveBlocks, draftBlocks)) {
    return { operations: [], hunks: [] };
  }
  const alignment = alignBlocks(liveBlocks, draftBlocks);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const { hunks, operations } = computeDraftReviewOperations({
    baseDoc: input.liveDoc,
    updates: input.draftUpdates,
    hunks: rawHunks.map((hunk, index) => ({
      raw: hunk,
      review:
        hunk.kind === "text"
          ? ({
              kind: "text",
              hunkId: `h${index + 1}`,
              operationIds: [],
              anchor: hunk.anchor,
              spans: [],
              ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
            } satisfies DraftReviewHunkInternal)
          : ({
              kind: "block",
              hunkId: `h${index + 1}`,
              operationIds: [],
              anchor: hunk.anchor,
              ...(hunk.insertedBlock ? { insertedBlock: hunk.insertedBlock } : {}),
              ...(hunk.deletedBlock ? { deletedBlock: hunk.deletedBlock } : {}),
            } satisfies DraftReviewHunkInternal),
    })),
  });
  return {
    operations: enrichAcceptClosureOperationIds({
      operations,
      hunks,
      updates: input.draftUpdates,
    }),
    hunks,
  };
}

function blockContentShapesMatch(
  liveBlocks: readonly BlockInfo[],
  draftBlocks: readonly BlockInfo[],
): boolean {
  return (
    blockTexts(liveBlocks) === blockTexts(draftBlocks) ||
    (liveBlocks.length === draftBlocks.length &&
      liveBlocks.every(
        (liveBlock, index) =>
          liveBlock.type === draftBlocks[index]?.type &&
          liveBlock.text === draftBlocks[index]?.text,
      ))
  );
}

function blockTexts(blocks: readonly BlockInfo[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}

type BlockInfo = {
  id: string;
  type: string;
  text: string;
  block: BlockRef;
  textSegments: TextSegment[];
};

type BlockAlignmentInput = { id: string; text?: string };

type TextSegment = {
  text: Y.XmlText;
  start: number;
  length: number;
  itemRanges: ClockRange[];
};

type AlignmentEntry =
  | { kind: "equal"; live: BlockInfo; draft: BlockInfo }
  | { kind: "change"; live: BlockInfo; draft: BlockInfo }
  | { kind: "delete"; live: BlockInfo }
  | { kind: "insert"; draft: BlockInfo };

type RawHunk = {
  kind: "text" | "block";
  anchor: { relStart: string; relEnd: string };
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  insertedLength: number;
  insertedText: string;
  deletedText: string;
  blockKey: string;
  blockIndex: number;
  insertedBlock?: { type: string; display: string };
  deletedBlock?: { type: string; display: string };
};

function describeBlocks(doc: Y.Doc, model: AgentEditModel): BlockInfo[] {
  return model.getBlocks(toDocHandle(doc)).map((block) => ({
    id: model.getBlockId(block),
    type: model.getBlockType(block),
    text: model.getText(block),
    block,
    textSegments: collectTextSegments(unwrapBlock(block)),
  }));
}

function alignBlocks(
  liveBlocks: readonly BlockAlignmentInput[],
  draftBlocks: readonly BlockAlignmentInput[],
): AlignmentEntry[] {
  const lengths = lcsLengths(
    liveBlocks.map((block) => block.id),
    draftBlocks.map((block) => block.id),
  );
  const entries: AlignmentEntry[] = [];
  let liveIndex = 0;
  let draftIndex = 0;
  while (liveIndex < liveBlocks.length && draftIndex < draftBlocks.length) {
    if (liveBlocks[liveIndex].id === draftBlocks[draftIndex].id) {
      const live = liveBlocks[liveIndex] as BlockInfo;
      const draft = draftBlocks[draftIndex] as BlockInfo;
      entries.push({
        kind: blockContentMatches(live, draft) ? "equal" : "change",
        live,
        draft,
      });
      liveIndex += 1;
      draftIndex += 1;
    } else if (lengths[liveIndex + 1][draftIndex] >= lengths[liveIndex][draftIndex + 1]) {
      entries.push({ kind: "delete", live: liveBlocks[liveIndex] as BlockInfo });
      liveIndex += 1;
    } else {
      entries.push({ kind: "insert", draft: draftBlocks[draftIndex] as BlockInfo });
      draftIndex += 1;
    }
  }
  while (liveIndex < liveBlocks.length) {
    entries.push({ kind: "delete", live: liveBlocks[liveIndex] as BlockInfo });
    liveIndex += 1;
  }
  while (draftIndex < draftBlocks.length) {
    entries.push({ kind: "insert", draft: draftBlocks[draftIndex] as BlockInfo });
    draftIndex += 1;
  }
  return entries;
}

function blockContentMatches(live: BlockAlignmentInput, draft: BlockAlignmentInput): boolean {
  return live.text === undefined || draft.text === undefined || live.text === draft.text;
}

function lcsLengths(left: readonly string[], right: readonly string[]): number[][] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  return lengths;
}

function diffAlignedBlocks(alignment: readonly AlignmentEntry[], draftDoc: Y.Doc): RawHunk[] {
  const hunks: RawHunk[] = [];
  for (const [blockIndex, entry] of alignment.entries()) {
    if (entry.kind === "insert") {
      hunks.push(
        isTextDiffBlock(entry.draft)
          ? textInsertHunk(entry.draft, draftDoc, blockIndex)
          : blockInsertHunk(entry.draft, draftDoc, blockIndex),
      );
      continue;
    }
    if (entry.kind === "delete") {
      hunks.push(
        isTextDiffBlock(entry.live)
          ? textDeleteHunk(entry.live, alignment, draftDoc, blockIndex)
          : blockDeleteHunk(entry.live, alignment, draftDoc, blockIndex),
      );
      continue;
    }
    if (entry.kind === "change") {
      hunks.push(
        ...(isTextDiffBlock(entry.live) && isTextDiffBlock(entry.draft)
          ? diffChangedBlock(entry.live, entry.draft, draftDoc, blockIndex)
          : [blockChangeHunk(entry.live, entry.draft, draftDoc, blockIndex)]),
      );
    }
  }
  return hunks.filter((hunk) => hunk.insertedLength > 0 || hunk.deletedText.length > 0);
}

function isTextDiffBlock(block: BlockInfo): boolean {
  return TEXT_DIFF_BLOCK_TYPES.has(block.type);
}

function textInsertHunk(draft: BlockInfo, draftDoc: Y.Doc, blockIndex: number): RawHunk {
  return {
    kind: "text",
    anchor: anchorForBlockRange(draft, 0, draft.text.length, draftDoc),
    insertedRanges: rangesForTextRange(draft, 0, draft.text.length),
    deletedRanges: [],
    insertedLength: draft.text.length,
    insertedText: draft.text,
    deletedText: "",
    blockKey: draft.id,
    blockIndex,
  };
}

function textDeleteHunk(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
  blockIndex: number,
): RawHunk {
  return {
    kind: "text",
    anchor: zeroWidthAnchorNearDeletedBlock(live, alignment, draftDoc),
    insertedRanges: [],
    deletedRanges: rangesForTextRange(live, 0, live.text.length),
    insertedLength: 0,
    insertedText: "",
    deletedText: live.text,
    blockKey: live.id,
    blockIndex,
  };
}

function blockInsertHunk(draft: BlockInfo, draftDoc: Y.Doc, blockIndex: number): RawHunk {
  const insertedBlock = displayBlock(draft);
  return {
    kind: "block",
    anchor: anchorForWholeBlock(draft, draftDoc),
    insertedRanges: wholeBlockRanges(draft),
    deletedRanges: [],
    insertedLength: Math.max(1, insertedBlock.display.length),
    insertedText: insertedBlock.display,
    deletedText: "",
    insertedBlock,
    blockKey: draft.id,
    blockIndex,
  };
}

function blockDeleteHunk(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
  blockIndex: number,
): RawHunk {
  const deletedBlock = displayBlock(live);
  return {
    kind: "block",
    anchor: zeroWidthAnchorNearDeletedBlock(live, alignment, draftDoc),
    insertedRanges: [],
    deletedRanges: wholeBlockRanges(live),
    insertedLength: 0,
    insertedText: "",
    deletedText: deletedBlock.display,
    deletedBlock,
    blockKey: live.id,
    blockIndex,
  };
}

function blockChangeHunk(
  live: BlockInfo,
  draft: BlockInfo,
  draftDoc: Y.Doc,
  blockIndex: number,
): RawHunk {
  const insertedBlock = displayBlock(draft);
  const deletedBlock = displayBlock(live);
  return {
    kind: "block",
    anchor: anchorForWholeBlock(draft, draftDoc),
    insertedRanges: wholeBlockRanges(draft),
    deletedRanges: wholeBlockRanges(live),
    insertedLength: Math.max(1, insertedBlock.display.length),
    insertedText: insertedBlock.display,
    deletedText: deletedBlock.display,
    insertedBlock,
    deletedBlock,
    blockKey: draft.id,
    blockIndex,
  };
}

function wholeBlockRanges(block: BlockInfo): ClockRange[] {
  return [...blockItemRanges(block), ...rangesForTextRange(block, 0, block.text.length)];
}

function blockItemRanges(block: BlockInfo): ClockRange[] {
  const item = blockItem(unwrapBlock(block.block));
  const id = item ? itemId(item) : null;
  const length = item ? itemContentLength(item) : 0;
  return item && !item.deleted && id && length > 0
    ? [{ client: id.client, clock: id.clock, length }]
    : [];
}

function displayBlock(block: BlockInfo): { type: string; display: string } {
  const text = block.text.replace(/\s+/g, " ").trim();
  if (text.length > 0) return { type: block.type, display: text };
  if (block.type === "horizontal_rule") return { type: block.type, display: "───" };
  const xmlBlock = unwrapBlock(block.block);
  if (block.type === "image") {
    const alt = stringAttr(xmlBlock, "alt");
    if (alt) return { type: block.type, display: alt };
    const src = stringAttr(xmlBlock, "src");
    if (src) return { type: block.type, display: src.split("/").filter(Boolean).at(-1) ?? src };
  }
  return { type: block.type, display: humanizeBlockType(block.type) };
}

function stringAttr(element: Y.XmlElement, name: string): string | null {
  const value = element.getAttribute(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function humanizeBlockType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function diffChangedBlock(
  live: BlockInfo,
  draft: BlockInfo,
  draftDoc: Y.Doc,
  blockIndex: number,
): RawHunk[] {
  const diffs = cleanupSemantic(makeDiff(live.text, draft.text));
  const hunks: RawHunk[] = [];
  let liveOffset = 0;
  let draftOffset = 0;
  let current: {
    draftStart: number;
    draftEnd: number;
    deletedText: string;
    deletedRanges: ClockRange[];
    insertedRanges: ClockRange[];
    insertedLength: number;
    insertedText: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    hunks.push({
      kind: "text",
      anchor: anchorForBlockRange(draft, current.draftStart, current.draftEnd, draftDoc),
      insertedRanges: current.insertedRanges,
      deletedRanges: current.deletedRanges,
      insertedLength: current.insertedLength,
      insertedText: current.insertedText,
      deletedText: current.deletedText,
      blockKey: draft.id,
      blockIndex,
    });
    current = null;
  };

  for (const [op, text] of diffs as Diff[]) {
    if (op === DIFF_EQUAL) {
      flush();
      liveOffset += text.length;
      draftOffset += text.length;
      continue;
    }
    current ??= {
      draftStart: draftOffset,
      draftEnd: draftOffset,
      deletedText: "",
      deletedRanges: [],
      insertedRanges: [],
      insertedLength: 0,
      insertedText: "",
    };
    if (op === DIFF_DELETE) {
      current.deletedText += text;
      current.deletedRanges.push(...rangesForTextRange(live, liveOffset, liveOffset + text.length));
      liveOffset += text.length;
    } else if (op === DIFF_INSERT) {
      current.insertedRanges.push(
        ...rangesForTextRange(draft, draftOffset, draftOffset + text.length),
      );
      current.insertedLength += text.length;
      current.insertedText += text;
      current.draftEnd = draftOffset + text.length;
      draftOffset += text.length;
    }
  }
  flush();
  return hunks;
}

function collectTextSegments(block: Y.XmlElement): TextSegment[] {
  const segments: TextSegment[] = [];
  let offset = 0;
  const visit = (node: unknown) => {
    if (node instanceof Y.XmlText) {
      const length = node.toString().length;
      segments.push({ text: node, start: offset, length, itemRanges: textItemRanges(node) });
      offset += length;
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) visit(child);
    }
  };
  visit(block);
  return segments;
}

function textItemRanges(text: Y.XmlText): ClockRange[] {
  const ranges: ClockRange[] = [];
  let item = firstTextItem(text);
  while (item) {
    const contentLength = itemContentLength(item);
    const id = itemId(item);
    if (!item.deleted && id && contentLength > 0) {
      ranges.push({ client: id.client, clock: id.clock, length: contentLength });
    }
    item = item.right ?? null;
  }
  return ranges;
}

function rangesForTextRange(block: BlockInfo, start: number, end: number): ClockRange[] {
  if (end <= start) return [];
  const ranges: ClockRange[] = [];
  for (const segment of block.textSegments) {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.start + segment.length);
    if (overlapEnd <= overlapStart) continue;
    ranges.push(
      ...sliceSegmentRanges(segment, overlapStart - segment.start, overlapEnd - segment.start),
    );
  }
  return ranges;
}

function sliceSegmentRanges(segment: TextSegment, start: number, end: number): ClockRange[] {
  const ranges: ClockRange[] = [];
  let offset = 0;
  for (const range of segment.itemRanges) {
    const rangeStart = offset;
    const rangeEnd = offset + range.length;
    const overlapStart = Math.max(start, rangeStart);
    const overlapEnd = Math.min(end, rangeEnd);
    if (overlapEnd > overlapStart) {
      ranges.push({
        client: range.client,
        clock: range.clock + (overlapStart - rangeStart),
        length: overlapEnd - overlapStart,
      });
    }
    offset = rangeEnd;
  }
  return ranges;
}

function anchorForBlockRange(
  block: BlockInfo,
  start: number,
  end: number,
  doc: Y.Doc,
): { relStart: string; relEnd: string } {
  return {
    relStart: encodeRelativePosition(relativePositionForTextOffset(block, start, doc)),
    relEnd: encodeRelativePosition(relativePositionForTextOffset(block, end, doc)),
  };
}

function anchorForWholeBlock(block: BlockInfo, doc: Y.Doc): { relStart: string; relEnd: string } {
  const before = relativePositionBeforeBlock(block, doc);
  const after = relativePositionAfterBlock(block, doc);
  return { relStart: encodeRelativePosition(before), relEnd: encodeRelativePosition(after) };
}

function zeroWidthAnchorNearDeletedBlock(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
): { relStart: string; relEnd: string } {
  const liveIndex = alignment.findIndex((entry) => entry.kind === "delete" && entry.live === live);
  for (let index = liveIndex + 1; index < alignment.length; index += 1) {
    const draft = draftBlockForAlignmentEntry(alignment[index]);
    if (draft) return zeroWidthAnchorAtPosition(relativePositionBeforeBlock(draft, draftDoc));
  }
  for (let index = liveIndex - 1; index >= 0; index -= 1) {
    const draft = draftBlockForAlignmentEntry(alignment[index]);
    if (draft) return zeroWidthAnchorAtPosition(relativePositionAfterBlock(draft, draftDoc));
  }
  const fragment = draftDoc.getXmlFragment("prosemirror");
  if (fragment.length !== 0)
    throw new Error("Cannot anchor deleted block without a draft neighbor");
  return zeroWidthAnchorAtPosition(Y.createRelativePositionFromTypeIndex(fragment, 0));
}

function draftBlockForAlignmentEntry(entry: AlignmentEntry | undefined): BlockInfo | null {
  if (!entry) return null;
  return entry.kind === "equal" || entry.kind === "change" || entry.kind === "insert"
    ? entry.draft
    : null;
}

function zeroWidthAnchorAtPosition(position: Y.RelativePosition): {
  relStart: string;
  relEnd: string;
} {
  const encoded = encodeRelativePosition(position);
  return { relStart: encoded, relEnd: encoded };
}

function relativePositionForTextOffset(
  block: BlockInfo,
  offset: number,
  _doc: Y.Doc,
): Y.RelativePosition {
  const bounded = Math.max(0, Math.min(offset, block.text.length));
  for (const segment of block.textSegments) {
    if (bounded <= segment.start + segment.length) {
      return Y.createRelativePositionFromTypeIndex(segment.text, bounded - segment.start);
    }
  }
  throw new Error(`Cannot anchor text offset in block ${block.id} (${block.type}) without text`);
}

function relativePositionBeforeBlock(block: BlockInfo, doc: Y.Doc): Y.RelativePosition {
  return Y.createRelativePositionFromTypeIndex(
    prosemirrorFragment(doc),
    blockIndexInFragment(block, doc),
  );
}

function relativePositionAfterBlock(block: BlockInfo, doc: Y.Doc): Y.RelativePosition {
  return Y.createRelativePositionFromTypeIndex(
    prosemirrorFragment(doc),
    blockIndexInFragment(block, doc) + 1,
  );
}

function blockIndexInFragment(block: BlockInfo, doc: Y.Doc): number {
  const xmlBlock = unwrapBlock(block.block);
  const index = prosemirrorFragment(doc).toArray().indexOf(xmlBlock);
  if (index < 0) throw new Error(`Cannot anchor block ${block.id} (${block.type}); not in draft`);
  return index;
}

function prosemirrorFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment("prosemirror");
}

function encodeRelativePosition(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
}

function firstTextItem(text: Y.XmlText): ItemLike | null {
  return (text as unknown as { _start?: ItemLike | null })._start ?? null;
}

function blockItem(block: Y.XmlElement): ItemLike | null {
  return (block as unknown as { _item?: ItemLike | null })._item ?? null;
}

type ItemLike = {
  id: { client: number; clock: number };
  length?: number;
  deleted?: boolean;
  right?: ItemLike | null;
  content?: { str?: string; arr?: unknown[]; getLength?: () => number };
};

function itemId(item: ItemLike): YId | null {
  return item.id ? { client: item.id.client, clock: item.id.clock } : null;
}

function itemContentLength(item: ItemLike): number {
  if (typeof item.length === "number") return item.length;
  if (typeof item.content?.getLength === "function") return item.content.getLength();
  if (typeof item.content?.str === "string") return item.content.str.length;
  if (Array.isArray(item.content?.arr)) return item.content.arr.length;
  return 0;
}
