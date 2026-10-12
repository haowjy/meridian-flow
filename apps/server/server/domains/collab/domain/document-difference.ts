/** Computes identity-aware document differences, clock ranges and draft anchors. */
import { isDeepStrictEqual } from "node:util";
import {
  type AgentEditModel,
  type BlockRef,
  toDocHandle,
  unwrapBlock,
  wordHunks,
} from "@meridian/agent-edit/integration";
import type { ReviewFormattingChange } from "@meridian/contracts/drafts";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, type Diff } from "@sanity/diff-match-patch";
import * as Y from "yjs";
import {
  documentEffectsEqual,
  richDifference,
  textContentShape,
  visibleContent,
  visibleItemRanges,
} from "./document-content.js";
import type { ClockRange } from "./draft-review-attribution.js";
import { encodeTrailPosition, rootRelativePosition } from "./trail-read-kernel.js";

const TEXT_DIFF_BLOCK_TYPES = new Set(["paragraph", "heading"]);
type BlockInfo = {
  id: string;
  identity: string;
  type: string;
  text: string;
  content: unknown;
  effectRanges: ClockRange[];
  richRanges: ClockRange[];
  block: BlockRef;
  textSegments: TextSegment[];
};

type BlockAlignmentInput = { id: string; identity?: string; content?: unknown };

type TextSegment = {
  text: Y.XmlText;
  start: number;
  length: number;
  itemRanges: ClockRange[];
};

type AlignmentEntry<T extends BlockAlignmentInput = BlockInfo> =
  | { kind: "equal"; live: T; draft: T }
  | { kind: "change"; live: T; draft: T }
  | { kind: "delete"; live: T }
  | { kind: "insert"; draft: T };

type RawHunkBase = {
  anchor: { relStart: string; relEnd: string };
  blockKey: string;
};

type RawTextHunk = RawHunkBase & {
  kind: "text";
  insertedRanges: ClockRange[];
  deletedRanges: ClockRange[];
  insertedText: string;
  deletedText: string;
};

export type RawBlockDisplay = { type: string; display: string; ranges: ClockRange[] };

export type RawBlockHunk = RawHunkBase & {
  kind: "block";
  beforeBlockKey?: string;
  formatting?: ReviewFormattingChange[];
  insertedBlock?: RawBlockDisplay;
  deletedBlock?: RawBlockDisplay;
};

export type RawHunk = RawTextHunk | RawBlockHunk;

export function describeBlocks(doc: Y.Doc, model: AgentEditModel): BlockInfo[] {
  const handle = toDocHandle(doc);
  const blocks = model.getBlocks(handle);
  const ids = model.getDocumentBlockIds(handle);
  return blocks.map((block, index) => ({
    id: ids[index],
    identity: JSON.stringify(model.getCanonicalBlockIdentity(block)),
    type: model.getBlockType(block),
    text: model.getText(block),
    content: visibleContent(unwrapBlock(block)),
    effectRanges: visibleItemRanges(unwrapBlock(block)),
    richRanges: visibleItemRanges(unwrapBlock(block), true),
    block,
    textSegments: collectTextSegments(unwrapBlock(block)),
  }));
}

export function alignBlocks<T extends BlockAlignmentInput>(
  liveBlocks: readonly T[],
  draftBlocks: readonly T[],
): AlignmentEntry<T>[] {
  const entries: AlignmentEntry<T>[] = [];
  const pair = (live: T, draft: T) =>
    entries.push({
      kind: blockContentMatches(live, draft) ? "equal" : "change",
      live,
      draft,
    });
  let liveIndex = 0,
    draftIndex = 0;
  while (
    liveIndex < liveBlocks.length &&
    draftIndex < draftBlocks.length &&
    alignmentIdentity(liveBlocks[liveIndex]) === alignmentIdentity(draftBlocks[draftIndex])
  ) {
    pair(liveBlocks[liveIndex], draftBlocks[draftIndex]);
    liveIndex++;
    draftIndex++;
  }
  const offset = liveIndex;
  let liveEnd = liveBlocks.length,
    draftEnd = draftBlocks.length;
  // Duplicate IDs make suffix matching ambiguous under the LCS tie rule.
  const uniqueIds = (blocks: readonly T[]) => {
    const counts = new Map<string, number>();
    for (const block of blocks)
      counts.set(alignmentIdentity(block), (counts.get(alignmentIdentity(block)) ?? 0) + 1);
    return counts;
  };
  const liveCounts = uniqueIds(liveBlocks.slice(offset)),
    draftCounts = uniqueIds(draftBlocks.slice(offset));
  while (liveEnd > offset && draftEnd > offset) {
    const id = alignmentIdentity(liveBlocks[liveEnd - 1]);
    if (
      id !== alignmentIdentity(draftBlocks[draftEnd - 1]) ||
      liveCounts.get(id) !== 1 ||
      draftCounts.get(id) !== 1
    )
      break;
    liveEnd--;
    draftEnd--;
  }
  const lengths =
    liveIndex < liveEnd && draftIndex < draftEnd
      ? lcsLengths(
          liveBlocks.slice(offset, liveEnd).map(alignmentIdentity),
          draftBlocks.slice(offset, draftEnd).map(alignmentIdentity),
        )
      : [];
  while (liveIndex < liveEnd && draftIndex < draftEnd) {
    if (alignmentIdentity(liveBlocks[liveIndex]) === alignmentIdentity(draftBlocks[draftIndex])) {
      const live = liveBlocks[liveIndex];
      const draft = draftBlocks[draftIndex];
      entries.push({
        kind: blockContentMatches(live, draft) ? "equal" : "change",
        live,
        draft,
      });
      liveIndex += 1;
      draftIndex += 1;
    } else if (
      lengths[liveIndex - offset + 1][draftIndex - offset] >=
      lengths[liveIndex - offset][draftIndex - offset + 1]
    ) {
      entries.push({ kind: "delete", live: liveBlocks[liveIndex] });
      liveIndex += 1;
    } else {
      entries.push({ kind: "insert", draft: draftBlocks[draftIndex] });
      draftIndex += 1;
    }
  }
  while (liveIndex < liveEnd) {
    entries.push({ kind: "delete", live: liveBlocks[liveIndex] });
    liveIndex += 1;
  }
  while (draftIndex < draftEnd) {
    entries.push({ kind: "insert", draft: draftBlocks[draftIndex] });
    draftIndex += 1;
  }
  while (liveEnd < liveBlocks.length) {
    pair(liveBlocks[liveEnd++], draftBlocks[draftEnd++]);
  }
  return entries;
}

function blockContentMatches(live: BlockAlignmentInput, draft: BlockAlignmentInput): boolean {
  return isDeepStrictEqual(live.content, draft.content);
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

export function diffAlignedBlocks(
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
): RawHunk[] {
  const hunks: RawHunk[] = [];
  const paired = new Set<number>();
  for (const [blockIndex, entry] of alignment.entries()) {
    if (paired.has(blockIndex)) continue;
    const next = alignment[blockIndex + 1];
    if (
      entry.kind === "delete" &&
      next?.kind === "insert" &&
      entry.live.text === next.draft.text &&
      !isDeepStrictEqual(entry.live.content, next.draft.content)
    ) {
      hunks.push(blockChangeHunk(entry.live, next.draft, draftDoc));
      paired.add(blockIndex + 1);
      continue;
    }
    if (entry.kind === "insert") {
      hunks.push(
        isTextInsertHunk(entry.draft)
          ? textInsertHunk(entry.draft, draftDoc)
          : blockInsertHunk(entry.draft, draftDoc),
      );
      continue;
    }
    if (entry.kind === "delete") {
      hunks.push(
        isTextDiffBlock(entry.live)
          ? textDeleteHunk(entry.live, alignment, draftDoc)
          : blockDeleteHunk(entry.live, alignment, draftDoc),
      );
      continue;
    }
    if (entry.kind === "change") {
      hunks.push(
        ...(isTextDiffBlock(entry.live) &&
        isTextDiffBlock(entry.draft) &&
        entry.live.type === entry.draft.type &&
        entry.live.text !== entry.draft.text &&
        isDeepStrictEqual(entry.live.richRanges, entry.draft.richRanges)
          ? diffChangedBlock(entry.live, entry.draft, draftDoc)
          : [blockChangeHunk(entry.live, entry.draft, draftDoc)]),
      );
    }
  }
  return hunks.filter(hunkHasVisibleChange);
}

function hunkHasVisibleChange(hunk: RawHunk): boolean {
  switch (hunk.kind) {
    case "text":
      return hunk.insertedText.length > 0 || hunk.deletedText.length > 0;
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

function textInsertHunk(draft: BlockInfo, draftDoc: Y.Doc): RawHunk {
  return {
    kind: "text",
    anchor: anchorForBlockRange(draft, 0, draft.text.length, draftDoc),
    insertedRanges: rangesForTextRange(draft, 0, draft.text.length),
    deletedRanges: [],
    insertedText: draft.text,
    deletedText: "",
    blockKey: draft.id,
  };
}

function textDeleteHunk(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
): RawHunk {
  return {
    kind: "text",
    anchor: zeroWidthAnchorNearDeletedBlock(live, alignment, draftDoc),
    insertedRanges: [],
    deletedRanges: rangesForTextRange(live, 0, live.text.length),
    insertedText: "",
    deletedText: live.text,
    blockKey: live.id,
  };
}

function blockInsertHunk(draft: BlockInfo, draftDoc: Y.Doc): RawHunk {
  const insertedBlock = displayBlock(draft);
  return {
    kind: "block",
    anchor: anchorForWholeBlock(draft, draftDoc),
    insertedBlock: { ...insertedBlock, ranges: draft.effectRanges },
    blockKey: draft.id,
  };
}

function blockDeleteHunk(
  live: BlockInfo,
  alignment: readonly AlignmentEntry[],
  draftDoc: Y.Doc,
): RawHunk {
  const deletedBlock = displayBlock(live);
  return {
    kind: "block",
    anchor: zeroWidthAnchorNearDeletedBlock(live, alignment, draftDoc),
    deletedBlock: { ...deletedBlock, ranges: live.effectRanges },
    blockKey: live.id,
  };
}

function blockChangeHunk(live: BlockInfo, draft: BlockInfo, draftDoc: Y.Doc): RawHunk {
  const insertedBlock = displayBlock(draft);
  const deletedBlock = displayBlock(live);
  const rich = isDeepStrictEqual(
    textContentShape(unwrapBlock(live.block)),
    textContentShape(unwrapBlock(draft.block)),
  )
    ? richDifference(unwrapBlock(live.block), unwrapBlock(draft.block))
    : null;
  return {
    kind: "block",
    anchor: anchorForWholeBlock(draft, draftDoc),
    ...(live.text === draft.text
      ? {
          formatting:
            rich?.formatting ??
            (live.type === draft.type
              ? [{ kind: "structure" }]
              : [{ kind: "block", before: live.type, after: draft.type }]),
        }
      : {}),
    ...(live.id !== draft.id ? { beforeBlockKey: live.id } : {}),
    insertedBlock: {
      ...insertedBlock,
      ranges: rich?.insertedRanges ?? subtractRanges(draft.effectRanges, live.effectRanges),
    },
    deletedBlock: {
      ...deletedBlock,
      ranges: rich?.deletedRanges ?? subtractRanges(live.effectRanges, draft.effectRanges),
    },
    blockKey: draft.id,
  };
}

export function hunkInsertedRanges(hunk: RawHunk): readonly ClockRange[] {
  switch (hunk.kind) {
    case "text":
      return hunk.insertedRanges;
    case "block":
      return hunk.insertedBlock?.ranges ?? [];
  }
}

export function hunkDeletedRanges(hunk: RawHunk): readonly ClockRange[] {
  switch (hunk.kind) {
    case "text":
      return hunk.deletedRanges;
    case "block":
      return hunk.deletedBlock?.ranges ?? [];
  }
}

export function hunkDisplayText(hunk: RawHunk): { insertedText: string; deletedText: string } {
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

function subtractRanges(
  ranges: readonly ClockRange[],
  retained: readonly ClockRange[],
): ClockRange[] {
  return ranges.flatMap((range) => {
    let parts = [range];
    for (const other of retained) {
      if (other.client !== range.client) continue;
      parts = parts.flatMap((part) => {
        const start = Math.max(part.clock, other.clock);
        const end = Math.min(part.clock + part.length, other.clock + other.length);
        if (end <= start) return [part];
        return [
          ...(start > part.clock ? [{ ...part, length: start - part.clock }] : []),
          ...(end < part.clock + part.length
            ? [{ ...part, clock: end, length: part.clock + part.length - end }]
            : []),
        ];
      });
    }
    return parts;
  });
}

function displayBlock(block: BlockInfo): { type: string; display: string } {
  const text = block.text.replace(/\s+/g, " ").trim();
  if (text.length > 0) return { type: block.type, display: text };
  if (block.type === "horizontal_rule") return { type: block.type, display: "───" };
  const xmlBlock = unwrapBlock(block.block);
  if (block.type === "image") {
    const alt = stringAttr(xmlBlock, "alt");
    if (alt) return { type: block.type, display: alt };
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

/**
 * Text-only alignment can pair a surviving full stop with an identical deleted
 * one, falsely displaying the survivor as removed. Pin common Yjs identities
 * before semantic diffing the gaps so every removal names actually deleted text.
 */
function diffWithSurvivingAnchors(live: BlockInfo, draft: BlockInfo): Diff[] {
  const positionedRanges = (block: BlockInfo) =>
    block.textSegments.flatMap((segment) => {
      let offset = segment.start;
      return segment.itemRanges.map((range) => {
        const positioned = { ...range, offset };
        offset += range.length;
        return positioned;
      });
    });
  const draftRanges = positionedRanges(draft);
  const anchors = positionedRanges(live)
    .flatMap((source) =>
      draftRanges.flatMap((target) => {
        if (source.client !== target.client) return [];
        const start = Math.max(source.clock, target.clock);
        const end = Math.min(source.clock + source.length, target.clock + target.length);
        if (end <= start) return [];
        return [
          {
            liveStart: source.offset + start - source.clock,
            draftStart: target.offset + start - target.clock,
            length: end - start,
          },
        ];
      }),
    )
    .sort((left, right) => left.liveStart - right.liveStart);
  const diffs: Diff[] = [];
  let liveOffset = 0;
  let draftOffset = 0;
  for (const anchor of anchors) {
    if (anchor.liveStart < liveOffset || anchor.draftStart < draftOffset) continue;
    diffs.push(
      ...wordGapDiff(
        live.text.slice(liveOffset, anchor.liveStart),
        draft.text.slice(draftOffset, anchor.draftStart),
      ),
    );
    diffs.push([DIFF_EQUAL, live.text.slice(anchor.liveStart, anchor.liveStart + anchor.length)]);
    liveOffset = anchor.liveStart + anchor.length;
    draftOffset = anchor.draftStart + anchor.length;
  }
  diffs.push(...wordGapDiff(live.text.slice(liveOffset), draft.text.slice(draftOffset)));
  return diffs;
}

function diffChangedBlock(live: BlockInfo, draft: BlockInfo, draftDoc: Y.Doc): RawHunk[] {
  const diffs = diffWithSurvivingAnchors(live, draft);
  const hunks: RawHunk[] = [];
  let liveOffset = 0;
  let draftOffset = 0;
  let current: {
    draftStart: number;
    draftEnd: number;
    deletedText: string;
    deletedRanges: ClockRange[];
    insertedRanges: ClockRange[];
    insertedText: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    hunks.push({
      kind: "text",
      anchor: anchorForBlockRange(draft, current.draftStart, current.draftEnd, draftDoc),
      insertedRanges: current.insertedRanges,
      deletedRanges: current.deletedRanges,
      insertedText: current.insertedText,
      deletedText: current.deletedText,
      blockKey: draft.id,
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
  let item = text._start;
  while (item) {
    const content = item.content;
    if (!item.deleted && content instanceof Y.ContentString && content.str.length > 0) {
      ranges.push({ client: item.id.client, clock: item.id.clock, length: content.str.length });
    }
    item = item.right;
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

function wordGapDiff(before: string, after: string): Diff[] {
  const diffs: Diff[] = [];
  let offset = 0;
  for (const hunk of wordHunks(before, after)) {
    if (hunk.from > offset) diffs.push([DIFF_EQUAL, before.slice(offset, hunk.from)]);
    if (hunk.to > hunk.from) diffs.push([DIFF_DELETE, before.slice(hunk.from, hunk.to)]);
    if (hunk.text) diffs.push([DIFF_INSERT, hunk.text]);
    offset = hunk.to;
  }
  if (offset < before.length) diffs.push([DIFF_EQUAL, before.slice(offset)]);
  return diffs;
}

export function documentDifference(
  live: Y.Doc,
  draft: Y.Doc,
  model: AgentEditModel,
): AlignmentEntry[] {
  if (documentEffectsEqual(live, draft)) return [];
  const alignment = alignBlocks(describeBlocks(live, model), describeBlocks(draft, model));
  const difference: AlignmentEntry[] = [];
  for (let index = 0; index < alignment.length; index++) {
    const entry = alignment[index],
      next = alignment[index + 1];
    // Recreating an identical block changes physical history, not document content.
    if (
      entry.kind === "delete" &&
      next?.kind === "insert" &&
      isDeepStrictEqual(entry.live.content, next.draft.content)
    ) {
      difference.push({ kind: "equal", live: entry.live, draft: next.draft });
      index++;
    } else difference.push(entry);
  }
  return difference;
}

function alignmentIdentity(block: BlockAlignmentInput): string {
  return block.identity ?? block.id;
}
