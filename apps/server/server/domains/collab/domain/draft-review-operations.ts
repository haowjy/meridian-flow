/** Builds the draft review operation graph from ordered draft update rows and hunk links. */

import { createHash } from "node:crypto";
import * as Y from "yjs";

import { hunkSharingClosure } from "./draft-hunk-closure.js";
import { applyDraftUpdate } from "./draft-projection.js";
import { hunkSpans, operationSemanticFields } from "./draft-review-presentation";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationContribution,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

export type ClockRange = { client: number; clock: number; length: number };

export type IndexedDraftUpdate = {
  id: number;
  actorTurnId: string | null;
  actorUserId?: string | null;
  updateData: Uint8Array;
  updateKind?: string | null;
};

type DraftOperationContributionFlags = { inserted: boolean; deleted: boolean };

type DraftUpdateAttributionIndex = {
  byOperationId: Map<string, IndexedOperation>;
  operationIdsForRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): string[];
  operationRangesForInsertedRanges(insertedRanges: readonly ClockRange[]): OperationClockRange[];
  operationContributionsForRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): Map<string, DraftOperationContributionFlags>;
};

type IndexedOperation = {
  operationId: string;
  sourceUpdateIds: number[];
  /**
   * Physical journal rows whose structs currently carry or reverse this logical
   * operation. Display attribution stays on sourceUpdateIds; reject
   * reconstruction must target this physical closure so undoing reject rows over
   * the draft journal returns affected regions to live-base state.
   */
  physicalSourceUpdateIds: number[];
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
};

type YId = { client: number; clock: number };
type RangeAssignment = { start: number; end: number; operationId: string };
type OperationClockRange = ClockRange & { operationId: string };
type RangeLookup = Map<number, RangeAssignment[]>;
type RangeAlias = { source: ClockRange; target: ClockRange };
type TextSegment = { text: string; operationId: string };
type DeletedContent = { segments: TextSegment[]; text: string };
type RestorativeContentMatch = { operationId: string; deletedContent: DeletedContent };

type ItemLike = {
  id: YId;
  length: number;
  deleted?: boolean;
  redone?: YId | null;
  content?: unknown;
};

type StructStoreLike = {
  clients: Map<number, ItemLike[]>;
};

function indexDraftUpdates(input: {
  baseDoc: Y.Doc;
  updates: readonly IndexedDraftUpdate[];
}): DraftUpdateAttributionIndex {
  const byOperationId = new Map<string, IndexedOperation>();
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const aliases: RangeAlias[] = [];
  const reversedOperationIdsByOperationId = new Map<string, Set<string>>();
  const deletedContentByOperationId = new Map<string, DeletedContent>();
  const physicalUpdateIdsByOperationId = new Map<string, Set<number>>();
  const replayDoc = cloneDoc(input.baseDoc);

  try {
    for (const update of input.updates) {
      const operationId = String(update.id);
      const actorUserId = update.actorTurnId ? null : (update.actorUserId ?? null);
      byOperationId.set(operationId, {
        operationId,
        sourceUpdateIds: [update.id],
        physicalSourceUpdateIds: [update.id],
        ...(update.actorTurnId ? { actorTurnId: update.actorTurnId } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        kind: actorUserId ? "writer" : "agent",
      });
      addPhysicalUpdateId(physicalUpdateIdsByOperationId, operationId, update.id);

      const decoded = Y.decodeUpdate(update.updateData);
      const beforeRanges = deleteSetRanges(decoded.ds);
      const beforeVisibility = beforeRanges.map((range) => ({
        range,
        visible: isRangeEffectivelyVisible(replayDoc, range),
        operationIds: operationIdsForVisibleRange(introduced, deleted, range),
      }));
      const deletedContent = deletedContentForRanges(replayDoc, beforeVisibility);

      const introducedRanges = decoded.structs
        .map((struct) => {
          const id = structId(struct);
          const length = structLength(struct);
          return id && length > 0 ? ({ ...id, length } satisfies ClockRange) : null;
        })
        .filter((range): range is ClockRange => range !== null);

      applyDraftUpdate(replayDoc, update);

      for (const { range, visible: wasVisible } of beforeVisibility) {
        const isVisible = isRangeEffectivelyVisible(replayDoc, range);
        if (!wasVisible && !isVisible) {
          const target = findAliasTarget(introducedRanges, range.length);
          if (target) {
            aliases.push({ source: range, target });
            clearAssignedRange(deleted, range.client, range.clock, range.length);
          }
        }
      }

      const restoredIntroduced = introducedRanges.map((range) => ({
        range,
        operationId: restoredIntroducedOperationId(introduced, replayDoc, aliases, range),
      }));
      const deletedOperationIds = new Set(
        beforeVisibility
          .filter(({ visible: wasVisible }) => wasVisible)
          .flatMap(({ operationIds }) => operationIds),
      );
      const restoredOperationIds = new Set(
        restoredIntroduced.flatMap(({ operationId }) => (operationId ? [operationId] : [])),
      );
      const identityRestorativeRow = isPureRestorativeUndo({
        deletedOperationIds,
        restoredOperationIds,
        reversedOperationIdsByOperationId,
      });
      const contentRestorativeRow = identityRestorativeRow
        ? null
        : contentRestorativeUndoMatch({
            beforeVisibility,
            introducedStructs: decoded.structs,
            deletedOperationIds,
            reversedOperationIdsByOperationId,
            deletedContentByOperationId,
          });
      const isPureRestorativeRow = identityRestorativeRow || contentRestorativeRow !== null;

      for (const deletedOperationId of deletedOperationIds) {
        addPhysicalUpdateId(physicalUpdateIdsByOperationId, deletedOperationId, update.id);
      }
      for (const restoredOperationId of restoredOperationIds) {
        addPhysicalUpdateId(physicalUpdateIdsByOperationId, restoredOperationId, update.id);
      }
      if (contentRestorativeRow) {
        for (const segment of contentRestorativeRow.deletedContent.segments) {
          addPhysicalUpdateId(physicalUpdateIdsByOperationId, segment.operationId, update.id);
        }
      }

      let hasOwnEffect = false;

      for (const { range, visible: wasVisible } of beforeVisibility) {
        const isVisible = isRangeEffectivelyVisible(replayDoc, range);
        if (wasVisible && !isVisible) {
          if (!isPureRestorativeRow) {
            assignDeletedRange(deleted, replayDoc, aliases, range, operationId);
            hasOwnEffect = true;
          }
        } else if (!wasVisible && isVisible) {
          clearDeletedRange(deleted, replayDoc, aliases, range);
        }
      }

      for (const { range, operationId: restoredOperationId } of restoredIntroduced) {
        if (restoredOperationId) {
          setAssignedRange(
            introduced,
            range.client,
            range.clock,
            range.length,
            restoredOperationId,
          );
        } else {
          setAssignedRange(introduced, range.client, range.clock, range.length, operationId);
          hasOwnEffect = true;
        }
      }
      if (contentRestorativeRow) {
        assignIntroducedContentSegments(
          introduced,
          introducedRanges,
          decoded.structs,
          contentRestorativeRow.deletedContent.segments,
        );
        hasOwnEffect = false;
      }

      for (const range of introducedRanges) clearRedoneSourceRanges(deleted, replayDoc, range);
      if (deletedOperationIds.size > 0) {
        reversedOperationIdsByOperationId.set(operationId, deletedOperationIds);
      }
      if (deletedContent.text.length > 0) {
        deletedContentByOperationId.set(operationId, deletedContent);
      }
      if (!hasOwnEffect) byOperationId.delete(operationId);
    }
    for (const operation of byOperationId.values()) {
      operation.physicalSourceUpdateIds = sortedUpdateIds(
        physicalUpdateIdsByOperationId.get(operation.operationId) ??
          new Set(operation.sourceUpdateIds),
      );
    }
  } finally {
    replayDoc.destroy();
  }

  return {
    byOperationId,
    operationIdsForRanges(input) {
      const ids = new Set<string>();
      for (const range of input.insertedRanges) addMatchingOperations(ids, introduced, range);
      for (const range of input.deletedRanges) addMatchingOperations(ids, deleted, range);
      return [...ids].sort();
    },
    operationRangesForInsertedRanges(insertedRanges) {
      return operationRangesForRanges(introduced, insertedRanges);
    },
    operationContributionsForRanges(input) {
      const contributions = new Map<string, DraftOperationContributionFlags>();
      for (const range of input.insertedRanges) {
        for (const operationId of matchingOperationIds(introduced, range)) {
          markContribution(contributions, operationId, "inserted");
        }
      }
      for (const range of input.deletedRanges) {
        for (const operationId of matchingOperationIds(deleted, range)) {
          markContribution(contributions, operationId, "deleted");
        }
      }
      return contributions;
    },
  };
}

function addPhysicalUpdateId(
  lookup: Map<string, Set<number>>,
  operationId: string,
  updateId: number,
): void {
  const updateIds = lookup.get(operationId) ?? new Set<number>();
  updateIds.add(updateId);
  lookup.set(operationId, updateIds);
}

function sortedUpdateIds(updateIds: ReadonlySet<number>): number[] {
  return [...updateIds].sort((left, right) => left - right);
}

function contentRestorativeUndoMatch(input: {
  beforeVisibility: readonly {
    range: ClockRange;
    visible: boolean;
    operationIds: readonly string[];
  }[];
  introducedStructs: readonly unknown[];
  deletedOperationIds: ReadonlySet<string>;
  reversedOperationIdsByOperationId: ReadonlyMap<string, ReadonlySet<string>>;
  deletedContentByOperationId: ReadonlyMap<string, DeletedContent>;
}): RestorativeContentMatch | null {
  const introducedText = structsText(input.introducedStructs);
  if (introducedText.length === 0) return null;

  const candidates = [...input.deletedOperationIds].sort((left, right) => {
    const numeric = Number(right) - Number(left);
    return numeric === 0 ? right.localeCompare(left) : numeric;
  });

  for (const operationId of candidates) {
    if (!input.reversedOperationIdsByOperationId.has(operationId)) continue;
    if (!deleteSetCoversOnlyOperation(input.beforeVisibility, operationId)) continue;
    const deletedContent = input.deletedContentByOperationId.get(operationId);
    if (!deletedContent) continue;
    if (deletedContent.text === introducedText) {
      // Browser UndoManager restores the same text as fresh structs without a
      // durable redone backlink. If overlapping inverse rows ever match by
      // content, the latest row is the one the user just undid.
      return { operationId, deletedContent };
    }
  }

  return null;
}

function deleteSetCoversOnlyOperation(
  beforeVisibility: readonly {
    range: ClockRange;
    visible: boolean;
    operationIds: readonly string[];
  }[],
  operationId: string,
): boolean {
  const visible = beforeVisibility.filter(({ visible: wasVisible }) => wasVisible);
  return (
    visible.length > 0 &&
    visible.every(
      ({ operationIds }) => operationIds.length === 1 && operationIds[0] === operationId,
    )
  );
}

function deletedContentForRanges(
  doc: Y.Doc,
  beforeVisibility: readonly {
    range: ClockRange;
    visible: boolean;
    operationIds: readonly string[];
  }[],
): DeletedContent {
  const segments: TextSegment[] = [];
  for (const { range, visible, operationIds } of beforeVisibility) {
    if (!visible) continue;
    for (const segment of textSegmentsForRange(doc, range)) {
      const segmentOperationId = operationIds[0];
      if (!segmentOperationId || segment.text.length === 0) continue;
      appendTextSegment(segments, { text: segment.text, operationId: segmentOperationId });
    }
  }
  return { segments, text: segments.map((segment) => segment.text).join("") };
}

function textSegmentsForRange(doc: Y.Doc, range: ClockRange): { text: string }[] {
  const segments: { text: string }[] = [];
  let clock = range.clock;
  const end = range.clock + range.length;
  while (clock < end) {
    const item = findItem(doc, range.client, clock);
    if (!item) break;
    const itemOffset = clock - item.id.clock;
    const length = Math.min(end, item.id.clock + item.length) - clock;
    const text = itemText(item).slice(itemOffset, itemOffset + length);
    if (text.length > 0) segments.push({ text });
    clock += length;
  }
  return segments;
}

function assignIntroducedContentSegments(
  lookup: RangeLookup,
  introducedRanges: readonly ClockRange[],
  introducedStructs: readonly unknown[],
  sourceSegments: readonly TextSegment[],
): void {
  let sourceIndex = 0;
  let sourceOffset = 0;

  for (const [index, range] of introducedRanges.entries()) {
    let targetOffset = 0;
    const targetText = structText(introducedStructs[index]);
    while (targetOffset < targetText.length && sourceIndex < sourceSegments.length) {
      const source = sourceSegments[sourceIndex];
      const length = Math.min(targetText.length - targetOffset, source.text.length - sourceOffset);
      if (length > 0) {
        setAssignedRange(
          lookup,
          range.client,
          range.clock + targetOffset,
          length,
          source.operationId,
        );
      }
      targetOffset += length;
      sourceOffset += length;
      if (sourceOffset >= source.text.length) {
        sourceIndex += 1;
        sourceOffset = 0;
      }
    }
  }
}

function appendTextSegment(segments: TextSegment[], segment: TextSegment): void {
  const previous = segments.at(-1);
  if (previous?.operationId === segment.operationId) {
    previous.text += segment.text;
  } else {
    segments.push({ ...segment });
  }
}

function structsText(structs: readonly unknown[]): string {
  return structs.map(structText).join("");
}

function structText(struct: unknown): string {
  return itemText(struct as ItemLike);
}

function itemText(item: ItemLike): string {
  const content = item.content as
    | { str?: string; arr?: unknown[]; getContent?: () => unknown[] }
    | undefined;
  if (!content) return "";
  if (typeof content.str === "string") return content.str;
  if (Array.isArray(content.arr)) return content.arr.filter(isString).join("");
  if (typeof content.getContent === "function")
    return content.getContent().filter(isString).join("");
  return "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function operationIdsForVisibleRange(
  introduced: RangeLookup,
  deleted: RangeLookup,
  range: ClockRange,
): string[] {
  return [
    ...new Set([
      ...matchingOperationIds(introduced, range),
      ...matchingOperationIds(deleted, range),
    ]),
  ].sort();
}

function isPureRestorativeUndo(input: {
  deletedOperationIds: ReadonlySet<string>;
  restoredOperationIds: ReadonlySet<string>;
  reversedOperationIdsByOperationId: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (input.deletedOperationIds.size === 0 || input.restoredOperationIds.size === 0) return false;
  const reversedByDeletedRows = new Set<string>();
  for (const deletedOperationId of input.deletedOperationIds) {
    const reversed = input.reversedOperationIdsByOperationId.get(deletedOperationId);
    if (!reversed) return false;
    for (const operationId of reversed) reversedByDeletedRows.add(operationId);
  }
  return setsEqual(reversedByDeletedRows, input.restoredOperationIds);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function restoredIntroducedOperationId(
  introduced: RangeLookup,
  doc: Y.Doc,
  aliases: readonly RangeAlias[],
  target: ClockRange,
): string | null {
  const operationIds = new Set<string>();
  for (const source of sourceRangesForTarget(doc, aliases, target)) {
    for (const operationId of matchingOperationIds(introduced, source))
      operationIds.add(operationId);
  }
  if (operationIds.size === 0) return null;
  return [...operationIds].sort()[0] ?? null;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function deleteSetRanges(deleteSet: {
  clients: Map<number, Array<{ clock: number; len: number }>>;
}): ClockRange[] {
  const ranges: ClockRange[] = [];
  for (const [client, clientRanges] of deleteSet.clients) {
    for (const range of clientRanges) {
      ranges.push({ client, clock: range.clock, length: range.len });
    }
  }
  return ranges;
}

/**
 * A deleted original item can become visible again through Yjs redo metadata when
 * an undo recreates it as a new struct. Delete attribution follows that effective
 * visibility, not the monotonic delete-set history: visible -> hidden assigns the
 * current row, hidden -> visible clears the older row, and hidden -> hidden is a
 * cumulative delete-set echo.
 */
function isRangeEffectivelyVisible(doc: Y.Doc, range: ClockRange): boolean {
  if (range.length <= 0) return false;
  let clock = range.clock;
  const end = range.clock + range.length;
  while (clock < end) {
    const item = findItem(doc, range.client, clock);
    if (!item) return false;
    const itemEnd = item.id.clock + item.length;
    if (!isItemEffectivelyVisible(doc, item, clock - item.id.clock)) return false;
    clock = Math.min(end, itemEnd);
  }
  return true;
}

function isItemEffectivelyVisible(doc: Y.Doc, item: ItemLike, offset: number): boolean {
  if (!item.deleted) return true;
  if (!item.redone) return false;
  const redone = findItem(doc, item.redone.client, item.redone.clock + offset);
  return redone
    ? isItemEffectivelyVisible(doc, redone, item.redone.clock + offset - redone.id.clock)
    : false;
}

function findItem(doc: Y.Doc, client: number, clock: number): ItemLike | null {
  const structs = ((doc as unknown as { store: StructStoreLike }).store.clients.get(client) ??
    []) as ItemLike[];
  let low = 0;
  let high = structs.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const item = structs[mid];
    if (clock < item.id.clock) {
      high = mid - 1;
    } else if (clock >= item.id.clock + item.length) {
      low = mid + 1;
    } else {
      return item;
    }
  }
  return null;
}

function assignDeletedRange(
  lookup: RangeLookup,
  doc: Y.Doc,
  aliases: readonly RangeAlias[],
  range: ClockRange,
  operationId: string,
): void {
  setAssignedRange(lookup, range.client, range.clock, range.length, operationId);
  for (const source of sourceRangesForTarget(doc, aliases, range)) {
    setAssignedRange(lookup, source.client, source.clock, source.length, operationId);
  }
}

function clearDeletedRange(
  lookup: RangeLookup,
  doc: Y.Doc,
  aliases: readonly RangeAlias[],
  range: ClockRange,
): void {
  clearAssignedRange(lookup, range.client, range.clock, range.length);
  for (const source of sourceRangesForTarget(doc, aliases, range)) {
    clearAssignedRange(lookup, source.client, source.clock, source.length);
  }
}

function findAliasTarget(ranges: ClockRange[], length: number): ClockRange | null {
  const index = ranges.findIndex((range) => range.length === length);
  if (index < 0) return null;
  return ranges[index] ?? null;
}

function sourceRangesForTarget(
  doc: Y.Doc,
  aliases: readonly RangeAlias[],
  target: ClockRange,
): ClockRange[] {
  return [...redoneSourceRanges(doc, target), ...aliasSourceRanges(aliases, target)];
}

function aliasSourceRanges(aliases: readonly RangeAlias[], target: ClockRange): ClockRange[] {
  const sources: ClockRange[] = [];
  const targetStart = target.clock;
  const targetEnd = target.clock + target.length;
  for (const alias of aliases) {
    if (alias.target.client !== target.client) continue;
    const aliasStart = alias.target.clock;
    const aliasEnd = alias.target.clock + alias.target.length;
    const overlapStart = Math.max(targetStart, aliasStart);
    const overlapEnd = Math.min(targetEnd, aliasEnd);
    if (overlapEnd <= overlapStart) continue;
    sources.push({
      client: alias.source.client,
      clock: alias.source.clock + (overlapStart - aliasStart),
      length: overlapEnd - overlapStart,
    });
  }
  return sources;
}

function clearRedoneSourceRanges(lookup: RangeLookup, doc: Y.Doc, range: ClockRange): void {
  for (const source of redoneSourceRanges(doc, range)) {
    clearAssignedRange(lookup, source.client, source.clock, source.length);
  }
}

function redoneSourceRanges(doc: Y.Doc, target: ClockRange): ClockRange[] {
  const sources: ClockRange[] = [];
  const targetStart = target.clock;
  const targetEnd = target.clock + target.length;
  for (const [client, structs] of (doc as unknown as { store: StructStoreLike }).store.clients) {
    for (const item of structs) {
      if (!item.redone || item.redone.client !== target.client) continue;
      const redoneStart = item.redone.clock;
      const redoneEnd = item.redone.clock + item.length;
      const overlapStart = Math.max(targetStart, redoneStart);
      const overlapEnd = Math.min(targetEnd, redoneEnd);
      if (overlapEnd <= overlapStart) continue;
      sources.push({
        client,
        clock: item.id.clock + (overlapStart - redoneStart),
        length: overlapEnd - overlapStart,
      });
    }
  }
  return sources;
}

function addMatchingOperations(ids: Set<string>, lookup: RangeLookup, range: ClockRange): void {
  for (const operationId of matchingOperationIds(lookup, range)) ids.add(operationId);
}

function markContribution(
  contributions: Map<string, DraftOperationContributionFlags>,
  operationId: string,
  kind: keyof DraftOperationContributionFlags,
): void {
  const current = contributions.get(operationId) ?? { inserted: false, deleted: false };
  current[kind] = true;
  contributions.set(operationId, current);
}

function matchingOperationIds(lookup: RangeLookup, range: ClockRange): string[] {
  const ids = new Set<string>();
  const candidates = lookup.get(range.client) ?? [];
  const start = range.clock;
  const end = range.clock + range.length;
  for (const candidate of candidates) {
    if (candidate.start < end && start < candidate.end) ids.add(candidate.operationId);
  }
  return [...ids].sort();
}

function operationRangesForRanges(
  lookup: RangeLookup,
  ranges: readonly ClockRange[],
): OperationClockRange[] {
  const spans: OperationClockRange[] = [];
  for (const range of ranges) {
    const candidates = lookup.get(range.client) ?? [];
    const start = range.clock;
    const end = range.clock + range.length;
    for (const candidate of [...candidates].sort((left, right) => left.start - right.start)) {
      const overlapStart = Math.max(start, candidate.start);
      const overlapEnd = Math.min(end, candidate.end);
      if (overlapEnd <= overlapStart) continue;
      spans.push({
        client: range.client,
        clock: overlapStart,
        length: overlapEnd - overlapStart,
        operationId: candidate.operationId,
      });
    }
  }
  return spans;
}

function setAssignedRange(
  lookup: RangeLookup,
  client: number,
  clock: number,
  length: number,
  operationId: string,
): void {
  const start = clock;
  const end = clock + length;
  const retained = (lookup.get(client) ?? []).flatMap((range) =>
    subtractRange(range, { start, end }),
  );
  retained.push({ start, end, operationId });
  lookup.set(client, mergeAssignments(retained));
}

function clearAssignedRange(
  lookup: RangeLookup,
  client: number,
  clock: number,
  length: number,
): void {
  const start = clock;
  const end = clock + length;
  lookup.set(
    client,
    mergeAssignments(
      (lookup.get(client) ?? []).flatMap((range) => subtractRange(range, { start, end })),
    ),
  );
}

function subtractRange(
  candidate: RangeAssignment,
  removed: { start: number; end: number },
): RangeAssignment[] {
  if (removed.end <= candidate.start || candidate.end <= removed.start) return [candidate];
  const ranges: RangeAssignment[] = [];
  if (candidate.start < removed.start) {
    ranges.push({ ...candidate, end: removed.start });
  }
  if (removed.end < candidate.end) {
    ranges.push({ ...candidate, start: removed.end });
  }
  return ranges;
}

function mergeAssignments(ranges: RangeAssignment[]): RangeAssignment[] {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RangeAssignment[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.operationId === range.operationId && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function structId(struct: unknown): YId | null {
  const id = (struct as { id?: { client: number; clock: number } }).id;
  return id ? { client: id.client, clock: id.clock } : null;
}

function structLength(struct: unknown): number {
  return Number((struct as { length?: number }).length ?? 0);
}

type OperationGraphHunk = {
  raw: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
    insertedText: string;
    deletedText: string;
    blockKey: string;
    blockIndex: number;
  };
  review: DraftReviewHunkInternal;
};

type DraftReviewOperationGraph = {
  hunks: DraftReviewHunkInternal[];
  operations: DraftReviewOperationInternal[];
};

type WriterGroup = {
  operationId: string | null;
  sourceUpdateIds: Set<number>;
  physicalSourceUpdateIds: Set<number>;
  contribution: DraftOperationContributionFlags;
  actorUserId: string;
  hunkIndexes: Set<number>;
  lastBlockKey: string;
  lastBlockIndex: number;
};

/**
 * Builds the logical operation graph used by inline draft review.
 *
 * Rows have three roles:
 * - sourceUpdateIds: logical rows displayed as the operation's authoring source.
 * - physical rows: source rows plus restorative/delete rows that currently carry
 *   or reverse that logical operation while replaying the draft journal.
 * - rejectSourceUpdateIds: the connected-component union of physical rows for
 *   every operation sharing hunks with this operation.
 *
 * Invariant: reconstructing an undo of rejectSourceUpdateIds returns every
 * affected region in that connected component to the live-base state.
 *
 * Span invariant: hunk spans are inserted-text-only, ordered, non-overlapping,
 * and cover the hunk's inserted ranges exactly once after writer operation id
 * remapping. Deletions stay widget-level on DraftReviewHunkInternal.deletedText.
 */
export function computeDraftReviewOperations(input: {
  baseDoc: Y.Doc;
  updates: readonly IndexedDraftUpdate[];
  hunks: readonly OperationGraphHunk[];
}): DraftReviewOperationGraph {
  const attribution = indexDraftUpdates({ baseDoc: input.baseDoc, updates: input.updates });
  const attributedHunks = input.hunks.map((hunk) => {
    const operationIds = attribution.operationIdsForRanges({
      insertedRanges: hunk.raw.insertedRanges,
      deletedRanges: hunk.raw.deletedRanges,
    });
    return { ...hunk, operationIds };
  });
  return groupOperationsForHunks(
    attributedHunks.filter((hunk) => hunk.operationIds.length > 0),
    attribution,
  );
}

type AttributedOperationGraphHunk = OperationGraphHunk & { operationIds: string[] };

function groupOperationsForHunks(
  attributedHunks: readonly AttributedOperationGraphHunk[],
  attribution: DraftUpdateAttributionIndex,
): DraftReviewOperationGraph {
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
          operationId: null,
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
    }
  }

  for (const group of writerGroups)
    group.operationId = stableWriterOperationId(group.sourceUpdateIds);

  const writerOperationIdRemapByHunk = new Map<number, Map<string, string>>();
  for (const [hunkIndex] of attributedHunks.entries()) {
    for (const group of writerGroups) {
      if (!group.hunkIndexes.has(hunkIndex) || !group.operationId) continue;
      const ids = writerOperationIdsByHunk.get(hunkIndex) ?? new Set<string>();
      ids.add(group.operationId);
      writerOperationIdsByHunk.set(hunkIndex, ids);
      const rawIds = writerOperationIdRemapByHunk.get(hunkIndex) ?? new Map<string, string>();
      for (const updateId of group.sourceUpdateIds) rawIds.set(String(updateId), group.operationId);
      writerOperationIdRemapByHunk.set(hunkIndex, rawIds);
    }
  }

  const hunks = attributedHunks.map((hunk, hunkIndex) => {
    const agentOperationIds = hunk.operationIds.filter(
      (operationId) => attribution.byOperationId.get(operationId)?.kind !== "writer",
    );
    const writerRemap = writerOperationIdRemapByHunk.get(hunkIndex) ?? new Map<string, string>();
    const operationIds = [
      ...agentOperationIds,
      ...(writerOperationIdsByHunk.get(hunkIndex) ?? []),
    ].sort(operationSort);
    if (hunk.review.kind === "block") {
      return {
        ...hunk.review,
        operationIds,
      } satisfies DraftReviewHunkInternal;
    }
    return {
      ...hunk.review,
      operationIds,
      spans: hunkSpans(
        attribution.operationRangesForInsertedRanges(hunk.raw.insertedRanges),
        writerRemap,
      ),
    } satisfies DraftReviewHunkInternal;
  });

  const hunkCounts = new Map<string, number>();
  for (const hunk of hunks) {
    for (const operationId of hunk.operationIds) {
      hunkCounts.set(operationId, (hunkCounts.get(operationId) ?? 0) + 1);
    }
  }

  const agentOperations = [...hunkCounts.entries()]
    .flatMap(([operationId, hunkCount]) => {
      const operation = attribution.byOperationId.get(operationId);
      if (!operation || operation.kind === "writer") return [];
      return [
        {
          operationId: operation.operationId,
          sourceUpdateIds: operation.sourceUpdateIds,
          rejectSourceUpdateIds: operation.physicalSourceUpdateIds,
          directionalClosure: {
            accept: { updateIds: operation.sourceUpdateIds },
            reject: { updateIds: operation.physicalSourceUpdateIds },
          },
          ...(operation.actorTurnId ? { actorTurnId: operation.actorTurnId } : {}),
          kind: "agent" as const,
          contribution: operationContribution(contributionByOperationId.get(operation.operationId)),
          ...operationSemanticFields(operation.operationId, hunks, attributedHunks),
          hunkCount,
        },
      ];
    })
    .sort((a, b) => operationSort(a.operationId, b.operationId));
  const writerOperations = writerGroups.map(
    (group) =>
      ({
        operationId: group.operationId ?? stableWriterOperationId(group.sourceUpdateIds),
        sourceUpdateIds: [...group.sourceUpdateIds].sort((a, b) => a - b),
        rejectSourceUpdateIds: [...group.physicalSourceUpdateIds].sort((a, b) => a - b),
        directionalClosure: {
          accept: { updateIds: [...group.sourceUpdateIds].sort((a, b) => a - b) },
          reject: { updateIds: [...group.physicalSourceUpdateIds].sort((a, b) => a - b) },
        },
        actorUserId: group.actorUserId,
        kind: "writer",
        contribution: operationContribution(group.contribution),
        ...operationSemanticFields(
          group.operationId ?? stableWriterOperationId(group.sourceUpdateIds),
          hunks,
          attributedHunks,
        ),
        hunkCount: group.hunkIndexes.size,
      }) satisfies DraftReviewOperationInternal,
  );
  const operations = [...agentOperations, ...writerOperations].sort((a, b) =>
    operationSort(a.operationId, b.operationId),
  );
  return { hunks, operations: applyRejectClosures(hunks, operations) };
}

function applyRejectClosures(
  hunks: readonly DraftReviewHunkInternal[],
  operations: readonly DraftReviewOperationInternal[],
): DraftReviewOperationInternal[] {
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
  const rejectClosureByOperation = new Map<
    string,
    { operationIds: string[]; updateIds: number[] }
  >();
  for (const operation of operations) {
    if (rejectClosureByOperation.has(operation.operationId)) continue;
    const operationIds = hunkSharingClosure(
      [operation.operationId],
      operationIdsByHunk,
      hunkIndexesByOperation,
    ).sort(operationSort);
    const updateIds = [
      ...new Set(
        operationIds.flatMap(
          (operationId) =>
            operationsById.get(operationId)?.directionalClosure.reject.updateIds ?? [],
        ),
      ),
    ].sort((a, b) => a - b);
    for (const operationId of operationIds) {
      rejectClosureByOperation.set(operationId, { operationIds, updateIds });
    }
  }

  return operations.map((operation) => {
    const closure = rejectClosureByOperation.get(operation.operationId);
    return {
      ...operation,
      ...(closure && closure.operationIds.length > 1
        ? { rejectClosureOperationIds: closure.operationIds }
        : {}),
      rejectSourceUpdateIds: closure?.updateIds ?? operation.rejectSourceUpdateIds,
      directionalClosure: {
        accept: operation.directionalClosure.accept,
        reject: {
          operationIds: closure?.operationIds,
          updateIds: closure?.updateIds ?? operation.directionalClosure.reject.updateIds,
        },
      },
    };
  });
}

function stableWriterOperationId(sourceUpdateIds: ReadonlySet<number>): string {
  const sorted = [...sourceUpdateIds].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const hash = createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 10);
  return `writer:${min}-${hash}`;
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

function operationContribution(
  contribution: DraftOperationContributionFlags | undefined,
): DraftReviewOperationContribution {
  if (!contribution) return "edited";
  if (contribution.inserted && contribution.deleted) return "rewrote";
  if (contribution.inserted) return "added";
  if (contribution.deleted) return "removed";
  return "edited";
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

function canJoinWriterGroup(
  group: WriterGroup,
  hunk: { blockKey: string; blockIndex: number },
  actorUserId: string,
): boolean {
  if (group.actorUserId !== actorUserId) return false;
  return group.lastBlockKey === hunk.blockKey || hunk.blockIndex <= group.lastBlockIndex + 1;
}

function operationSort(left: string, right: string): number {
  const leftWriter = left.startsWith("writer:");
  const rightWriter = right.startsWith("writer:");
  if (leftWriter && rightWriter) return writerSortKey(left).localeCompare(writerSortKey(right));
  if (leftWriter !== rightWriter) return leftWriter ? 1 : -1;
  return left.localeCompare(right);
}

function writerSortKey(operationId: string): string {
  const match = /^writer:(\d+)-/.exec(operationId);
  return `${String(match ? Number(match[1]) : Number.MAX_SAFE_INTEGER).padStart(12, "0")}:${operationId}`;
}
