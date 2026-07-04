/** Shared hunk-sharing graph traversal for accept and reject closure metadata. */

export function hunkSharingClosureFromHunks(
  seedOperationIds: readonly string[],
  hunks: readonly { operationIds: readonly string[] }[],
): string[] {
  const operationIdsByHunk = hunks.map((hunk) => new Set(hunk.operationIds));
  const hunkIndexesByOperation = new Map<string, number[]>();
  for (const [index, hunk] of hunks.entries()) {
    for (const operationId of hunk.operationIds) {
      const indexes = hunkIndexesByOperation.get(operationId) ?? [];
      indexes.push(index);
      hunkIndexesByOperation.set(operationId, indexes);
    }
  }
  return hunkSharingClosure(seedOperationIds, operationIdsByHunk, hunkIndexesByOperation);
}

export function hunkSharingClosure(
  seedOperationIds: readonly string[],
  operationIdsByHunk: readonly Set<string>[],
  hunkIndexesByOperation: ReadonlyMap<string, readonly number[]>,
): string[] {
  const closure = new Set<string>();
  const queue = [...seedOperationIds];
  while (queue.length > 0) {
    const operationId = queue.shift();
    if (!operationId || closure.has(operationId)) continue;
    closure.add(operationId);
    for (const hunkIndex of hunkIndexesByOperation.get(operationId) ?? []) {
      for (const nextOperationId of operationIdsByHunk[hunkIndex] ?? []) {
        if (!closure.has(nextOperationId)) queue.push(nextOperationId);
      }
    }
  }
  return [...closure];
}
