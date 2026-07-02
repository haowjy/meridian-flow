/** Indexes draft Yjs update rows by the CRDT ranges they introduce or delete. */

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
type RangeLookup = Map<number, Array<{ start: number; end: number; operationId: string }>>;
type KnownDeleteRanges = Map<number, Array<{ start: number; end: number }>>;

export function indexDraftUpdates(
  updates: readonly IndexedDraftUpdate[],
): DraftUpdateAttributionIndex {
  const byOperationId = new Map<string, IndexedOperation>();
  const introduced: RangeLookup = new Map();
  const deleted: RangeLookup = new Map();
  const knownDeletes: KnownDeleteRanges = new Map();

  for (const update of updates) {
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
    for (const struct of decoded.structs) {
      const id = structId(struct);
      const length = structLength(struct);
      if (id && length > 0) addLookupRange(introduced, id.client, id.clock, length, operationId);
    }
    for (const [client, ranges] of decoded.ds.clients) {
      for (const range of ranges) {
        for (const fresh of subtractKnownDeleteRange(
          knownDeletes,
          client,
          range.clock,
          range.len,
        )) {
          addLookupRange(deleted, client, fresh.clock, fresh.length, operationId);
        }
        markKnownDeleteRange(knownDeletes, client, range.clock, range.len);
      }
    }
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

function subtractKnownDeleteRange(
  known: KnownDeleteRanges,
  client: number,
  clock: number,
  length: number,
): ClockRange[] {
  let fresh: Array<{ start: number; end: number }> = [{ start: clock, end: clock + length }];
  for (const range of known.get(client) ?? []) {
    fresh = fresh.flatMap((candidate) => subtractRange(candidate, range));
  }
  return fresh.map((range) => ({ client, clock: range.start, length: range.end - range.start }));
}

function subtractRange(
  candidate: { start: number; end: number },
  known: { start: number; end: number },
): Array<{ start: number; end: number }> {
  if (known.end <= candidate.start || candidate.end <= known.start) return [candidate];
  const ranges: Array<{ start: number; end: number }> = [];
  if (candidate.start < known.start) ranges.push({ start: candidate.start, end: known.start });
  if (known.end < candidate.end) ranges.push({ start: known.end, end: candidate.end });
  return ranges;
}

function markKnownDeleteRange(
  known: KnownDeleteRanges,
  client: number,
  clock: number,
  length: number,
): void {
  const ranges = [...(known.get(client) ?? []), { start: clock, end: clock + length }].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  known.set(client, merged);
}

function structId(struct: unknown): YId | null {
  const id = (struct as { id?: { client: number; clock: number } }).id;
  return id ? { client: id.client, clock: id.clock } : null;
}

function structLength(struct: unknown): number {
  return Number((struct as { length?: number }).length ?? 0);
}
