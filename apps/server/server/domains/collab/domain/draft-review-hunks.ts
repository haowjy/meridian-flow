/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import { type AgentEditModel, type BlockRef, toDocHandle, unwrapBlock } from "@meridian/agent-edit";
import type {
  ReviewHunk,
  ReviewOperation,
  ReviewOperationContribution,
} from "@meridian/contracts/drafts";
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  type Diff,
  makeDiff,
} from "@sanity/diff-match-patch";
import * as Y from "yjs";
import {
  type ClockRange,
  type DraftOperationContributionFlags,
  type DraftUpdateAttributionIndex,
  type IndexedDraftUpdate,
  type IndexedOperation,
  indexDraftUpdates,
} from "./draft-update-attribution.js";

const REWRITE_THRESHOLD = 0.6;
const HUNK_DENSITY_LIMIT_PER_1000_CHARS = 15;
const BLOCK_CHURN_THRESHOLD = 0.5;
const SUPPORTED_CHANGED_BLOCK_TYPES = new Set(["paragraph", "heading"]);

type YId = { client: number; clock: number };

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
  requestedSurface?: "inline";
};

export type DraftReviewHunkResult =
  | {
      reviewMode: "inline" | "panel";
      fallbackReason?: string;
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    }
  | { reviewMode: "panel"; fallbackReason: string };

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  if (blockContentShapesMatch(liveBlocks, draftBlocks)) {
    return { reviewMode: "inline", operations: [], hunks: [] };
  }
  const alignment = alignBlocks(liveBlocks, draftBlocks);
  let softFallback = fallbackForBlockAlignment(alignment, liveBlocks, draftBlocks);
  if (softFallback && input.requestedSurface !== "inline") return panel(softFallback);

  const fallbackUnsupported = unsupportedChangedBlocks(alignment);
  if (fallbackUnsupported) return panel(fallbackUnsupported);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const textChars = Math.max(1, totalChars(liveBlocks), totalChars(draftBlocks));
  const changedChars = rawHunks.reduce(
    (sum, hunk) => sum + hunk.insertedLength + hunk.deletedText.length,
    0,
  );
  if (changedChars / textChars > REWRITE_THRESHOLD) softFallback ??= "rewrite_threshold";
  if ((rawHunks.length / textChars) * 1000 > HUNK_DENSITY_LIMIT_PER_1000_CHARS) {
    softFallback ??= "hunk_density";
  }
  if (softFallback && input.requestedSurface !== "inline") return panel(softFallback);

  const attribution = indexDraftUpdates({ baseDoc: input.liveDoc, updates: input.draftUpdates });
  const attributedHunks = rawHunks.map((hunk, index) => {
    const operationIds = operationIdsForHunk(hunk, attribution);
    return {
      raw: hunk,
      operationIds,
      review: {
        hunkId: `h${index + 1}`,
        operationIds,
        anchor: hunk.anchor,
        ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
      } satisfies ReviewHunk,
    };
  });
  const { hunks, operations } = groupOperationsForHunks(
    attributedHunks.filter((hunk) => hunk.operationIds.length > 0),
    attribution,
  );
  return {
    reviewMode: softFallback ? "panel" : "inline",
    ...(softFallback ? { fallbackReason: softFallback } : {}),
    operations,
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
  deletedText: string;
  blockKey: string;
  blockIndex: number;
};

type AttributedHunk = {
  raw: RawHunk;
  operationIds: string[];
  review: ReviewHunk;
};

type WriterGroup = {
  operationId: string;
  sourceUpdateIds: Set<number>;
  physicalSourceUpdateIds: Set<number>;
  contribution: DraftOperationContributionFlags;
  actorUserId: string;
  hunkIndexes: Set<number>;
  lastBlockKey: string;
  lastBlockIndex: number;
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

export function alignBlocks(
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

function fallbackForBlockAlignment(
  alignment: readonly AlignmentEntry[],
  liveBlocks: readonly BlockInfo[],
  draftBlocks: readonly BlockInfo[],
): string | null {
  const churned = alignment.filter(
    (entry) => entry.kind === "delete" || entry.kind === "insert",
  ).length;
  const total = Math.max(1, liveBlocks.length, draftBlocks.length);
  return churned / total > BLOCK_CHURN_THRESHOLD ? "block_churn" : null;
}

function unsupportedChangedBlocks(alignment: readonly AlignmentEntry[]): string | null {
  for (const entry of alignment) {
    if (entry.kind === "equal") continue;
    const blocks =
      entry.kind === "change"
        ? [entry.live, entry.draft]
        : [entry.kind === "delete" ? entry.live : entry.draft];
    if (blocks.some((block) => !SUPPORTED_CHANGED_BLOCK_TYPES.has(block.type))) {
      return "unsupported_node_type";
    }
  }
  return null;
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
  } | null = null;

  const flush = () => {
    if (!current) return;
    hunks.push({
      anchor: anchorForBlockRange(draft, current.draftStart, current.draftEnd, draftDoc),
      insertedRanges: current.insertedRanges,
      deletedRanges: current.deletedRanges,
      insertedLength: current.insertedLength,
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
      current.draftEnd = draftOffset + text.length;
      draftOffset += text.length;
    }
  }
  flush();
  return hunks;
}

function operationIdsForHunk(hunk: RawHunk, attribution: DraftUpdateAttributionIndex): string[] {
  return attribution.operationIdsForRanges({
    insertedRanges: hunk.insertedRanges,
    deletedRanges: hunk.deletedRanges,
  });
}

function groupOperationsForHunks(
  attributedHunks: readonly AttributedHunk[],
  attribution: DraftUpdateAttributionIndex,
): { hunks: ReviewHunk[]; operations: ReviewOperation[] } {
  const writerGroups: WriterGroup[] = [];
  const writerOperationIdsByHunk = new Map<number, Set<string>>();
  const contributionByOperationId = new Map<string, DraftOperationContributionFlags>();

  for (const [hunkIndex, hunk] of attributedHunks.entries()) {
    const hunkContributions = attribution.operationContributionsForRanges({
      insertedRanges: hunk.raw.insertedRanges,
      deletedRanges: hunk.raw.deletedRanges,
    });
    for (const [operationId, contribution] of hunkContributions) {
      mergeContribution(contributionByOperationId, operationId, contribution);
    }
    const writerOperations = hunk.operationIds
      .map((operationId) => attribution.byOperationId.get(operationId))
      .filter((operation): operation is IndexedOperation => operation?.kind === "writer");
    for (const [actorUserId, operations] of groupWriterOperationsByActor(writerOperations)) {
      let group = writerGroups.at(-1);
      if (!group || !canJoinWriterGroup(group, hunk.raw, actorUserId)) {
        group = {
          operationId: `writer:${writerGroups.length + 1}`,
          sourceUpdateIds: new Set(),
          physicalSourceUpdateIds: new Set(),
          contribution: { inserted: false, deleted: false },
          actorUserId,
          hunkIndexes: new Set(),
          lastBlockKey: hunk.raw.blockKey,
          lastBlockIndex: hunk.raw.blockIndex,
        };
        writerGroups.push(group);
      }
      for (const operation of operations) {
        for (const updateId of operation.sourceUpdateIds) group.sourceUpdateIds.add(updateId);
        for (const updateId of operation.physicalSourceUpdateIds) {
          group.physicalSourceUpdateIds.add(updateId);
        }
        const contribution = hunkContributions.get(operation.operationId);
        if (contribution) mergeContributionInto(group.contribution, contribution);
      }
      group.hunkIndexes.add(hunkIndex);
      group.lastBlockKey = hunk.raw.blockKey;
      group.lastBlockIndex = hunk.raw.blockIndex;
      const ids = writerOperationIdsByHunk.get(hunkIndex) ?? new Set<string>();
      ids.add(group.operationId);
      writerOperationIdsByHunk.set(hunkIndex, ids);
    }
  }

  const hunks = attributedHunks.map((hunk, hunkIndex) => {
    const agentOperationIds = hunk.operationIds.filter(
      (operationId) => attribution.byOperationId.get(operationId)?.kind !== "writer",
    );
    return {
      ...hunk.review,
      operationIds: [...agentOperationIds, ...(writerOperationIdsByHunk.get(hunkIndex) ?? [])].sort(
        operationSort,
      ),
    } satisfies ReviewHunk;
  });

  const hunkCounts = new Map<string, number>();
  for (const hunk of hunks) {
    for (const operationId of hunk.operationIds) {
      hunkCounts.set(operationId, (hunkCounts.get(operationId) ?? 0) + 1);
    }
  }
  const agentOperations: ReviewOperationWithPhysicalRows[] = [...hunkCounts.entries()]
    .flatMap(([operationId, hunkCount]) => {
      const operation = attribution.byOperationId.get(operationId);
      if (!operation || operation.kind === "writer") return [];
      return [
        {
          ...operation,
          rejectSourceUpdateIds: operation.physicalSourceUpdateIds,
          ...operationContribution(contributionByOperationId.get(operation.operationId)),
          hunkCount,
        },
      ];
    })
    .sort((a, b) => a.operationId.localeCompare(b.operationId));
  const writerOperations = writerGroups.map(
    (group) =>
      ({
        operationId: group.operationId,
        sourceUpdateIds: [...group.sourceUpdateIds].sort((a, b) => a - b),
        rejectSourceUpdateIds: [...group.physicalSourceUpdateIds].sort((a, b) => a - b),
        actorUserId: group.actorUserId,
        kind: "writer",
        ...operationContribution(group.contribution),
        hunkCount: group.hunkIndexes.size,
      }) satisfies ReviewOperation,
  );
  const operations = [...agentOperations, ...writerOperations].sort((a, b) =>
    operationSort(a.operationId, b.operationId),
  );
  return {
    hunks,
    operations: withRejectClosures(hunks, operations),
  };
}

type ReviewOperationWithPhysicalRows = ReviewOperation & { physicalSourceUpdateIds?: number[] };

export function withRejectClosures(
  hunks: readonly ReviewHunk[],
  operations: readonly ReviewOperationWithPhysicalRows[],
): ReviewOperation[] {
  const operationIdsByHunk = hunks.map((hunk) => new Set(hunk.operationIds));
  const hunkIndexesByOperation = new Map<string, number[]>();
  for (const [hunkIndex, operationIds] of operationIdsByHunk.entries()) {
    for (const operationId of operationIds) {
      hunkIndexesByOperation.set(operationId, [
        ...(hunkIndexesByOperation.get(operationId) ?? []),
        hunkIndex,
      ]);
    }
  }

  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
  const rejectSourceUpdateIdsByOperation = new Map<string, number[]>();
  for (const operation of operations) {
    if (rejectSourceUpdateIdsByOperation.has(operation.operationId)) continue;
    const closure = hunkSharingClosure(
      operation.operationId,
      operationIdsByHunk,
      hunkIndexesByOperation,
    );
    const physicalRejectRows = [
      ...new Set(
        [...closure].flatMap((operationId) => {
          const operation = operationsById.get(operationId);
          return operation?.physicalSourceUpdateIds ?? operation?.sourceUpdateIds ?? [];
        }),
      ),
    ].sort((a, b) => a - b);
    for (const operationId of closure)
      rejectSourceUpdateIdsByOperation.set(operationId, physicalRejectRows);
  }

  return operations.map((operation) => {
    const { physicalSourceUpdateIds: _physicalSourceUpdateIds, ...wireOperation } = operation;
    return {
      ...wireOperation,
      rejectSourceUpdateIds:
        rejectSourceUpdateIdsByOperation.get(operation.operationId) ?? operation.sourceUpdateIds,
    };
  });
}

function mergeContribution(
  contributions: Map<string, DraftOperationContributionFlags>,
  operationId: string,
  contribution: DraftOperationContributionFlags,
): void {
  const current = contributions.get(operationId) ?? { inserted: false, deleted: false };
  mergeContributionInto(current, contribution);
  contributions.set(operationId, current);
}

function mergeContributionInto(
  target: DraftOperationContributionFlags,
  contribution: DraftOperationContributionFlags,
): void {
  target.inserted ||= contribution.inserted;
  target.deleted ||= contribution.deleted;
}

function operationContribution(contribution: DraftOperationContributionFlags | undefined): {
  contribution?: ReviewOperationContribution;
} {
  if (!contribution) return {};
  if (contribution.inserted && contribution.deleted) return { contribution: "rewrote" };
  if (contribution.inserted) return { contribution: "added" };
  if (contribution.deleted) return { contribution: "removed" };
  return { contribution: "edited" };
}

function hunkSharingClosure(
  seedOperationId: string,
  operationIdsByHunk: readonly Set<string>[],
  hunkIndexesByOperation: ReadonlyMap<string, readonly number[]>,
): Set<string> {
  const closure = new Set<string>();
  const queue = [seedOperationId];
  while (queue.length > 0) {
    const operationId = queue.shift();
    if (!operationId || closure.has(operationId)) continue;
    closure.add(operationId);
    for (const hunkIndex of hunkIndexesByOperation.get(operationId) ?? []) {
      for (const nextOperationId of operationIdsByHunk[hunkIndex] ?? []) {
        if (!closure.has(nextOperationId)) queue.push(nextOperationId);
      }
    }
  }
  return closure;
}

function groupWriterOperationsByActor(
  operations: readonly IndexedOperation[],
): Map<string, IndexedOperation[]> {
  const byActor = new Map<string, IndexedOperation[]>();
  for (const operation of operations) {
    if (!operation.actorUserId) continue;
    byActor.set(operation.actorUserId, [...(byActor.get(operation.actorUserId) ?? []), operation]);
  }
  return byActor;
}

function canJoinWriterGroup(group: WriterGroup, hunk: RawHunk, actorUserId: string): boolean {
  if (group.actorUserId !== actorUserId) return false;
  return group.lastBlockKey === hunk.blockKey || hunk.blockIndex <= group.lastBlockIndex + 1;
}

function operationSort(left: string, right: string): number {
  const leftWriter = left.startsWith("writer:");
  const rightWriter = right.startsWith("writer:");
  if (leftWriter && rightWriter) return Number(left.slice(7)) - Number(right.slice(7));
  if (leftWriter !== rightWriter) return leftWriter ? 1 : -1;
  return left.localeCompare(right);
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

function totalChars(blocks: readonly BlockInfo[]): number {
  return blocks.reduce((sum, block) => sum + block.text.length, 0);
}

function panel(fallbackReason: string): DraftReviewHunkResult {
  return { reviewMode: "panel", fallbackReason };
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
