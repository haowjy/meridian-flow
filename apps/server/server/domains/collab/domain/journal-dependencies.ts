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
    parent?: string | YId | null;
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
  return [...structDependencies(decoded), ...deleteRanges(decoded)];
}

function structDependencies(decoded: DecodedUpdateLike): ClockRange[] {
  const refs: ClockRange[] = [];
  for (const struct of decoded.structs ?? []) {
    if (struct.origin) refs.push({ ...struct.origin, length: 1 });
    if (struct.rightOrigin) refs.push({ ...struct.rightOrigin, length: 1 });
    if (isYId(struct.parent)) refs.push({ ...struct.parent, length: 1 });
  }
  return refs;
}

export function hasDependentLaterRows(
  selectedRows: readonly JournalDependencyRow[],
  laterRows: readonly JournalDependencyRow[],
): boolean {
  const selectedSupplied: ClockRange[] = [];
  const selectedDeleted: ClockRange[] = [];
  for (const row of selectedRows) {
    const decoded = decodeUpdateForDependencies(row.updateData);
    selectedSupplied.push(...suppliedRanges(decoded));
    // Yjs update delete sets can be cumulative for a state-vector diff, so a
    // later delete-only row may name ranges deleted by earlier rows too. We
    // accept that as a conservative false-positive dependency: it can withhold
    // an otherwise-safe selective undo, but never allows a lossy undo.
    selectedDeleted.push(...deleteRanges(decoded));
  }
  if (selectedSupplied.length === 0 && selectedDeleted.length === 0) return false;
  return laterRows.some((row) => {
    const decoded = decodeUpdateForDependencies(row.updateData);
    return (
      dependencies(decoded).some((dependency) =>
        selectedSupplied.some((range) => rangesOverlap(range, dependency)),
      ) ||
      structDependencies(decoded).some((dependency) =>
        selectedDeleted.some((range) => rangesOverlap(range, dependency)),
      )
    );
  });
}

function isYId(value: unknown): value is YId {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as YId).client === "number" &&
    typeof (value as YId).clock === "number"
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
