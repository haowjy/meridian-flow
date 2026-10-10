/** Builds server-authoritative dependency-closed Apply/Discard classes. */

import { createHash } from "node:crypto";
import {
  type ClockRange,
  decodeUpdateForDependencies,
  deleteRanges,
  rangesOverlap,
  structDependencies,
  suppliedRanges,
} from "@meridian/agent-edit/integration";
import type { ReviewHunk } from "@meridian/contracts/drafts";
import {
  asPhysicalSourceUpdateIds,
  type DraftReviewOperationInternal,
  type PhysicalSourceUpdateIds,
} from "./draft-review-types.js";

type DependencyUpdate = { id: number; updateData: Uint8Array | Buffer };

/**
 * One review class joins operations that share a visible hunk or a physical
 * journal row. Physical rows include the later rows that carry or reverse a
 * logical operation, so overlap is the review model's causal/dependent edge.
 */
export function assignReviewClasses(input: {
  operations: readonly Omit<DraftReviewOperationInternal, "closureClassId">[];
  hunks: readonly ReviewHunk[];
  updates?: readonly DependencyUpdate[];
  baseDeletedRanges?: readonly ClockRange[];
}): DraftReviewOperationInternal[] {
  const graph = new UnionFind();
  const suppliedRowIds = new Set((input.updates ?? []).map((row) => row.id));
  for (const operation of input.operations) {
    const node: Node = `operation:${operation.operationId}`;
    graph.add(node);
    for (const id of new Set([
      ...operation.closureUpdateIds,
      ...operation.sourceUpdateIds.filter((id) => suppliedRowIds.has(id)),
    ])) {
      const row: Node = `row:${id}`;
      graph.add(row);
      graph.unionAll([node, row]);
    }
  }
  for (const hunk of input.hunks)
    graph.unionAll(hunk.operationIds.map((id): Node => `operation:${id}`));
  unionYjsDependencies(graph, input.updates ?? [], input.baseDeletedRanges ?? []);

  const components = graph.components();
  const classByOperationId = new Map<
    string,
    { closureClassId: string; closureUpdateIds: PhysicalSourceUpdateIds }
  >();
  for (const { operationIds, journalIds } of components) {
    if (operationIds.length === 0) continue;
    operationIds.sort(operationSort);
    const membership = {
      closureClassId: classId(operationIds),
      closureUpdateIds: asPhysicalSourceUpdateIds(journalIds.sort((a, b) => a - b)),
    };
    for (const id of operationIds) classByOperationId.set(id, membership);
  }
  return input.operations.map((operation) => {
    const membership = classByOperationId.get(operation.operationId);
    if (!membership) throw new Error("Visible operation has no review component");
    return { ...operation, ...membership };
  });
}

/**
 * A selected Yjs update is replayable only with the branch rows that supplied
 * the structs it names. Same-client clock ranges are also sequential in Yjs:
 * a later range stays pending when an earlier branch range from that client is
 * omitted, even if no Item field points at it directly.
 */
function unionYjsDependencies(
  graph: UnionFind,
  updates: readonly DependencyUpdate[],
  baseDeletedRanges: readonly ClockRange[],
): void {
  const decoded = updates.map((update) => {
    const decoded = decodeUpdateForDependencies(update.updateData);
    return {
      update,
      supplied: suppliedRanges(decoded),
      references: [...deleteRanges(decoded), ...structDependencies(decoded)],
      branchDeletes: subtractRanges(deleteRanges(decoded), baseDeletedRanges),
    };
  });
  for (const { update } of decoded) graph.add(`row:${update.id}`);
  const supplied = rangeBuckets(
    decoded.flatMap((row) =>
      row.supplied.map((range) => ({ ...range, rowId: `row:${row.update.id}` })),
    ),
  );
  const deleted = rangeBuckets(
    decoded.flatMap((row) =>
      row.branchDeletes.map((range) => ({ ...range, rowId: `row:${row.update.id}` })),
    ),
  );
  for (const ranges of supplied.values()) {
    // One successor edge per range preserves the connected components of all
    // same-client prefix edges, even when cumulative supplied ranges overlap.
    for (const range of ranges) {
      const next = lowerBound(ranges, range.clock + range.length);
      if (next < ranges.length) graph.unionAll([range.rowId, ranges[next].rowId]);
    }
  }
  for (const ranges of deleted.values()) {
    let furthest: IndexedRange | undefined;
    for (const range of ranges) {
      if (furthest && range.clock < furthest.clock + furthest.length) {
        graph.unionAll([range.rowId, furthest.rowId]);
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
        graph.unionAll([`row:${row.update.id}`, supplier.rowId]);
      });
    }
  }
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

type Node = `operation:${string}` | `row:${number}`;
type Component = { operationIds: string[]; journalIds: number[] };

class UnionFind {
  private readonly parent = new Map<Node, Node>();

  add(id: Node): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: Node): Node {
    const parent = this.parent.get(id);
    if (!parent || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  components(): Component[] {
    const components = new Map<Node, Component>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const component = components.get(root) ?? { operationIds: [], journalIds: [] };
      if (node.startsWith("operation:")) component.operationIds.push(node.slice(10));
      else component.journalIds.push(Number(node.slice(4)));
      components.set(root, component);
    }
    return [...components.values()];
  }

  unionAll(ids: readonly Node[]): void {
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

type IndexedRange = ClockRange & { rowId: Node };
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
