/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import { type AgentEditModel, type BlockRef, toDocHandle, unwrapBlock } from "@meridian/agent-edit";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  type Diff,
  makeDiff,
} from "@sanity/diff-match-patch";
import * as Y from "yjs";

const REWRITE_THRESHOLD = 0.6;
const HUNK_DENSITY_LIMIT_PER_1000_CHARS = 15;
const BLOCK_CHURN_THRESHOLD = 0.5;
const SUPPORTED_CHANGED_BLOCK_TYPES = new Set(["paragraph", "heading"]);

type YId = { client: number; clock: number };
type ClockRange = { client: number; clock: number; length: number };

type IndexedDraftUpdate = {
  id: number;
  actorTurnId: string | null;
  updateData: Uint8Array;
};

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
};

export type DraftReviewHunkResult =
  | {
      reviewMode: "inline";
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    }
  | { reviewMode: "panel"; fallbackReason: string };

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  const alignment = alignBlocks(liveBlocks, draftBlocks);
  const fallbackBeforeDiff = fallbackForBlockAlignment(alignment, liveBlocks, draftBlocks);
  if (fallbackBeforeDiff) return panel(fallbackBeforeDiff);

  const fallbackUnsupported = unsupportedChangedBlocks(alignment);
  if (fallbackUnsupported) return panel(fallbackUnsupported);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const textChars = Math.max(1, totalChars(liveBlocks), totalChars(draftBlocks));
  const changedChars = rawHunks.reduce(
    (sum, hunk) => sum + hunk.insertedLength + hunk.deletedText.length,
    0,
  );
  if (changedChars / textChars > REWRITE_THRESHOLD) return panel("rewrite_threshold");
  if ((rawHunks.length / textChars) * 1000 > HUNK_DENSITY_LIMIT_PER_1000_CHARS) {
    return panel("hunk_density");
  }

  const attribution = indexDraftUpdates(input.draftUpdates);
  const hunksWithOperations = rawHunks.map((hunk, index) => {
    const operationIds = operationIdsForHunk(hunk, attribution);
    return {
      hunkId: `h${index + 1}`,
      operationIds,
      anchor: hunk.anchor,
      ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
    } satisfies ReviewHunk;
  });
  const hunks = hunksWithOperations.filter((hunk) => hunk.operationIds.length > 0);
  const operations = operationsForHunks(hunks, attribution);
  return { reviewMode: "inline", operations, hunks };
}

type BlockInfo = {
  id: string;
  type: string;
  text: string;
  block: BlockRef;
  textSegments: TextSegment[];
};

type TextSegment = {
  text: Y.XmlText;
  start: number;
  length: number;
  itemRanges: ClockRange[];
};

type AlignmentEntry =
  | { kind: "equal"; live: BlockInfo; draft: BlockInfo }
  | { kind: "delete"; live: BlockInfo }
  | { kind: "insert"; draft: BlockInfo };

type RawHunk = {
  anchor: { relStart: string; relEnd: string };
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  insertedLength: number;
  deletedText: string;
};

type AttributionIndex = {
  byOperationId: Map<string, IndexedOperation>;
  introduced: RangeLookup;
  deleted: RangeLookup;
};

type IndexedOperation = {
  operationId: string;
  sourceUpdateIds: number[];
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
};

type RangeLookup = Map<number, Array<{ start: number; end: number; operationId: string }>>;

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
  liveBlocks: readonly Pick<BlockInfo, "id">[],
  draftBlocks: readonly Pick<BlockInfo, "id">[],
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
      entries.push({
        kind: "equal",
        live: liveBlocks[liveIndex] as BlockInfo,
        draft: draftBlocks[draftIndex] as BlockInfo,
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
  const churned = alignment.filter((entry) => entry.kind !== "equal").length;
  const total = Math.max(1, liveBlocks.length, draftBlocks.length);
  return churned / total > BLOCK_CHURN_THRESHOLD ? "block_churn" : null;
}

function unsupportedChangedBlocks(alignment: readonly AlignmentEntry[]): string | null {
  for (const entry of alignment) {
    if (entry.kind === "equal" && entry.live.text === entry.draft.text) continue;
    const blocks =
      entry.kind === "equal"
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
  for (const entry of alignment) {
    if (entry.kind === "insert") {
      hunks.push({
        anchor: anchorForBlockRange(entry.draft, 0, entry.draft.text.length, draftDoc),
        insertedRanges: rangesForTextRange(entry.draft, 0, entry.draft.text.length),
        deletedRanges: [],
        insertedLength: entry.draft.text.length,
        deletedText: "",
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
      });
      continue;
    }
    if (entry.live.text === entry.draft.text) continue;
    hunks.push(...diffChangedBlock(entry.live, entry.draft, draftDoc));
  }
  return hunks.filter((hunk) => hunk.insertedLength > 0 || hunk.deletedText.length > 0);
}

function diffChangedBlock(live: BlockInfo, draft: BlockInfo, draftDoc: Y.Doc): RawHunk[] {
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

function indexDraftUpdates(updates: readonly IndexedDraftUpdate[]): AttributionIndex {
  const byOperationId = new Map<string, IndexedOperation>();
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const writerUpdateIds: number[] = [];

  for (const update of updates) {
    const operationId = update.actorTurnId ? String(update.id) : "writer:draft";
    if (update.actorTurnId) {
      byOperationId.set(operationId, {
        operationId,
        sourceUpdateIds: [update.id],
        actorTurnId: update.actorTurnId,
        kind: "agent",
      });
    } else {
      writerUpdateIds.push(update.id);
      byOperationId.set("writer:draft", {
        operationId: "writer:draft",
        sourceUpdateIds: writerUpdateIds,
        kind: "writer",
      });
    }

    const decoded = Y.decodeUpdate(update.updateData);
    for (const struct of decoded.structs) {
      const id = structId(struct);
      const length = structLength(struct);
      if (id && length > 0) addLookupRange(introduced, id.client, id.clock, length, operationId);
    }
    for (const [client, ranges] of decoded.ds.clients) {
      for (const range of ranges) {
        addLookupRange(deleted, client, range.clock, range.len, operationId);
      }
    }
  }
  return { byOperationId, introduced, deleted };
}

function operationIdsForHunk(hunk: RawHunk, attribution: AttributionIndex): string[] {
  const ids = new Set<string>();
  for (const range of hunk.insertedRanges)
    addMatchingOperations(ids, attribution.introduced, range);
  for (const range of hunk.deletedRanges) addMatchingOperations(ids, attribution.deleted, range);
  return [...ids].sort();
}

function operationsForHunks(
  hunks: readonly ReviewHunk[],
  attribution: AttributionIndex,
): ReviewOperation[] {
  const hunkCounts = new Map<string, number>();
  for (const hunk of hunks) {
    for (const operationId of hunk.operationIds) {
      hunkCounts.set(operationId, (hunkCounts.get(operationId) ?? 0) + 1);
    }
  }
  return [...hunkCounts.entries()]
    .map(([operationId, hunkCount]) => {
      const operation = attribution.byOperationId.get(operationId);
      if (!operation) return null;
      return { ...operation, hunkCount } satisfies ReviewOperation;
    })
    .filter((operation): operation is ReviewOperation => operation !== null)
    .sort((a, b) => a.operationId.localeCompare(b.operationId));
}

function addMatchingOperations(ids: Set<string>, lookup: RangeLookup, range: ClockRange): void {
  const candidates = lookup.get(range.client) ?? [];
  const start = range.clock;
  const end = range.clock + range.length;
  for (const candidate of candidates) {
    if (candidate.start < end && start < candidate.end) ids.add(candidate.operationId);
  }
}

function addLookupRange(
  lookup: RangeLookup,
  client: number,
  clock: number,
  length: number,
  operationId: string,
): void {
  const ranges = lookup.get(client) ?? [];
  ranges.push({ start: clock, end: clock + length, operationId });
  lookup.set(client, ranges);
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
    const draft = entry.kind === "equal" || entry.kind === "insert" ? entry.draft : null;
    if (draft) return anchorForBlockRange(draft, 0, 0, draftDoc);
  }
  for (let index = liveIndex - 1; index >= 0; index -= 1) {
    const entry = alignment[index];
    const draft = entry.kind === "equal" || entry.kind === "insert" ? entry.draft : null;
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

function structId(struct: unknown): YId | null {
  const id = (struct as { id?: { client: number; clock: number } }).id;
  return id ? { client: id.client, clock: id.clock } : null;
}

function structLength(struct: unknown): number {
  return Number((struct as { length?: number }).length ?? 0);
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
