// Canonical document-scoped Yjs lineage ranges and their set algebra.

import type { ContentLineage } from "../ports/model.js";

export type LineageRange = {
  clientID: number;
  clock: number;
  length: number;
};

/** Kept as a vocabulary alias for callers that describe safety provenance. */
export type WriterLineageRange = LineageRange;

export type { ResponseCausalCutV1 } from "@meridian/contracts";

export type SealedWriterLineageV3 = {
  version: 3;
  documentId: string;
  protectedRoots: LineageRange[];
  responseCausalCutId: string;
};

export type WriterProtectionRootView = {
  provenanceOf(documentId: string, root: LineageRange): "writer_protected" | "agent" | null;
};

export type SettlementLineageEvidenceV2 = {
  version: 2;
  items: Array<{
    evidenceId: string;
    authoringResponseId: string;
    token: SealedWriterLineageV3;
  }>;
};

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

export function sealedWriterLineageV3(input: {
  documentId: string;
  protectedRoots: readonly ContentLineage[];
  responseCausalCutId: string;
}): SealedWriterLineageV3 {
  if (input.documentId.length === 0) throw new Error("Lineage token documentId must not be empty");
  if (input.responseCausalCutId.length === 0) {
    throw new Error("Lineage token responseCausalCutId must not be empty");
  }
  return {
    version: 3,
    documentId: input.documentId,
    protectedRoots: normalizeLineageRanges(input.protectedRoots),
    responseCausalCutId: input.responseCausalCutId,
  };
}

export function parseSealedWriterLineageV3(value: unknown): SealedWriterLineageV3 {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    typeof value.documentId !== "string" ||
    typeof value.responseCausalCutId !== "string"
  ) {
    throw new Error("Invalid sealed writer lineage v3 token");
  }
  if (
    value.documentId.length === 0 ||
    value.responseCausalCutId.length === 0 ||
    !Array.isArray(value.protectedRoots)
  ) {
    throw new Error("Lineage token requires a document, causal cut, and protected roots");
  }
  const protectedRoots = value.protectedRoots.map(validateRange);
  assertNormalized(protectedRoots);
  return {
    version: 3,
    documentId: value.documentId,
    responseCausalCutId: value.responseCausalCutId,
    protectedRoots: protectedRoots.map((range) => ({ ...range })),
  };
}

/** Fail closed unless every claimed protection root is classified by the canonical view. */
export function validateWriterProtectionScope(
  token: SealedWriterLineageV3,
  view: WriterProtectionRootView,
): SealedWriterLineageV3 {
  for (const root of token.protectedRoots) {
    if (view.provenanceOf(token.documentId, root) !== "writer_protected") {
      throw new Error("Writer protection scope contains an unresolved or non-writer root");
    }
  }
  return token;
}

function assertNormalized(ranges: readonly LineageRange[]): void {
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
