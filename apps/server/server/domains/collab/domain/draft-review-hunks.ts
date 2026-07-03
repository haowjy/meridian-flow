/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import { type AgentEditModel, type BlockRef, toDocHandle, unwrapBlock } from "@meridian/agent-edit";
import type { ReviewHunk } from "@meridian/contracts/drafts";
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
  type DraftReviewOperationInternal,
  type IndexedDraftUpdate,
} from "./draft-review-operations.js";

const SUPPORTED_CHANGED_BLOCK_TYPES = new Set(["paragraph", "heading"]);

type YId = { client: number; clock: number };

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
};

export type DraftReviewHunkResult =
  | { operations: DraftReviewOperationInternal[]; hunks: ReviewHunk[] }
  | { panelFallback: true };

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  if (blockContentShapesMatch(liveBlocks, draftBlocks)) {
    return { operations: [], hunks: [] };
  }
  const alignment = alignBlocks(liveBlocks, draftBlocks);
  if (unsupportedChangedBlocks(alignment)) return { panelFallback: true };

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const { hunks, operations } = computeDraftReviewOperations({
    baseDoc: input.liveDoc,
    updates: input.draftUpdates,
    hunks: rawHunks.map((hunk, index) => ({
      raw: hunk,
      review: {
        hunkId: `h${index + 1}`,
        operationIds: [],
        anchor: hunk.anchor,
        spans: [],
        ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
      } satisfies ReviewHunk,
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
  anchor: { relStart: string; relEnd: string };
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  insertedLength: number;
  insertedText: string;
  deletedText: string;
  blockKey: string;
  blockIndex: number;
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

function unsupportedChangedBlocks(alignment: readonly AlignmentEntry[]): boolean {
  for (const entry of alignment) {
    if (entry.kind === "equal") continue;
    const blocks =
      entry.kind === "change"
        ? [entry.live, entry.draft]
        : [entry.kind === "delete" ? entry.live : entry.draft];
    if (blocks.some((block) => !SUPPORTED_CHANGED_BLOCK_TYPES.has(block.type))) return true;
  }
  return false;
}

function diffAlignedBlocks(alignment: readonly AlignmentEntry[], draftDoc: Y.Doc): RawHunk[] {
  const hunks: RawHunk[] = [];
  for (const [blockIndex, entry] of alignment.entries()) {
    if (entry.kind === "insert") {
      hunks.push({
        anchor: anchorForBlockRange(entry.draft, 0, entry.draft.text.length, draftDoc),
        insertedRanges: rangesForTextRange(entry.draft, 0, entry.draft.text.length),
        deletedRanges: [],
        insertedLength: entry.draft.text.length,
        insertedText: entry.draft.text,
        deletedText: "",
        blockKey: entry.draft.id,
        blockIndex,
      });
      continue;
    }
    if (entry.kind === "delete") {
      hunks.push({
        anchor: zeroWidthAnchorNearDeletedBlock(entry.live, alignment, draftDoc),
        insertedRanges: [],
        deletedRanges: rangesForTextRange(entry.live, 0, entry.live.text.length),
        insertedLength: 0,
        insertedText: "",
        deletedText: entry.live.text,
        blockKey: entry.live.id,
        blockIndex,
      });
      continue;
    }
    if (entry.kind === "change") {
      hunks.push(...diffChangedBlock(entry.live, entry.draft, draftDoc, blockIndex));
    }
  }
  return hunks.filter((hunk) => hunk.insertedLength > 0 || hunk.deletedText.length > 0);
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

function zeroWidthAnchorNearDeletedBlock(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
): { relStart: string; relEnd: string } {
  const liveIndex = alignment.findIndex((entry) => entry.kind === "delete" && entry.live === live);
  for (let index = liveIndex + 1; index < alignment.length; index += 1) {
    const entry = alignment[index];
    const draft =
      entry.kind === "equal" || entry.kind === "change" || entry.kind === "insert"
        ? entry.draft
        : null;
    if (draft) return anchorForBlockRange(draft, 0, 0, draftDoc);
  }
  for (let index = liveIndex - 1; index >= 0; index -= 1) {
    const entry = alignment[index];
    const draft =
      entry.kind === "equal" || entry.kind === "change" || entry.kind === "insert"
        ? entry.draft
        : null;
    if (draft) return anchorForBlockRange(draft, draft.text.length, draft.text.length, draftDoc);
  }
  const fragment = draftDoc.getXmlFragment("prosemirror");
  const encoded = encodeRelativePosition(Y.createRelativePositionFromTypeIndex(fragment, 0));
  return { relStart: encoded, relEnd: encoded };
}

function relativePositionForTextOffset(
  block: BlockInfo,
  offset: number,
  doc: Y.Doc,
): Y.RelativePosition {
  const bounded = Math.max(0, Math.min(offset, block.text.length));
  for (const segment of block.textSegments) {
    if (bounded <= segment.start + segment.length) {
      return Y.createRelativePositionFromTypeIndex(segment.text, bounded - segment.start);
    }
  }
  const fragment = doc.getXmlFragment("prosemirror");
  return Y.createRelativePositionFromTypeIndex(fragment, 0);
}

function encodeRelativePosition(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
}

function firstTextItem(text: Y.XmlText): ItemLike | null {
  return (text as unknown as { _start?: ItemLike | null })._start ?? null;
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
