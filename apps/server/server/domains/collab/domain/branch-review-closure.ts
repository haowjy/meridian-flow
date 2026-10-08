/** Builds server-authoritative dependency-closed Apply/Discard classes. */

import { createHash } from "node:crypto";
import {
  asPhysicalSourceUpdateIds,
  type DraftReviewHunkInternal,
  type DraftReviewOperationInternal,
  type PhysicalSourceUpdateIds,
} from "./draft-review-types.js";
import {
  type ClockRange,
  decodeUpdateForDependencies,
  deleteRanges,
  rangesOverlap,
  suppliedRanges,
} from "./journal-dependencies.js";

type DependencyUpdate = { id: number; updateData: Uint8Array | Buffer };

/**
 * One review class joins operations that share a visible hunk or a physical
 * journal row. Physical rows include the later rows that carry or reverse a
 * logical operation, so overlap is the review model's causal/dependent edge.
 */
export function assignReviewClasses(input: {
  operations: readonly Omit<DraftReviewOperationInternal, "closureClassId">[];
  hunks: readonly DraftReviewHunkInternal[];
  updates?: readonly DependencyUpdate[];
  baseDeletedRanges?: readonly ClockRange[];
}): DraftReviewOperationInternal[] {
  const unionFind = new UnionFind();
  for (const operation of input.operations) unionFind.add(operation.operationId);

  for (const hunk of input.hunks) unionFind.unionAll(hunk.operationIds);

  const operationIdsByUpdateId = new Map<number, string[]>();
  for (const operation of input.operations) {
    for (const updateId of operation.closureUpdateIds) {
      const operationIds = operationIdsByUpdateId.get(updateId) ?? [];
      operationIds.push(operation.operationId);
      operationIdsByUpdateId.set(updateId, operationIds);
    }
  }
  for (const operationIds of operationIdsByUpdateId.values()) {
    unionFind.unionAll(operationIds);
  }

  const dependencyUpdateIdsByOperationId = unionYjsDependencies(
    unionFind,
    input.operations,
    input.updates ?? [],
    input.baseDeletedRanges ?? [],
  );

  const operationsByRoot = new Map<
    string,
    Omit<DraftReviewOperationInternal, "closureClassId">[]
  >();
  for (const operation of input.operations) {
    const root = unionFind.find(operation.operationId);
    const bucket = operationsByRoot.get(root) ?? [];
    bucket.push(operation);
    operationsByRoot.set(root, bucket);
  }

  const classByOperationId = new Map<
    string,
    { closureClassId: string; closureUpdateIds: PhysicalSourceUpdateIds }
  >();
  for (const operations of operationsByRoot.values()) {
    const operationIds = operations.map((operation) => operation.operationId).sort(operationSort);
    const closureUpdateIds = asPhysicalSourceUpdateIds(
      [
        ...new Set(
          operations.flatMap((operation) => [
            ...operation.closureUpdateIds,
            ...(dependencyUpdateIdsByOperationId.get(operation.operationId) ?? []),
          ]),
        ),
      ].sort((left, right) => left - right),
    );
    const closureClassId = classId(operationIds);
    for (const operationId of operationIds) {
      classByOperationId.set(operationId, { closureClassId, closureUpdateIds });
    }
  }

  return input.operations.map((operation) => ({
    ...operation,
    ...(classByOperationId.get(operation.operationId) ?? {
      closureClassId: classId([operation.operationId]),
      closureUpdateIds: operation.closureUpdateIds,
    }),
  }));
}

/**
 * A selected Yjs update is replayable only with the branch rows that supplied
 * the structs it names. Same-client clock ranges are also sequential in Yjs:
 * a later range stays pending when an earlier branch range from that client is
 * omitted, even if no Item field points at it directly.
 */
function unionYjsDependencies(
  unionFind: UnionFind,
  operations: readonly Omit<DraftReviewOperationInternal, "closureClassId">[],
  updates: readonly DependencyUpdate[],
  baseDeletedRanges: readonly ClockRange[],
): Map<string, Set<number>> {
  const ownersByUpdateId = new Map<number, string[]>();
  for (const operation of operations) {
    for (const updateId of new Set([...operation.sourceUpdateIds, ...operation.closureUpdateIds])) {
      const owners = ownersByUpdateId.get(updateId) ?? [];
      owners.push(operation.operationId);
      ownersByUpdateId.set(updateId, owners);
    }
  }

  const decoded = updates.map((update) => {
    const decoded = decodeUpdateForDependencies(update.updateData);
    return {
      update,
      supplied: suppliedRanges(decoded),
      references: referenceRanges(decoded),
      branchDeletes: subtractRanges(deleteRanges(decoded), baseDeletedRanges),
    };
  });
  const rowUnionFind = new UnionFind();
  for (const { update } of decoded) rowUnionFind.add(String(update.id));
  const supplied = rangeBuckets(
    decoded.flatMap((row) =>
      row.supplied.map((range) => ({ ...range, rowId: String(row.update.id) })),
    ),
  );
  const deleted = rangeBuckets(
    decoded.flatMap((row) =>
      row.branchDeletes.map((range) => ({ ...range, rowId: String(row.update.id) })),
    ),
  );
  for (const ranges of supplied.values()) {
    // One successor edge per range preserves the connected components of all
    // same-client prefix edges, even when cumulative supplied ranges overlap.
    for (const range of ranges) {
      const next = lowerBound(ranges, range.clock + range.length);
      if (next < ranges.length) rowUnionFind.unionAll([range.rowId, ranges[next].rowId]);
    }
  }
  for (const ranges of deleted.values()) {
    let furthest: IndexedRange | undefined;
    for (const range of ranges) {
      if (furthest && range.clock < furthest.clock + furthest.length) {
        rowUnionFind.unionAll([range.rowId, furthest.rowId]);
      }
      if (!furthest || range.clock + range.length > furthest.clock + furthest.length)
        furthest = range;
    }
  }
  const indexes = new Map(
    [...supplied].map(([client, ranges]) => [client, intervalTree(ranges, 0, ranges.length)]),
  );
  for (const row of decoded) {
    for (const ref of row.references) {
      visitOverlaps(indexes.get(ref.client), ref, (supplier) => {
        rowUnionFind.unionAll([String(row.update.id), supplier.rowId]);
      });
    }
  }

  const updateIdsByRoot = new Map<string, number[]>();
  for (const { update } of decoded) {
    const root = rowUnionFind.find(String(update.id));
    const bucket = updateIdsByRoot.get(root) ?? [];
    bucket.push(update.id);
    updateIdsByRoot.set(root, bucket);
  }
  const dependencyUpdateIdsByOperationId = new Map<string, Set<number>>();
  for (const updateIds of updateIdsByRoot.values()) {
    const operationIds = [
      ...new Set(updateIds.flatMap((updateId) => ownersByUpdateId.get(updateId) ?? [])),
    ];
    unionFind.unionAll(operationIds);
    for (const operationId of operationIds) {
      const dependencyUpdateIds = dependencyUpdateIdsByOperationId.get(operationId) ?? new Set();
      for (const updateId of updateIds) dependencyUpdateIds.add(updateId);
      dependencyUpdateIdsByOperationId.set(operationId, dependencyUpdateIds);
    }
  }
  return dependencyUpdateIdsByOperationId;
}

function subtractRanges(
  ranges: readonly ClockRange[],
  excluded: readonly ClockRange[],
): ClockRange[] {
  return ranges.flatMap((range) => {
    let remaining = [range];
    for (const cut of excluded) {
      remaining = remaining.flatMap((part) => {
        if (!rangesOverlap(part, cut)) return [part];
        const end = part.clock + part.length;
        const cutEnd = cut.clock + cut.length;
        return [
          ...(part.clock < cut.clock ? [{ ...part, length: cut.clock - part.clock }] : []),
          ...(cutEnd < end ? [{ ...part, clock: cutEnd, length: end - cutEnd }] : []),
        ];
      });
    }
    return remaining;
  });
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  unionAll(ids: readonly string[]): void {
    const present = ids.filter((id) => this.parent.has(id));
    const first = present[0];
    if (!first) return;
    for (const id of present.slice(1)) {
      const firstRoot = this.find(first);
      const idRoot = this.find(id);
      if (firstRoot !== idRoot) this.parent.set(idRoot, firstRoot);
    }
  }
}

function operationSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true }) || left.localeCompare(right);
}

// Match #712's decoded-update shape; dependencies() is not part of that API.
function referenceRanges(decoded: ReturnType<typeof decodeUpdateForDependencies>): ClockRange[] {
  const refs = deleteRanges(decoded);
  for (const struct of decoded.structs ?? []) {
    for (const id of [struct.origin, struct.rightOrigin, struct.parent]) {
      if (id && typeof id === "object") refs.push({ ...id, length: 1 });
    }
  }
  return refs;
}

type IndexedRange = ClockRange & { rowId: string };
type IntervalNode = {
  range: IndexedRange;
  maxEnd: number;
  left?: IntervalNode;
  right?: IntervalNode;
};
function rangeBuckets(ranges: IndexedRange[]): Map<number, IndexedRange[]> {
  const buckets = new Map<number, IndexedRange[]>();
  for (const range of ranges) {
    const bucket = buckets.get(range.client) ?? [];
    bucket.push(range);
    buckets.set(range.client, bucket);
  }
  for (const bucket of buckets.values())
    bucket.sort((a, b) => a.clock - b.clock || a.length - b.length);
  return buckets;
}
function lowerBound(ranges: readonly IndexedRange[], clock: number): number {
  let lo = 0,
    hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid].clock < clock) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function intervalTree(
  ranges: readonly IndexedRange[],
  lo: number,
  hi: number,
): IntervalNode | undefined {
  if (lo === hi) return undefined;
  const mid = (lo + hi) >>> 1;
  const range = ranges[mid],
    left = intervalTree(ranges, lo, mid),
    right = intervalTree(ranges, mid + 1, hi);
  return {
    range,
    left,
    right,
    maxEnd: Math.max(range.clock + range.length, left?.maxEnd ?? 0, right?.maxEnd ?? 0),
  };
}
function visitOverlaps(
  node: IntervalNode | undefined,
  ref: ClockRange,
  visit: (range: IndexedRange) => void,
): void {
  if (!node || node.maxEnd <= ref.clock) return;
  visitOverlaps(node.left, ref, visit);
  if (node.range.clock >= ref.clock + ref.length) return;
  if (rangesOverlap(node.range, ref)) visit(node.range);
  visitOverlaps(node.right, ref, visit);
}

function classId(operationIds: readonly string[]): string {
  return `closure:v1:${createHash("sha256").update(JSON.stringify(operationIds)).digest("base64url")}`;
}
