/** Server-authoritative accept closure: hunk-sharing plus Yjs causal drag. */

import type { ReviewHunk } from "@meridian/contracts/drafts";
import * as Y from "yjs";
import { hunkSharingClosureFromHunks } from "./draft-hunk-closure.js";
import type { DraftReviewOperationInternal } from "./draft-review-operations.js";

export type AcceptClosureUpdate = {
  id: number;
  updateData: Uint8Array;
};

type ClockRange = { client: number; clock: number; length: number };
type YIdRef = { client: number; clock: number };

type StructLike = {
  id?: YIdRef;
  length?: number;
  origin?: YIdRef | null;
  rightOrigin?: YIdRef | null;
};

type DecodedUpdateLike = {
  structs?: StructLike[];
  ds?: { clients?: Map<number, { clock: number; len?: number; length?: number }[]> };
};

export function acceptClosure(input: {
  requestedOperationIds: readonly string[];
  operations: readonly DraftReviewOperationInternal[];
  hunks: readonly { operationIds: readonly string[] }[];
  updates: readonly AcceptClosureUpdate[];
}): { operationIds: string[]; updateIds: Set<number> } {
  const operationById = new Map(
    input.operations.map((operation) => [operation.operationId, operation]),
  );
  const operationIdsByUpdateId = new Map<number, Set<string>>();
  for (const operation of input.operations) {
    for (const updateId of operation.acceptSourceUpdateIds ?? operation.sourceUpdateIds) {
      const operationIds = operationIdsByUpdateId.get(updateId) ?? new Set<string>();
      operationIds.add(operation.operationId);
      operationIdsByUpdateId.set(updateId, operationIds);
    }
  }

  let operationIds = hunkSharingClosureFromHunks(input.requestedOperationIds, input.hunks).sort();
  let updateIds = updateIdsForOperations(operationIds, operationById);
  for (;;) {
    const causalUpdateIds = causalClosure(updateIds, input.updates);
    let changed = causalUpdateIds.size !== updateIds.size;
    for (const updateId of causalUpdateIds) {
      for (const operationId of operationIdsByUpdateId.get(updateId) ?? []) {
        if (!operationIds.includes(operationId)) {
          operationIds.push(operationId);
          changed = true;
        }
      }
    }
    const nextOperationIds = hunkSharingClosureFromHunks(operationIds, input.hunks).sort();
    if (nextOperationIds.length !== operationIds.length) changed = true;
    operationIds = nextOperationIds;
    updateIds = unionSets(causalUpdateIds, updateIdsForOperations(operationIds, operationById));
    if (!changed) return { operationIds, updateIds };
  }
}

export function enrichAcceptClosureOperationIds(input: {
  operations: readonly DraftReviewOperationInternal[];
  hunks: readonly ReviewHunk[];
  updates: readonly AcceptClosureUpdate[];
}): DraftReviewOperationInternal[] {
  return input.operations.map((operation) => ({
    ...operation,
    acceptClosureOperationIds: acceptClosure({
      requestedOperationIds: [operation.operationId],
      operations: input.operations,
      hunks: input.hunks,
      updates: input.updates,
    }).operationIds,
  }));
}

function updateIdsForOperations(
  operationIds: readonly string[],
  operationById: ReadonlyMap<string, DraftReviewOperationInternal>,
): Set<number> {
  const updateIds = new Set<number>();
  for (const operationId of operationIds) {
    const operation = operationById.get(operationId);
    if (!operation) continue;
    for (const updateId of operation.acceptSourceUpdateIds ?? operation.sourceUpdateIds)
      updateIds.add(updateId);
  }
  return updateIds;
}

function causalClosure(
  seedUpdateIds: ReadonlySet<number>,
  updates: readonly AcceptClosureUpdate[],
): Set<number> {
  const indexed = updates.map((update) => ({
    update,
    decoded: decodeUpdateForClosure(update.updateData),
  }));
  const rangesByUpdate = new Map<number, ClockRange[]>();
  for (const entry of indexed) rangesByUpdate.set(entry.update.id, suppliedRanges(entry.decoded));

  const closure = new Set(seedUpdateIds);
  for (;;) {
    let changed = false;
    const supplied = [...closure].flatMap((updateId) => rangesByUpdate.get(updateId) ?? []);
    for (const entry of indexed) {
      if (!closure.has(entry.update.id)) continue;
      for (const dependency of dependencies(entry.decoded)) {
        if (rangeContainsAny(supplied, dependency)) continue;
        const owner = indexed.find(
          (candidate) =>
            candidate.update.id < entry.update.id &&
            (rangesByUpdate.get(candidate.update.id) ?? []).some((range) =>
              rangesOverlap(range, dependency),
            ),
        );
        if (owner && !closure.has(owner.update.id)) {
          closure.add(owner.update.id);
          changed = true;
        }
      }
    }
    if (!changed) return closure;
  }
}

function decodeUpdateForClosure(update: Uint8Array): DecodedUpdateLike {
  return Y.decodeUpdate(update) as DecodedUpdateLike;
}

function suppliedRanges(decoded: DecodedUpdateLike): ClockRange[] {
  return (decoded.structs ?? []).flatMap((struct) => {
    const id = struct.id;
    const length = typeof struct.length === "number" ? struct.length : 0;
    return id && length > 0 ? [{ client: id.client, clock: id.clock, length }] : [];
  });
}

function dependencies(decoded: DecodedUpdateLike): ClockRange[] {
  const refs: ClockRange[] = [];
  for (const struct of decoded.structs ?? []) {
    if (struct.origin) refs.push({ ...struct.origin, length: 1 });
    if (struct.rightOrigin) refs.push({ ...struct.rightOrigin, length: 1 });
  }
  const clients = decoded.ds?.clients;
  if (clients) {
    for (const [client, ranges] of clients) {
      for (const range of ranges) {
        refs.push({ client, clock: range.clock, length: range.len ?? range.length ?? 1 });
      }
    }
  }
  return refs;
}

function rangeContainsAny(ranges: readonly ClockRange[], dependency: ClockRange): boolean {
  return ranges.some((range) => rangesOverlap(range, dependency));
}

function rangesOverlap(left: ClockRange, right: ClockRange): boolean {
  return (
    left.client === right.client &&
    left.clock < right.clock + right.length &&
    right.clock < left.clock + left.length
  );
}

function unionSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
  return new Set([...left, ...right]);
}
