/** Builds server-authoritative selective-Discard classes. */

import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
  PhysicalSourceUpdateIds,
} from "./draft-review-types.js";

/**
 * One Discard class joins operations that share a visible hunk or a physical
 * journal row. Physical rows include the later rows that carry or reverse a
 * logical operation, so overlap is the review model's causal/dependent edge.
 */
export function assignDiscardClasses(input: {
  operations: readonly Omit<DraftReviewOperationInternal, "closureClassId">[];
  hunks: readonly DraftReviewHunkInternal[];
}): DraftReviewOperationInternal[] {
  const unionFind = new UnionFind();
  for (const operation of input.operations) unionFind.add(operation.operationId);

  for (const hunk of input.hunks) unionFind.unionAll(hunk.operationIds);

  const operationIdsByUpdateId = new Map<number, string[]>();
  for (const operation of input.operations) {
    for (const updateId of operation.discardUpdateIds) {
      const operationIds = operationIdsByUpdateId.get(updateId) ?? [];
      operationIds.push(operation.operationId);
      operationIdsByUpdateId.set(updateId, operationIds);
    }
  }
  for (const operationIds of operationIdsByUpdateId.values()) {
    unionFind.unionAll(operationIds);
  }

  const operationsByRoot = new Map<string, typeof input.operations>();
  for (const operation of input.operations) {
    const root = unionFind.find(operation.operationId);
    operationsByRoot.set(root, [...(operationsByRoot.get(root) ?? []), operation]);
  }

  const classByOperationId = new Map<
    string,
    { closureClassId: string; discardUpdateIds: PhysicalSourceUpdateIds }
  >();
  for (const operations of operationsByRoot.values()) {
    const operationIds = operations.map((operation) => operation.operationId).sort(operationSort);
    const discardUpdateIds = [
      ...new Set(operations.flatMap((operation) => operation.discardUpdateIds)),
    ].sort((left, right) => left - right);
    const closureClassId = `closure:${operationIds.join("+")}`;
    for (const operationId of operationIds) {
      classByOperationId.set(operationId, { closureClassId, discardUpdateIds });
    }
  }

  return input.operations.map((operation) => ({
    ...operation,
    ...(classByOperationId.get(operation.operationId) ?? {
      closureClassId: `closure:${operation.operationId}`,
      discardUpdateIds: operation.discardUpdateIds,
    }),
  }));
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
