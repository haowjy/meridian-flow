/** Builds server-authoritative selective-Discard classes. */

import {
  asPhysicalSourceUpdateIds,
  type DraftReviewHunkInternal,
  type DraftReviewOperationInternal,
  type PhysicalSourceUpdateIds,
} from "./draft-review-types.js";
import {
  decodeUpdateForDependencies,
  dependencies,
  rangesOverlap,
  suppliedRanges,
} from "./journal-dependencies.js";

type DependencyUpdate = { id: number; updateData: Uint8Array | Buffer };

/**
 * One Discard class joins operations that share a visible hunk or a physical
 * journal row. Physical rows include the later rows that carry or reverse a
 * logical operation, so overlap is the review model's causal/dependent edge.
 */
export function assignReviewClasses(input: {
  operations: readonly Omit<DraftReviewOperationInternal, "closureClassId">[];
  hunks: readonly DraftReviewHunkInternal[];
  updates?: readonly DependencyUpdate[];
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
  );

  const operationsByRoot = new Map<string, typeof input.operations>();
  for (const operation of input.operations) {
    const root = unionFind.find(operation.operationId);
    operationsByRoot.set(root, [...(operationsByRoot.get(root) ?? []), operation]);
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
    const closureClassId = `closure:${operationIds.join("+")}`;
    for (const operationId of operationIds) {
      classByOperationId.set(operationId, { closureClassId, closureUpdateIds });
    }
  }

  return input.operations.map((operation) => ({
    ...operation,
    ...(classByOperationId.get(operation.operationId) ?? {
      closureClassId: `closure:${operation.operationId}`,
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
): Map<string, Set<number>> {
  const ownersByUpdateId = new Map<number, string[]>();
  for (const operation of operations) {
    for (const updateId of new Set([...operation.sourceUpdateIds, ...operation.closureUpdateIds])) {
      const owners = ownersByUpdateId.get(updateId) ?? [];
      owners.push(operation.operationId);
      ownersByUpdateId.set(updateId, owners);
    }
  }

  const decoded = updates.map((update) => ({
    update,
    decoded: decodeUpdateForDependencies(update.updateData),
  }));
  const rowUnionFind = new UnionFind();
  for (const { update } of decoded) rowUnionFind.add(String(update.id));
  for (const dependent of decoded) {
    const refs = dependencies(dependent.decoded);
    const dependentSupplied = suppliedRanges(dependent.decoded);
    for (const supplier of decoded) {
      if (supplier.update.id === dependent.update.id) continue;
      const supplied = suppliedRanges(supplier.decoded);
      const explicitDependency = refs.some((ref) =>
        supplied.some((range) => rangesOverlap(range, ref)),
      );
      const clockDependency = dependentSupplied.some((range) =>
        supplied.some(
          (candidate) =>
            candidate.client === range.client &&
            candidate.clock < range.clock &&
            candidate.clock + candidate.length <= range.clock,
        ),
      );
      if (!explicitDependency && !clockDependency) continue;
      rowUnionFind.unionAll([String(dependent.update.id), String(supplier.update.id)]);
    }
  }

  const updateIdsByRoot = new Map<string, number[]>();
  for (const { update } of decoded) {
    const root = rowUnionFind.find(String(update.id));
    updateIdsByRoot.set(root, [...(updateIdsByRoot.get(root) ?? []), update.id]);
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
  return left.localeCompare(right, undefined, { numeric: true });
}
