/** Server-authoritative accept closure: hunk-sharing plus Yjs causal drag. */

import * as Y from "yjs";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

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

export function computePushClosure(input: {
  requestedOperationIds: readonly string[];
  operations: readonly DraftReviewOperationInternal[];
  hunks: readonly { operationIds: readonly string[] }[];
  updates: readonly AcceptClosureUpdate[];
  decodedUpdates?: ReadonlyMap<number, DecodedUpdateLike>;
}): { operationIds: string[]; updateIds: Set<number> } {
  const operationById = new Map(
    input.operations.map((operation) => [operation.operationId, operation]),
  );
  const operationIdsByUpdateId = new Map<number, Set<string>>();
  for (const operation of input.operations) {
    for (const updateId of operation.directionalClosure.accept.updateIds) {
      const operationIds = operationIdsByUpdateId.get(updateId) ?? new Set<string>();
      operationIds.add(operation.operationId);
      operationIdsByUpdateId.set(updateId, operationIds);
    }
  }

  let operationIds = hunkSharingClosureFromHunks(input.requestedOperationIds, input.hunks).sort();
  let updateIds = updateIdsForOperations(operationIds, operationById);
  for (;;) {
    const causalUpdateIds = causalClosure(updateIds, input.updates, input.decodedUpdates);
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
  hunks: readonly DraftReviewHunkInternal[];
  updates: readonly AcceptClosureUpdate[];
  partitionClasses?: boolean;
}): DraftReviewOperationInternal[] {
  const decodedUpdates = new Map(
    input.updates.map((update) => [update.id, decodeUpdateForClosure(update.updateData)]),
  );
  if (input.partitionClasses !== true) {
    return input.operations.map((operation) => {
      const closure = computePushClosure({
        requestedOperationIds: [operation.operationId],
        operations: input.operations,
        hunks: input.hunks,
        updates: input.updates,
        decodedUpdates,
      });
      return {
        ...operation,
        acceptClosureOperationIds: closure.operationIds,
        closureClassId: closureClassId(closure.operationIds),
        directionalClosure: {
          accept: {
            operationIds: closure.operationIds,
            updateIds: operation.directionalClosure.accept.updateIds,
          },
          reject: operation.directionalClosure.reject,
        },
      };
    });
  }

  const acceptClosures = new Map<string, { operationIds: string[]; updateIds: Set<number> }>();
  for (const operation of input.operations) {
    acceptClosures.set(
      operation.operationId,
      computePushClosure({
        requestedOperationIds: [operation.operationId],
        operations: input.operations,
        hunks: input.hunks,
        updates: input.updates,
        decodedUpdates,
      }),
    );
  }

  const operationById = new Map(
    input.operations.map((operation) => [operation.operationId, operation]),
  );
  const classIds = closureClassPartition({
    operations: input.operations,
    hunks: input.hunks,
    acceptClosures,
  });
  const operationsByClass = new Map<string, string[]>();
  for (const operation of input.operations) {
    const classId = classIds.get(operation.operationId) ?? closureClassId([operation.operationId]);
    const operationIds = operationsByClass.get(classId) ?? [];
    operationIds.push(operation.operationId);
    operationsByClass.set(classId, operationIds);
  }

  const classAcceptUpdateIds = new Map<string, number[]>();
  const classRejectUpdateIds = new Map<string, number[]>();
  for (const [classId, operationIds] of operationsByClass) {
    const acceptUpdateIds = new Set<number>();
    const rejectUpdateIds = new Set<number>();
    for (const operationId of operationIds) {
      const accept = acceptClosures.get(operationId);
      for (const id of accept?.updateIds ?? []) acceptUpdateIds.add(id);
      const operation = operationById.get(operationId);
      if (!operation) continue;
      for (const id of operation.directionalClosure.reject.updateIds) rejectUpdateIds.add(id);
    }
    classAcceptUpdateIds.set(
      classId,
      [...acceptUpdateIds].sort((a, b) => a - b),
    );
    classRejectUpdateIds.set(
      classId,
      [...rejectUpdateIds].sort((a, b) => a - b),
    );
  }

  return input.operations.map((operation) => {
    const classId = classIds.get(operation.operationId) ?? closureClassId([operation.operationId]);
    const classOperationIds = [
      ...(operationsByClass.get(classId) ?? [operation.operationId]),
    ].sort();
    return {
      ...operation,
      acceptClosureOperationIds: classOperationIds,
      rejectClosureOperationIds: classOperationIds,
      closureClassId: classId,
      directionalClosure: {
        accept: {
          operationIds: classOperationIds,
          updateIds:
            classAcceptUpdateIds.get(classId) ?? operation.directionalClosure.accept.updateIds,
        },
        reject: {
          operationIds: classOperationIds,
          updateIds:
            classRejectUpdateIds.get(classId) ?? operation.directionalClosure.reject.updateIds,
        },
      },
    };
  });
}

type ClosurePartitionInput = {
  operations: readonly DraftReviewOperationInternal[];
  hunks: readonly DraftReviewHunkInternal[];
  acceptClosures: ReadonlyMap<string, { operationIds: string[] }>;
};

function closureClassPartition(input: ClosurePartitionInput): Map<string, string> {
  const uf = new UnionFind();
  for (const operation of input.operations) uf.add(operation.operationId);
  const unionAll = (ids: readonly string[]) => {
    const present = ids.filter((id) => uf.has(id));
    for (let index = 1; index < present.length; index += 1)
      uf.union(present[0] as string, present[index] as string);
  };
  for (const operation of input.operations) {
    unionAll([
      operation.operationId,
      ...(input.acceptClosures.get(operation.operationId)?.operationIds ?? []),
    ]);
    unionAll([operation.operationId, ...(operation.directionalClosure.accept.operationIds ?? [])]);
    unionAll([operation.operationId, ...(operation.directionalClosure.reject.operationIds ?? [])]);
    unionAll([operation.operationId, ...(operation.rejectClosureOperationIds ?? [])]);
  }
  for (const hunk of input.hunks) unionAll(hunk.operationIds);

  const components = new Map<string, string[]>();
  for (const operation of input.operations) {
    const root = uf.find(operation.operationId);
    const ids = components.get(root) ?? [];
    ids.push(operation.operationId);
    components.set(root, ids);
  }
  const classByOperation = new Map<string, string>();
  for (const ids of components.values()) {
    const classId = closureClassId(ids);
    for (const id of ids) classByOperation.set(id, classId);
  }
  return classByOperation;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  has(id: string): boolean {
    return this.parent.has(id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent) return id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function updateIdsForOperations(
  operationIds: readonly string[],
  operationById: ReadonlyMap<string, DraftReviewOperationInternal>,
): Set<number> {
  const updateIds = new Set<number>();
  for (const operationId of operationIds) {
    const operation = operationById.get(operationId);
    if (!operation) continue;
    for (const updateId of operation.directionalClosure.accept.updateIds) updateIds.add(updateId);
  }
  return updateIds;
}

function causalClosure(
  seedUpdateIds: ReadonlySet<number>,
  updates: readonly AcceptClosureUpdate[],
  decodedUpdates?: ReadonlyMap<number, DecodedUpdateLike>,
): Set<number> {
  const indexed = updates.map((update) => ({
    update,
    decoded: decodedUpdates?.get(update.id) ?? decodeUpdateForClosure(update.updateData),
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

function closureClassId(operationIds: readonly string[]): string {
  return `closure:${[...operationIds].sort().join("+")}`;
}

export function hunkSharingClosureFromHunks(
  seedOperationIds: readonly string[],
  hunks: readonly { operationIds: readonly string[] }[],
): string[] {
  const operationIdsByHunk = hunks.map((hunk) => new Set(hunk.operationIds));
  const hunkIndexesByOperation = new Map<string, number[]>();
  hunks.forEach((hunk, index) => {
    for (const operationId of hunk.operationIds) {
      const indexes = hunkIndexesByOperation.get(operationId) ?? [];
      indexes.push(index);
      hunkIndexesByOperation.set(operationId, indexes);
    }
  });
  return hunkSharingClosure(seedOperationIds, operationIdsByHunk, hunkIndexesByOperation);
}

export function hunkSharingClosure(
  seedOperationIds: readonly string[],
  operationIdsByHunk: readonly ReadonlySet<string>[],
  hunkIndexesByOperation: ReadonlyMap<string, readonly number[]>,
): string[] {
  const selected = new Set(seedOperationIds);
  const queue = [...seedOperationIds];
  while (queue.length > 0) {
    const operationId = queue.shift();
    if (!operationId) continue;
    for (const hunkIndex of hunkIndexesByOperation.get(operationId) ?? []) {
      for (const hunkOperationId of operationIdsByHunk[hunkIndex] ?? []) {
        if (selected.has(hunkOperationId)) continue;
        selected.add(hunkOperationId);
        queue.push(hunkOperationId);
      }
    }
  }
  return [...selected].sort();
}
