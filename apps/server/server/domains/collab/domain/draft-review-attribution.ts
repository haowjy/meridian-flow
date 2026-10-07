/** Replays draft history into an attribution index, preserving explicit coverage failure. */
import * as Y from "yjs";
import {
  asPhysicalSourceUpdateIds,
  asSourceUpdateIds,
  type DraftReviewDeletedSpanInternal,
  type PhysicalSourceUpdateId,
  type PhysicalSourceUpdateIds,
  type SourceUpdateIds,
} from "./draft-review-types.js";

export type ClockRange = { client: number; clock: number; length: number };

export type IndexedDraftUpdate = {
  id: number;
  actorTurnId: string | null;
  actorUserId?: string | null;
  updateData: Uint8Array;
  updateKind?: string | null;
};

export type DraftOperationContributionFlags = { inserted: boolean; deleted: boolean };

export type DraftUpdateAttributionIndex = {
  byOperationId: Map<string, IndexedOperation>;
  attributeRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): {
    complete: boolean;
    operationIds: string[];
    insertedAttribution: OperationClockRange[];
    deletedSpans: DraftReviewDeletedSpanInternal[];
  };
  hasInterleavedEdits(insertedRanges: readonly ClockRange[]): boolean;
  operationContributionsForRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): Map<string, DraftOperationContributionFlags>;
};

export type IndexedOperation = {
  operationId: string;
  sourceUpdateIds: SourceUpdateIds;
  /**
   * Physical journal rows whose structs currently carry or reverse this logical
   * operation. Display attribution stays on sourceUpdateIds; Discard
   * reconstruction must target this physical closure so undoing Discard rows
   * over the draft journal returns affected regions to live-base state.
   */
  physicalSourceUpdateIds: PhysicalSourceUpdateIds;
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
};

type YId = { client: number; clock: number };
type RangeAssignment = { start: number; end: number; operationId: string };
export type OperationClockRange = ClockRange & { operationId: string };
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
  origin?: YId | null;
  rightOrigin?: YId | null;
  content?: unknown;
};

type StructStoreLike = {
  clients: Map<number, ItemLike[]>;
};

export function indexDraftUpdates(input: {
  baseDoc: Y.Doc;
  updates: readonly IndexedDraftUpdate[];
}): DraftUpdateAttributionIndex {
  const byOperationId = new Map<string, IndexedOperation>();
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const deletedHistory: RangeLookup = new Map();
  const aliases: RangeAlias[] = [];
  const insertedItems: ItemLike[] = [];
  const reversedOperationIdsByOperationId = new Map<string, Set<string>>();
  const deletedContentByOperationId = new Map<string, DeletedContent>();
  const physicalUpdateIdsByOperationId = new Map<string, Set<PhysicalSourceUpdateId>>();
  const replayDoc = cloneDoc(input.baseDoc);

  try {
    for (const update of input.updates) {
      const operationId = String(update.id);
      const actorUserId = update.actorTurnId ? null : (update.actorUserId ?? null);
      byOperationId.set(operationId, {
        operationId,
        sourceUpdateIds: asSourceUpdateIds([update.id]),
        physicalSourceUpdateIds: asPhysicalSourceUpdateIds([update.id]),
        ...(update.actorTurnId ? { actorTurnId: update.actorTurnId } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        kind: actorUserId ? "writer" : "agent",
      });
      addPhysicalUpdateId(physicalUpdateIdsByOperationId, operationId, update.id);

      const decoded = Y.decodeUpdate(update.updateData);
      insertedItems.push(...(decoded.structs as ItemLike[]));
      const beforeRanges = deleteSetRanges(decoded.ds).flatMap((range) =>
        splitRangeAtStructBoundaries(replayDoc, range),
      );
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

      Y.applyUpdate(replayDoc, update.updateData, { origin: { type: "branch-review" } });

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
            assignDeletedRange(deletedHistory, replayDoc, aliases, range, operationId);
            hasOwnEffect = true;
          }
        } else if (!wasVisible && isVisible && isPureRestorativeRow) {
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

      if (isPureRestorativeRow) {
        for (const range of introducedRanges) clearRedoneSourceRanges(deleted, replayDoc, range);
      }
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
          new Set(asPhysicalSourceUpdateIds(operation.sourceUpdateIds)),
      );
    }
  } finally {
    replayDoc.destroy();
  }

  function operationIdsForRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): string[] {
    const ids = new Set<string>();
    for (const range of input.insertedRanges) addMatchingOperations(ids, introduced, range);
    for (const range of input.deletedRanges) {
      const beforeSize = ids.size;
      addMatchingOperations(ids, deleted, range);
      if (ids.size === beforeSize) addMatchingOperations(ids, deletedHistory, range);
    }
    return [...ids].sort();
  }

  function deletedSpansForRanges(deletedRanges: readonly ClockRange[]): {
    complete: boolean;
    spans: DraftReviewDeletedSpanInternal[];
  } {
    const spans: DraftReviewDeletedSpanInternal[] = [];
    let offset = 0;
    for (const range of deletedRanges) {
      const boundaries = new Set([range.clock, range.clock + range.length]);
      for (const lookup of [deleted, deletedHistory]) {
        for (const candidate of lookup.get(range.client) ?? []) {
          if (candidate.start > range.clock && candidate.start < range.clock + range.length)
            boundaries.add(candidate.start);
          if (candidate.end > range.clock && candidate.end < range.clock + range.length)
            boundaries.add(candidate.end);
        }
      }
      const ordered = [...boundaries].sort((a, b) => a - b);
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const part = {
          client: range.client,
          clock: ordered[index],
          length: ordered[index + 1] - ordered[index],
        };
        const operationId =
          matchingOperationIds(deleted, part)[0] ?? matchingOperationIds(deletedHistory, part)[0];
        const operation = operationId ? byOperationId.get(operationId) : undefined;
        if (!operation) {
          // Partial author spans would hide the missing portion of the removal.
          return { complete: false, spans: [] };
        }
        const previous = spans.at(-1);
        if (previous?.deletedBy === operation.kind && previous.to === offset)
          previous.to += part.length;
        else spans.push({ from: offset, to: offset + part.length, deletedBy: operation.kind });
        offset += part.length;
      }
    }
    return { complete: true, spans };
  }

  return {
    byOperationId,
    attributeRanges({ insertedRanges, deletedRanges }) {
      const deletion = deletedSpansForRanges(deletedRanges);
      const insertedAttribution = operationRangesForRanges(introduced, insertedRanges).filter(
        (range) => byOperationId.has(range.operationId),
      );
      return {
        complete:
          deletion.complete &&
          insertedAttribution.reduce((total, range) => total + range.length, 0) ===
            insertedRanges.reduce((total, range) => total + range.length, 0),
        operationIds: operationIdsForRanges({ insertedRanges, deletedRanges }).filter((id) =>
          byOperationId.has(id),
        ),
        insertedAttribution,
        deletedSpans: deletion.spans,
      };
    },
    hasInterleavedEdits(insertedRanges) {
      // Surviving text anchored inside the other author's removed context is a
      // CRDT interleave, unlike typing into intact AI prose. This can affect a
      // writer-only hunk when the semantic diff split the AI rewrite next to it.
      return insertedItems.some((item) => {
        if (
          !insertedRanges.some(
            (range) =>
              range.client === item.id.client &&
              range.clock < item.id.clock + item.length &&
              item.id.clock < range.clock + range.length,
          )
        )
          return false;
        const owner = matchingOperationIds(introduced, { ...item.id, length: item.length });
        // Both boundaries must be inside removed context. One removed boundary
        // alone is an ordinary adjacent edit, not an unsplittable interleave.
        return [item.origin, item.rightOrigin].every(
          (origin) =>
            origin &&
            matchingOperationIds(deleted, { ...origin, length: 1 }).some((remover) =>
              owner.some(
                (inserter) =>
                  byOperationId.get(inserter)?.kind !== byOperationId.get(remover)?.kind,
              ),
            ),
        );
      });
    },
    operationContributionsForRanges(input) {
      const contributions = new Map<string, DraftOperationContributionFlags>();
      for (const range of input.insertedRanges) {
        for (const operationId of matchingOperationIds(introduced, range)) {
          markContribution(contributions, operationId, "inserted");
        }
      }
      for (const range of input.deletedRanges) {
        const current = matchingOperationIds(deleted, range);
        const operationIds =
          current.length > 0 ? current : matchingOperationIds(deletedHistory, range);
        for (const operationId of operationIds) {
          markContribution(contributions, operationId, "deleted");
        }
      }
      return contributions;
    },
  };
}

function addPhysicalUpdateId(
  lookup: Map<string, Set<PhysicalSourceUpdateId>>,
  operationId: string,
  updateId: number,
): void {
  const updateIds = lookup.get(operationId) ?? new Set<PhysicalSourceUpdateId>();
  updateIds.add(updateId as PhysicalSourceUpdateId);
  lookup.set(operationId, updateIds);
}

function sortedUpdateIds<UpdateId extends number>(updateIds: ReadonlySet<UpdateId>): UpdateId[] {
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

export function deleteSetRanges(deleteSet: {
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
function splitRangeAtStructBoundaries(doc: Y.Doc, range: ClockRange): ClockRange[] {
  const ranges: ClockRange[] = [];
  const end = range.clock + range.length;
  let clock = range.clock;
  // State-vector updates echo cumulative deletes. A single delete-set range can
  // contain old tombstones and newly removed structs; visibility is per struct.
  while (clock < end) {
    const item = findItem(doc, range.client, clock);
    const next = item ? Math.min(end, item.id.clock + item.length) : end;
    ranges.push({ client: range.client, clock, length: next - clock });
    clock = next;
  }
  return ranges;
}

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
