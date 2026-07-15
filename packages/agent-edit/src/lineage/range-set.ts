// Canonical document-scoped Yjs lineage range tokens and set operations.

import type { ContentLineage } from "../ports/model.js";

export type WriterLineageRange = {
  clientID: number;
  clock: number;
  length: number;
};

export type SealedWriterLineageV2 = {
  version: 2;
  documentId: string;
  ranges: WriterLineageRange[];
};

export type SettlementLineageEvidenceV1 = {
  version: 1;
  items: Array<{
    evidenceId: string;
    authoringResponseId: string;
    token: SealedWriterLineageV2;
  }>;
};

export function normalizeLineageRanges(ranges: readonly ContentLineage[]): WriterLineageRange[] {
  const sorted = ranges.map(validateRange).sort(compareRanges);
  const normalized: WriterLineageRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous && previous.clientID === range.clientID && range.clock <= rangeEnd(previous)) {
      previous.length = Math.max(rangeEnd(previous), rangeEnd(range)) - previous.clock;
      continue;
    }
    normalized.push({ ...range });
  }
  return normalized;
}

export function subtractLineageRanges(
  minuend: readonly ContentLineage[],
  ...subtrahends: ReadonlyArray<readonly ContentLineage[]>
): WriterLineageRange[] {
  let remaining = normalizeLineageRanges(minuend);
  for (const subtrahend of subtrahends) {
    const removed = normalizeLineageRanges(subtrahend);
    remaining = remaining.flatMap((range) => subtractRange(range, removed));
  }
  return normalizeLineageRanges(remaining);
}

export function sealedWriterLineageV2(input: {
  documentId: string;
  ranges: readonly ContentLineage[];
}): SealedWriterLineageV2 {
  if (input.documentId.length === 0) throw new Error("Lineage token documentId must not be empty");
  const ranges = normalizeLineageRanges(input.ranges);
  if (ranges.length === 0) throw new Error("Lineage token ranges must not be empty");
  return { version: 2, documentId: input.documentId, ranges };
}

export function parseSealedWriterLineageV2(value: unknown): SealedWriterLineageV2 {
  if (!isRecord(value) || value.version !== 2 || typeof value.documentId !== "string") {
    throw new Error("Invalid sealed writer lineage v2 token");
  }
  if (value.documentId.length === 0 || !Array.isArray(value.ranges) || value.ranges.length === 0) {
    throw new Error("Lineage token requires a document and non-empty ranges");
  }
  const ranges = value.ranges.map(validateRange);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (compareRanges(previous, current) >= 0) {
      throw new Error("Lineage token ranges must be sorted and unique");
    }
    if (previous.clientID === current.clientID && current.clock <= rangeEnd(previous)) {
      throw new Error("Lineage token ranges must be merged and non-overlapping");
    }
  }
  return {
    version: 2,
    documentId: value.documentId,
    ranges: ranges.map((range) => ({ ...range })),
  };
}

function subtractRange(
  source: WriterLineageRange,
  removed: readonly WriterLineageRange[],
): WriterLineageRange[] {
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

function validateRange(value: unknown): WriterLineageRange {
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

function compareRanges(left: WriterLineageRange, right: WriterLineageRange): number {
  return left.clientID - right.clientID || left.clock - right.clock;
}

function rangeEnd(range: WriterLineageRange): number {
  return range.clock + range.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
