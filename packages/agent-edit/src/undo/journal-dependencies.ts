/**
 * Yjs update dependency predicates: the one rule for whether a later update
 * depends on earlier ones, shared by undo planning, live undo persistence and
 * branch review closure.
 */
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

/** A journal row; `seq` orders it against other rows when known. */
export type JournalDependencyRow = { seq?: number; updateData: Uint8Array | Buffer };

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

export function structDependencies(decoded: DecodedUpdateLike): ClockRange[] {
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
  return laterRows.some(dependsOnRows(selectedRows));
}

/**
 * Decodes the selected rows once and returns whether a later row depends on
 * them: it anchors on, parents into, or deletes what they inserted, or anchors
 * on what they deleted. When both rows carry a journal seq, only selected rows
 * before the later row count; a row cannot depend on one written after it.
 */
export function dependsOnRows(
  selectedRows: readonly JournalDependencyRow[],
): (laterRow: JournalDependencyRow) => boolean {
  const selected = selectedRows.map((row) => {
    const decoded = decodeUpdateForDependencies(row.updateData);
    return {
      seq: row.seq,
      supplied: suppliedRanges(decoded),
      // Yjs update delete sets can be cumulative for a state-vector diff, so a
      // later delete-only row may name ranges deleted by earlier rows too. We
      // accept that as a conservative false-positive dependency: it can withhold
      // an otherwise-safe selective undo, but never allows a lossy undo.
      deleted: deleteRanges(decoded),
    };
  });
  if (selected.every((row) => row.supplied.length === 0 && row.deleted.length === 0)) {
    return () => false;
  }
  return (laterRow) => {
    const earlier = selected.filter(
      (row) => row.seq === undefined || laterRow.seq === undefined || row.seq < laterRow.seq,
    );
    const decoded = decodeUpdateForDependencies(laterRow.updateData);
    const anchors = structDependencies(decoded);
    const touched = [...anchors, ...deleteRanges(decoded)];
    return earlier.some(
      (row) =>
        touched.some((dependency) =>
          row.supplied.some((range) => rangesOverlap(range, dependency)),
        ) ||
        anchors.some((dependency) => row.deleted.some((range) => rangesOverlap(range, dependency))),
    );
  };
}

function isYId(value: unknown): value is YId {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as YId).client === "number" &&
    typeof (value as YId).clock === "number"
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
