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
import { enrichAcceptClosureOperationIds } from "./branch-review-closure.js";
import {
  type ClockRange,
  computeDraftReviewOperations,
  type IndexedDraftUpdate,
} from "./draft-review-operations.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";
import { encodeTrailPosition, rootRelativePosition } from "./trail-read-kernel.js";

const TEXT_DIFF_BLOCK_TYPES = new Set(["paragraph", "heading"]);

type YId = { client: number; clock: number };

type DraftWordDelta = { wordsAdded: number; wordsRemoved: number };

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
  partitionClosureClasses?: boolean;
};

export type DraftReviewHunkResult = {
  operations: DraftReviewOperationInternal[];
  hunks: DraftReviewHunkInternal[];
  wordDelta: DraftWordDelta;
};

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  if (blockContentShapesMatch(liveBlocks, draftBlocks)) {
    return { operations: [], hunks: [], wordDelta: { wordsAdded: 0, wordsRemoved: 0 } };
  }
  const alignment = alignBlocks(liveBlocks, draftBlocks);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const rawByHunkId = new Map<string, RawHunk>();
  const { hunks, operations: rawOperations } = computeDraftReviewOperations({
    baseDoc: input.liveDoc,
    updates: input.draftUpdates,
    hunks: rawHunks.map((hunk, index) => {
      const hunkId = `h${index + 1}`;
      rawByHunkId.set(hunkId, hunk);
      return {
        raw: operationGraphRaw(hunk),
        review: reviewHunkFromRaw(hunk, hunkId),
      };
    }),
  });
  const visible = cancelRestorativeRejectBlockHunks({
    hunks,
    operations: rawOperations,
    rawByHunkId,
  });
  const visibleRawHunks = visible.hunks
    .map((hunk) => rawByHunkId.get(hunk.hunkId))
    .filter((hunk): hunk is RawHunk => hunk !== undefined);
  const operations = enrichAcceptClosureOperationIds({
    operations: visible.operations,
    hunks: visible.hunks,
    updates: input.draftUpdates,
    partitionClasses: input.partitionClosureClasses,
  });
  const operationKind = new Map(
    operations.map((operation) => [operation.operationId, operation.kind]),
  );
  return {
    operations,
    hunks: visible.hunks.map((hunk) => ({
      ...hunk,
      ...(hasAgentAndWriter(hunk.operationIds, operationKind) ? { mergeArtifact: true } : {}),
    })),
    wordDelta: sumDraftWordDelta(visibleRawHunks.map(hunkDisplayText)),
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

type RawHunkBase = {
  anchor: { relStart: string; relEnd: string };
  blockKey: string;
  blockIndex: number;
};

type RawTextHunk = RawHunkBase & {
  kind: "text";
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  insertedLength: number;
  insertedText: string;
  deletedText: string;
};

type RawBlockDisplay = { type: string; display: string; ranges: ClockRange[] };

type RawBlockHunk = RawHunkBase & {
  kind: "block";
  blockSlot?: BlockSlot;
  insertedBlock?: RawBlockDisplay;
  deletedBlock?: RawBlockDisplay;
};

type RawHunk = RawTextHunk | RawBlockHunk;

type BlockSlot = { beforeBlockId: string | null; afterBlockId: string | null };

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
        isTextInsertHunk(entry.draft)
          ? textInsertHunk(entry.draft, draftDoc, blockIndex)
          : blockInsertHunk(
              entry.draft,
              draftDoc,
              blockIndex,
              draftBlockSlot(alignment, blockIndex),
            ),
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
  return hunks.filter(hunkHasVisibleChange);
}

function hunkHasVisibleChange(hunk: RawHunk): boolean {
  switch (hunk.kind) {
    case "text":
      return hunk.insertedLength > 0 || hunk.deletedText.length > 0;
    case "block":
      return hunk.insertedBlock !== undefined || hunk.deletedBlock !== undefined;
  }
}

function isTextDiffBlock(block: BlockInfo): boolean {
  return TEXT_DIFF_BLOCK_TYPES.has(block.type);
}

function isTextInsertHunk(block: BlockInfo): boolean {
  return isTextDiffBlock(block) && block.text.length > 0;
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

function blockInsertHunk(
  draft: BlockInfo,
  draftDoc: Y.Doc,
  blockIndex: number,
  blockSlot?: BlockSlot,
): RawHunk {
  const insertedBlock = displayBlock(draft);
  return {
    kind: "block",
    anchor: anchorForWholeBlock(draft, draftDoc),
    insertedBlock: { ...insertedBlock, ranges: wholeBlockRanges(draft) },
    blockKey: draft.id,
    blockIndex,
    ...(blockSlot ? { blockSlot } : {}),
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
    deletedBlock: { ...deletedBlock, ranges: wholeBlockRanges(live) },
    blockKey: live.id,
    blockIndex,
    blockSlot: liveBlockSlot(alignment, blockIndex),
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
    insertedBlock: { ...insertedBlock, ranges: wholeBlockRanges(draft) },
    deletedBlock: { ...deletedBlock, ranges: wholeBlockRanges(live) },
    blockKey: draft.id,
    blockIndex,
  };
}

function operationGraphRaw(hunk: RawHunk): {
  insertedRanges: readonly ClockRange[];
  deletedRanges: readonly ClockRange[];
  insertedText: string;
  deletedText: string;
  blockKey: string;
  blockIndex: number;
} {
  return {
    insertedRanges: hunkInsertedRanges(hunk),
    deletedRanges: hunkDeletedRanges(hunk),
    ...hunkDisplayText(hunk),
    blockKey: hunk.blockKey,
    blockIndex: hunk.blockIndex,
  };
}

function reviewHunkFromRaw(hunk: RawHunk, hunkId: string): DraftReviewHunkInternal {
  switch (hunk.kind) {
    case "text":
      return {
        kind: "text",
        hunkId,
        operationIds: [],
        blockHashes: [hunk.blockKey],
        anchor: hunk.anchor,
        spans: [],
        ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
      };
    case "block":
      return {
        kind: "block",
        hunkId,
        operationIds: [],
        blockHashes: [hunk.blockKey],
        anchor: hunk.anchor,
        ...(hunk.insertedBlock ? { insertedBlock: reviewBlockDisplay(hunk.insertedBlock) } : {}),
        ...(hunk.deletedBlock ? { deletedBlock: reviewBlockDisplay(hunk.deletedBlock) } : {}),
      };
  }
}

function hunkInsertedRanges(hunk: RawHunk): readonly ClockRange[] {
  switch (hunk.kind) {
    case "text":
      return hunk.insertedRanges;
    case "block":
      return hunk.insertedBlock?.ranges ?? [];
  }
}

function hunkDeletedRanges(hunk: RawHunk): readonly ClockRange[] {
  switch (hunk.kind) {
    case "text":
      return hunk.deletedRanges;
    case "block":
      return hunk.deletedBlock?.ranges ?? [];
  }
}

function hunkDisplayText(hunk: RawHunk): { insertedText: string; deletedText: string } {
  switch (hunk.kind) {
    case "text":
      return { insertedText: hunk.insertedText, deletedText: hunk.deletedText };
    case "block":
      return {
        insertedText: hunk.insertedBlock?.display ?? "",
        deletedText: hunk.deletedBlock?.display ?? "",
      };
  }
}

function reviewBlockDisplay(block: RawBlockDisplay): { type: string; display: string } {
  return { type: block.type, display: block.display };
}

function cancelRestorativeRejectBlockHunks(input: {
  hunks: DraftReviewHunkInternal[];
  operations: DraftReviewOperationInternal[];
  rawByHunkId: ReadonlyMap<string, RawHunk>;
}): { hunks: DraftReviewHunkInternal[]; operations: DraftReviewOperationInternal[] } {
  const operationsById = new Map(
    input.operations.map((operation) => [operation.operationId, operation]),
  );
  const cancelled = new Set<string>();

  for (let leftIndex = 0; leftIndex < input.hunks.length; leftIndex += 1) {
    const left = input.hunks[leftIndex];
    if (!left || cancelled.has(left.hunkId)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < input.hunks.length; rightIndex += 1) {
      const right = input.hunks[rightIndex];
      if (!right || cancelled.has(right.hunkId)) continue;
      if (!isRestorativeRejectPair(left, right, input.rawByHunkId, operationsById)) continue;
      cancelled.add(left.hunkId);
      cancelled.add(right.hunkId);
      break;
    }
  }

  if (cancelled.size === 0) return { hunks: input.hunks, operations: input.operations };

  const hunks = input.hunks.filter((hunk) => !cancelled.has(hunk.hunkId));
  const visibleOperationIds = new Set(hunks.flatMap((hunk) => hunk.operationIds));
  const operations = input.operations
    .filter((operation) => visibleOperationIds.has(operation.operationId))
    .map((operation) => ({
      ...operation,
      hunkCount: hunks.filter((hunk) => hunk.operationIds.includes(operation.operationId)).length,
    }));
  return { hunks, operations };
}

function isRestorativeRejectPair(
  left: DraftReviewHunkInternal,
  right: DraftReviewHunkInternal,
  rawByHunkId: ReadonlyMap<string, RawHunk>,
  operationsById: ReadonlyMap<string, DraftReviewOperationInternal>,
): boolean {
  const leftRaw = rawByHunkId.get(left.hunkId);
  const rightRaw = rawByHunkId.get(right.hunkId);
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw.kind !== "block" || rightRaw.kind !== "block") return false;
  if (!sameBlockSlot(leftRaw.blockSlot, rightRaw.blockSlot)) return false;
  const pair = restorativeRejectPairDirection(leftRaw, rightRaw);
  if (!pair) return false;

  const deleteHunk = pair.deleteSide === "left" ? left : right;
  const insertHunk = pair.insertSide === "left" ? left : right;
  if (deleteHunk === insertHunk) return false;

  return (
    hasOnlyOperationsOfKind(deleteHunk, operationsById, "agent") &&
    hasOnlyOperationsOfKind(insertHunk, operationsById, "writer")
  );
}

function hasOnlyOperationsOfKind(
  hunk: DraftReviewHunkInternal,
  operationsById: ReadonlyMap<string, DraftReviewOperationInternal>,
  kind: "agent" | "writer",
): boolean {
  return (
    hunk.operationIds.length > 0 &&
    hunk.operationIds.every((operationId) => operationsById.get(operationId)?.kind === kind)
  );
}

function sameBlockSlot(left: BlockSlot | undefined, right: BlockSlot | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.beforeBlockId === right.beforeBlockId &&
    left.afterBlockId === right.afterBlockId
  );
}

function restorativeRejectPairDirection(
  left: RawBlockHunk,
  right: RawBlockHunk,
): { deleteSide: "left" | "right"; insertSide: "left" | "right" } | null {
  const leftDeletedMatchesRightInserted = blocksDisplayEqual(
    left.deletedBlock,
    right.insertedBlock,
  );
  if (leftDeletedMatchesRightInserted) return { deleteSide: "left", insertSide: "right" };

  const rightDeletedMatchesLeftInserted = blocksDisplayEqual(
    right.deletedBlock,
    left.insertedBlock,
  );
  if (rightDeletedMatchesLeftInserted) return { deleteSide: "right", insertSide: "left" };

  return null;
}

function blocksDisplayEqual(
  left: { type: string; display: string } | undefined,
  right: { type: string; display: string } | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.type === right.type &&
    left.display === right.display
  );
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
      const length = node.length;
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
    const visibleLength = visibleTextItemLength(item);
    const id = itemId(item);
    if (!item.deleted && id && visibleLength > 0) {
      ranges.push({ client: id.client, clock: id.clock, length: visibleLength });
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

function liveBlockForAlignmentEntry(entry: AlignmentEntry | undefined): BlockInfo | null {
  if (!entry) return null;
  return entry.kind === "equal" || entry.kind === "change" || entry.kind === "delete"
    ? entry.live
    : null;
}

function draftBlockSlot(alignment: readonly AlignmentEntry[], blockIndex: number): BlockSlot {
  return blockSlot(alignment, blockIndex, draftBlockForAlignmentEntry);
}

function liveBlockSlot(alignment: readonly AlignmentEntry[], blockIndex: number): BlockSlot {
  return blockSlot(alignment, blockIndex, liveBlockForAlignmentEntry);
}

function blockSlot(
  alignment: readonly AlignmentEntry[],
  blockIndex: number,
  blockForEntry: (entry: AlignmentEntry | undefined) => BlockInfo | null,
): BlockSlot {
  let beforeBlockId: string | null = null;
  for (let index = blockIndex - 1; index >= 0; index -= 1) {
    const block = blockForEntry(alignment[index]);
    if (!block) continue;
    beforeBlockId = block.id;
    break;
  }

  let afterBlockId: string | null = null;
  for (let index = blockIndex + 1; index < alignment.length; index += 1) {
    const block = blockForEntry(alignment[index]);
    if (!block) continue;
    afterBlockId = block.id;
    break;
  }

  return { beforeBlockId, afterBlockId };
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
  return rootRelativePosition(doc, blockIndexInFragment(block, doc));
}

function relativePositionAfterBlock(block: BlockInfo, doc: Y.Doc): Y.RelativePosition {
  return rootRelativePosition(doc, blockIndexInFragment(block, doc) + 1);
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
  return encodeTrailPosition(position);
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

function visibleTextItemLength(item: ItemLike): number {
  return typeof item.content?.str === "string" ? item.content.str.length : 0;
}

function hasAgentAndWriter(
  operationIds: readonly string[],
  operationKind: ReadonlyMap<string, "agent" | "writer">,
): boolean {
  const kinds = new Set(operationIds.map((operationId) => operationKind.get(operationId)));
  return kinds.has("agent") && kinds.has("writer");
}

function sumDraftWordDelta(
  hunks: readonly { insertedText: string; deletedText: string }[],
): DraftWordDelta {
  return hunks.reduce(
    (total, hunk) => ({
      wordsAdded: total.wordsAdded + countWords(hunk.insertedText),
      wordsRemoved: total.wordsRemoved + countWords(hunk.deletedText),
    }),
    { wordsAdded: 0, wordsRemoved: 0 },
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
