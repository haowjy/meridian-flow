// Canonical document-scoped Yjs lineage ranges and their set algebra.

import type { ContentLineage } from "../ports/model.js";

export type LineageRange = {
  clientID: number;
  clock: number;
  length: number;
};

/** Kept as a vocabulary alias for callers that describe safety provenance. */
export type WriterLineageRange = LineageRange;

export function normalizeLineageRanges(ranges: readonly ContentLineage[]): LineageRange[] {
  const sorted = ranges.map(validateRange).sort(compareRanges);
  const normalized: LineageRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous && previous.clientID === range.clientID && range.clock <= rangeEnd(previous)) {
      previous.length = Math.max(rangeEnd(previous), rangeEnd(range)) - previous.clock;
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}

export function intersectLineageRanges(
  left: readonly ContentLineage[],
  right: readonly ContentLineage[],
): LineageRange[] {
  const a = normalizeLineageRanges(left);
  const b = normalizeLineageRanges(right);
  const result: LineageRange[] = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const x = a[ai];
    const y = b[bi];
    if (x.clientID < y.clientID || (x.clientID === y.clientID && rangeEnd(x) <= y.clock)) {
      ai += 1;
      continue;
    }
    if (y.clientID < x.clientID || (x.clientID === y.clientID && rangeEnd(y) <= x.clock)) {
      bi += 1;
      continue;
    }
    const from = Math.max(x.clock, y.clock);
    const to = Math.min(rangeEnd(x), rangeEnd(y));
    if (from < to) result.push({ clientID: x.clientID, clock: from, length: to - from });
    if (rangeEnd(x) <= rangeEnd(y)) ai += 1;
    if (rangeEnd(y) <= rangeEnd(x)) bi += 1;
  }
  return result;
}

export function lineageRangesContain(
  ranges: readonly ContentLineage[],
  candidate: ContentLineage,
): boolean {
  const wanted = validateRange(candidate);
  return normalizeLineageRanges(ranges).some(
    (range) =>
      range.clientID === wanted.clientID &&
      range.clock <= wanted.clock &&
      rangeEnd(range) >= rangeEnd(wanted),
  );
}

export function groupLineageRanges(
  ranges: readonly ContentLineage[],
): ReadonlyMap<number, readonly LineageRange[]> {
  const grouped = new Map<number, LineageRange[]>();
  for (const range of normalizeLineageRanges(ranges)) {
    const group = grouped.get(range.clientID) ?? [];
    group.push(range);
    grouped.set(range.clientID, group);
  }
  return grouped;
}

export function subtractLineageRanges(
  minuend: readonly ContentLineage[],
  ...subtrahends: ReadonlyArray<readonly ContentLineage[]>
): LineageRange[] {
  let remaining = normalizeLineageRanges(minuend);
  for (const subtrahend of subtrahends) {
    const removed = normalizeLineageRanges(subtrahend);
    remaining = remaining.flatMap((range) => subtractRange(range, removed));
  }
  return normalizeLineageRanges(remaining);
}

function subtractRange(source: LineageRange, removed: readonly LineageRange[]): LineageRange[] {
  let segments = [source];
  for (const cut of removed) {
    if (cut.clientID !== source.clientID) continue;
    segments = segments.flatMap((segment) => {
      const start = Math.max(segment.clock, cut.clock);
      const end = Math.min(rangeEnd(segment), rangeEnd(cut));
      if (start >= end) return [segment];
      return [
        ...(segment.clock < start ? [{ ...segment, length: start - segment.clock }] : []),
        ...(end < rangeEnd(segment)
          ? [{ ...segment, clock: end, length: rangeEnd(segment) - end }]
          : []),
      ];
    });
  }
  return segments;
}

function validateRange(value: unknown): LineageRange {
  if (!isRecord(value)) throw new Error("Lineage range must be an object");
  const { clientID, clock, length } = value;
  if (
    !Number.isSafeInteger(clientID) ||
    !Number.isSafeInteger(clock) ||
    !Number.isSafeInteger(length) ||
    (clientID as number) < 0 ||
    (clock as number) < 0 ||
    (length as number) <= 0 ||
    !Number.isSafeInteger((clock as number) + (length as number))
  ) {
    throw new Error("Lineage ranges require non-negative safe integers and positive length");
  }
  return { clientID: clientID as number, clock: clock as number, length: length as number };
}

function compareRanges(left: LineageRange, right: LineageRange): number {
  return left.clientID - right.clientID || left.clock - right.clock;
}

function rangeEnd(range: LineageRange): number {
  return range.clock + range.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
