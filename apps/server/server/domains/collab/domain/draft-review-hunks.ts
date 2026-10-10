/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import type { AgentEditModel } from "@meridian/agent-edit/integration";
import type { ReviewHunk } from "@meridian/contracts/drafts";
import type * as Y from "yjs";
import {
  alignBlocks,
  type BlockSlot,
  blockContentShapesMatch,
  describeBlocks,
  diffAlignedBlocks,
  hunkDeletedRanges,
  hunkDisplayText,
  hunkInsertedRanges,
  type RawBlockDisplay,
  type RawBlockHunk,
  type RawHunk,
} from "./document-difference.js";
import {
  type ClockRange,
  computeDraftReviewOperations,
  type IndexedDraftUpdate,
} from "./draft-review-operations.js";
import type { DraftReviewDiagnostic, DraftReviewOperationInternal } from "./draft-review-types.js";

export type DraftReviewHunkInput = {
  liveDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
};

export type DraftReviewHunkResult = {
  operations: DraftReviewOperationInternal[];
  hunks: ReviewHunk[];
  diagnostics: DraftReviewDiagnostic[];
};

export function computeDraftReviewHunks(input: DraftReviewHunkInput): DraftReviewHunkResult {
  const liveBlocks = describeBlocks(input.liveDoc, input.model);
  const draftBlocks = describeBlocks(input.draftDoc, input.model);
  if (blockContentShapesMatch(liveBlocks, draftBlocks)) {
    return {
      operations: [],
      hunks: [],
      diagnostics: [],
    };
  }
  const alignment = alignBlocks(liveBlocks, draftBlocks);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const rawByHunkId = new Map<string, RawHunk>();
  const {
    hunks,
    operations: rawOperations,
    diagnostics,
  } = computeDraftReviewOperations({
    baseDoc: input.liveDoc,
    updates: input.draftUpdates,
    hunks: rawHunks.map((hunk, index) => {
      const hunkId = `h${index + 1}`;
      rawByHunkId.set(hunkId, hunk);
      return {
        raw: operationGraphRaw(hunk),
        review: reviewHunkFromRaw(hunk, hunkId),
      };
    }),
  });
  const visible = cancelRestorativeRejectBlockHunks({
    hunks,
    operations: rawOperations,
    rawByHunkId,
  });
  const operations = visible.operations;
  return {
    operations,
    diagnostics,
    hunks: visible.hunks,
  };
}

function operationGraphRaw(hunk: RawHunk): {
  insertedRanges: readonly ClockRange[];
  deletedRanges: readonly ClockRange[];
  insertedText: string;
  deletedText: string;
} {
  return {
    insertedRanges: hunkInsertedRanges(hunk),
    deletedRanges: hunkDeletedRanges(hunk),
    ...hunkDisplayText(hunk),
  };
}

function reviewHunkFromRaw(hunk: RawHunk, hunkId: string): ReviewHunk {
  switch (hunk.kind) {
    case "text":
      return {
        kind: "text",
        hunkId,
        operationIds: [],
        anchor: hunk.anchor,
        spans: [],
        ...(hunk.deletedText ? { deletedText: hunk.deletedText } : {}),
      };
    case "block":
      return {
        kind: "block",
        hunkId,
        operationIds: [],
        anchor: hunk.anchor,
        ...(hunk.insertedBlock ? { insertedBlock: reviewBlockDisplay(hunk.insertedBlock) } : {}),
        ...(hunk.deletedBlock ? { deletedBlock: reviewBlockDisplay(hunk.deletedBlock) } : {}),
      };
  }
}

function reviewBlockDisplay(block: RawBlockDisplay): { type: string; display: string } {
  return { type: block.type, display: block.display };
}

function cancelRestorativeRejectBlockHunks(input: {
  hunks: ReviewHunk[];
  operations: DraftReviewOperationInternal[];
  rawByHunkId: ReadonlyMap<string, RawHunk>;
}): { hunks: ReviewHunk[]; operations: DraftReviewOperationInternal[] } {
  const operationsById = new Map(
    input.operations.map((operation) => [operation.operationId, operation]),
  );
  const cancelled = new Set<string>();

  for (let leftIndex = 0; leftIndex < input.hunks.length; leftIndex += 1) {
    const left = input.hunks[leftIndex];
    if (!left || cancelled.has(left.hunkId)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < input.hunks.length; rightIndex += 1) {
      const right = input.hunks[rightIndex];
      if (!right || cancelled.has(right.hunkId)) continue;
      if (!isRestorativeRejectPair(left, right, input.rawByHunkId, operationsById)) continue;
      cancelled.add(left.hunkId);
      cancelled.add(right.hunkId);
      break;
    }
  }

  if (cancelled.size === 0) return { hunks: input.hunks, operations: input.operations };

  const hunks = input.hunks.filter((hunk) => !cancelled.has(hunk.hunkId));
  const visibleOperationIds = new Set(hunks.flatMap((hunk) => hunk.operationIds));
  const operations = input.operations.filter((operation) =>
    visibleOperationIds.has(operation.operationId),
  );
  return { hunks, operations };
}

function isRestorativeRejectPair(
  left: ReviewHunk,
  right: ReviewHunk,
  rawByHunkId: ReadonlyMap<string, RawHunk>,
  operationsById: ReadonlyMap<string, DraftReviewOperationInternal>,
): boolean {
  if (left.unclassified || right.unclassified) return false;
  const leftRaw = rawByHunkId.get(left.hunkId);
  const rightRaw = rawByHunkId.get(right.hunkId);
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw.kind !== "block" || rightRaw.kind !== "block") return false;
  if (!sameBlockSlot(leftRaw.blockSlot, rightRaw.blockSlot)) return false;
  const pair = restorativeRejectPairDirection(leftRaw, rightRaw);
  if (!pair) return false;

  const deleteHunk = pair.deleteSide === "left" ? left : right;
  const insertHunk = pair.insertSide === "left" ? left : right;
  if (deleteHunk === insertHunk) return false;

  return (
    hasOnlyOperationsOfKind(deleteHunk, operationsById, "agent") &&
    hasOnlyOperationsOfKind(insertHunk, operationsById, "writer")
  );
}

function hasOnlyOperationsOfKind(
  hunk: ReviewHunk,
  operationsById: ReadonlyMap<string, DraftReviewOperationInternal>,
  kind: "agent" | "writer",
): boolean {
  return (
    hunk.operationIds.length > 0 &&
    hunk.operationIds.every((operationId) => operationsById.get(operationId)?.kind === kind)
  );
}

function sameBlockSlot(left: BlockSlot | undefined, right: BlockSlot | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.beforeBlockId === right.beforeBlockId &&
    left.afterBlockId === right.afterBlockId
  );
}

function restorativeRejectPairDirection(
  left: RawBlockHunk,
  right: RawBlockHunk,
): { deleteSide: "left" | "right"; insertSide: "left" | "right" } | null {
  const leftDeletedMatchesRightInserted = blocksDisplayEqual(
    left.deletedBlock,
    right.insertedBlock,
  );
  if (leftDeletedMatchesRightInserted) return { deleteSide: "left", insertSide: "right" };

  const rightDeletedMatchesLeftInserted = blocksDisplayEqual(
    right.deletedBlock,
    left.insertedBlock,
  );
  if (rightDeletedMatchesLeftInserted) return { deleteSide: "right", insertSide: "left" };

  return null;
}

function blocksDisplayEqual(
  left: { type: string; display: string } | undefined,
  right: { type: string; display: string } | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.type === right.type &&
    left.display === right.display
  );
}
