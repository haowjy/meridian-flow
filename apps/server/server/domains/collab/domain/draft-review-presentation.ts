/** UI-facing presentation fields for draft review operations and hunks. */
import type {
  ReviewHunk,
  ReviewHunkSpan,
  ReviewOperationClassification,
} from "@meridian/contracts/drafts";
import * as Y from "yjs";

export type PresentationClockRange = {
  client: number;
  clock: number;
  length: number;
  operationId: string;
};

type PresentationGraphHunk = {
  raw: {
    insertedText: string;
    deletedText: string;
  };
};

export function operationSemanticFields(
  operationId: string,
  hunks: readonly ReviewHunk[],
  attributedHunks: readonly PresentationGraphHunk[],
): {
  classification: ReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
} {
  const pairs = hunks.flatMap((hunk, index) => {
    if (!hunk.operationIds.includes(operationId)) return [];
    const raw = attributedHunks[index]?.raw;
    return raw ? [{ before: raw.deletedText, after: raw.insertedText }] : [];
  });
  const first = pairs[0];
  return {
    classification: classifyOperationPairs(pairs),
    ...(first?.before ? { beforeExcerpt: excerpt(first.before) } : {}),
    ...(first?.after ? { afterExcerpt: excerpt(first.after) } : {}),
  };
}

function classifyOperationPairs(
  pairs: readonly { before: string; after: string }[],
): ReviewOperationClassification {
  const nonEmptyPairs = pairs
    .map(({ before, after }) => ({ before: before.trim(), after: after.trim() }))
    .filter(({ before, after }) => before.length > 0 && after.length > 0);
  const uniquePairs = new Set(nonEmptyPairs.map(({ before, after }) => `${before}\u0000${after}`));
  if (nonEmptyPairs.length >= 2 && uniquePairs.size === 1) return "rename";

  const hasInserted = pairs.some(({ after }) => after.length > 0);
  const hasDeleted = pairs.some(({ before }) => before.length > 0);
  if (hasInserted && !hasDeleted) return "addition";
  if (hasDeleted && !hasInserted) return "removal";
  return "rewrite";
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const limit = 60;
  if (normalized.length <= limit) return normalized;
  const boundary = normalized.lastIndexOf(" ", limit - 1);
  const end = boundary >= 40 ? boundary : limit - 1;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

export function hunkSpans(
  ranges: readonly PresentationClockRange[],
  writerOperationIdRemap: ReadonlyMap<string, string>,
): ReviewHunkSpan[] {
  return ranges.map((range) => ({
    anchorFrom: encodeClockRelativePosition(range.client, range.clock, "start"),
    anchorTo: encodeClockRelativePosition(range.client, range.clock + range.length - 1, "end"),
    operationId: writerOperationIdRemap.get(range.operationId) ?? range.operationId,
  }));
}

function encodeClockRelativePosition(
  client: number,
  clock: number,
  boundary: "start" | "end",
): string {
  const assoc = boundary === "end" ? -1 : 0;
  return Buffer.from(
    Y.encodeRelativePosition(new Y.RelativePosition(null, null, Y.createID(client, clock), assoc)),
  ).toString("base64");
}
