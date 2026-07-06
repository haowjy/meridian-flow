/** Yjs update dependency predicates shared by review closure and undo affordances. */
import * as Y from "yjs";

export type ClockRange = { client: number; clock: number; length: number };

type YId = { client: number; clock: number };

export type DecodedUpdateLike = {
  structs?: Array<{
    id?: YId;
    length?: number;
    origin?: YId | null;
    rightOrigin?: YId | null;
  }>;
  ds?: { clients?: Map<number, Array<{ clock: number; len?: number; length?: number }>> };
};

export type JournalDependencyRow = { updateData: Uint8Array | Buffer };

export function decodeUpdateForDependencies(updateData: Uint8Array | Buffer): DecodedUpdateLike {
  return Y.decodeUpdate(new Uint8Array(updateData)) as DecodedUpdateLike;
}

export function suppliedRanges(decoded: DecodedUpdateLike): ClockRange[] {
  return (decoded.structs ?? []).flatMap((struct) => {
    const id = struct.id;
    const length = typeof struct.length === "number" ? struct.length : 0;
    return id && length > 0 ? [{ client: id.client, clock: id.clock, length }] : [];
  });
}

export function deleteRanges(decoded: DecodedUpdateLike): ClockRange[] {
  const ranges: ClockRange[] = [];
  for (const [client, items] of decoded.ds?.clients ?? []) {
    for (const item of items) {
      ranges.push({ client, clock: item.clock, length: item.len ?? item.length ?? 1 });
    }
  }
  return ranges;
}

export function dependencies(decoded: DecodedUpdateLike): ClockRange[] {
  const refs: ClockRange[] = [];
  for (const struct of decoded.structs ?? []) {
    if (struct.origin) refs.push({ ...struct.origin, length: 1 });
    if (struct.rightOrigin) refs.push({ ...struct.rightOrigin, length: 1 });
  }
  refs.push(...deleteRanges(decoded));
  return refs;
}

export function hasDependentLaterRows(
  selectedRows: readonly JournalDependencyRow[],
  laterRows: readonly JournalDependencyRow[],
): boolean {
  const selectedSupplied = selectedRows.flatMap((row) =>
    suppliedRanges(decodeUpdateForDependencies(row.updateData)),
  );
  if (selectedSupplied.length === 0) return laterRows.length > 0;
  return laterRows.some((row) =>
    dependencies(decodeUpdateForDependencies(row.updateData)).some((dependency) =>
      selectedSupplied.some((range) => rangesOverlap(range, dependency)),
    ),
  );
}

export function suppliedRangesForRows(rows: readonly JournalDependencyRow[]): ClockRange[] {
  return rows.flatMap((row) => suppliedRanges(decodeUpdateForDependencies(row.updateData)));
}

export function updateDeletesOutsideRanges(
  updateData: Uint8Array,
  ownedRanges: readonly ClockRange[],
): boolean {
  return deleteRanges(decodeUpdateForDependencies(updateData)).some(
    (deleted) => !ownedRanges.some((owned) => rangesOverlap(owned, deleted)),
  );
}

export function rangeCovers(candidate: ClockRange, expected: ClockRange): boolean {
  return (
    candidate.client === expected.client &&
    candidate.clock <= expected.clock &&
    candidate.clock + candidate.length >= expected.clock + expected.length
  );
}

export function rangesOverlap(left: ClockRange, right: ClockRange): boolean {
  return (
    left.client === right.client &&
    left.clock < right.clock + right.length &&
    right.clock < left.clock + left.length
  );
}
