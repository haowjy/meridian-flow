/** Indexes draft Yjs update rows by the CRDT ranges they introduce or effectively delete. */

import * as Y from "yjs";

export type ClockRange = { client: number; clock: number; length: number };

export type IndexedDraftUpdate = {
  id: number;
  actorTurnId: string | null;
  actorUserId?: string | null;
  updateData: Uint8Array;
};

export type DraftUpdateAttributionIndex = {
  byOperationId: Map<string, IndexedOperation>;
  operationIdsForRanges(input: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
  }): string[];
};

export type IndexedOperation = {
  operationId: string;
  sourceUpdateIds: number[];
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
};

type YId = { client: number; clock: number };
type RangeAssignment = { start: number; end: number; operationId: string };
type RangeLookup = Map<number, RangeAssignment[]>;
type RangeAlias = { source: ClockRange; target: ClockRange };

type ItemLike = {
  id: YId;
  length: number;
  deleted?: boolean;
  redone?: YId | null;
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
  const aliases: RangeAlias[] = [];
  const reversedOperationIdsByOperationId = new Map<string, Set<string>>();
  const replayDoc = cloneDoc(input.baseDoc);

  try {
    for (const update of input.updates) {
      const operationId = String(update.id);
      const actorUserId = update.actorTurnId ? null : (update.actorUserId ?? null);
      byOperationId.set(operationId, {
        operationId,
        sourceUpdateIds: [update.id],
        ...(update.actorTurnId ? { actorTurnId: update.actorTurnId } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        kind: actorUserId ? "writer" : "agent",
      });

      const decoded = Y.decodeUpdate(update.updateData);
      const beforeRanges = deleteSetRanges(decoded.ds);
      const beforeVisibility = beforeRanges.map((range) => ({
        range,
        visible: isRangeEffectivelyVisible(replayDoc, range),
        operationIds: operationIdsForVisibleRange(introduced, deleted, range),
      }));

      const introducedRanges = decoded.structs
        .map((struct) => {
          const id = structId(struct);
          const length = structLength(struct);
          return id && length > 0 ? ({ ...id, length } satisfies ClockRange) : null;
        })
        .filter((range): range is ClockRange => range !== null);

      Y.applyUpdate(replayDoc, update.updateData);

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
      const isPureRestorativeRow = isPureRestorativeUndo({
        deletedOperationIds,
        restoredOperationIds,
        reversedOperationIdsByOperationId,
      });

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

      for (const range of introducedRanges) clearRedoneSourceRanges(deleted, replayDoc, range);
      if (deletedOperationIds.size > 0) {
        reversedOperationIdsByOperationId.set(operationId, deletedOperationIds);
      }
      if (!hasOwnEffect) byOperationId.delete(operationId);
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
  };
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
