/** Computes live-vs-draft review hunks and per-operation attribution for active drafts. */

import type { AgentEditModel } from "@meridian/agent-edit/integration";
import type { ReviewBlockDisplay, ReviewHunk } from "@meridian/contracts/drafts";
import type * as Y from "yjs";
import {
  diffAlignedBlocks,
  documentDifference,
  hunkDeletedRanges,
  hunkDisplayText,
  hunkInsertedRanges,
  type RawBlockDisplay,
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
  const alignment = documentDifference(input.liveDoc, input.draftDoc, input.model);

  const rawHunks = diffAlignedBlocks(alignment, input.draftDoc);
  const { hunks, operations, diagnostics } = computeDraftReviewOperations({
    baseDoc: input.liveDoc,
    updates: input.draftUpdates,
    hunks: rawHunks.map((hunk, index) => {
      const hunkId = `h${index + 1}`;
      return {
        raw: operationGraphRaw(hunk),
        review: reviewHunkFromRaw(hunk, hunkId),
      };
    }),
  });
  return { operations, diagnostics, hunks };
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
        ...(hunk.deletedBlockId ? { deletedBlockId: hunk.deletedBlockId } : {}),
      };
    case "block":
      return {
        kind: "block",
        ...(hunk.formatting ? { formatting: hunk.formatting } : {}),
        hunkId,
        operationIds: [],
        anchor: hunk.anchor,
        ...(hunk.insertedBlock ? { insertedBlock: reviewBlockDisplay(hunk.insertedBlock) } : {}),
        ...(hunk.deletedBlock ? { deletedBlock: reviewBlockDisplay(hunk.deletedBlock) } : {}),
      };
  }
}

function reviewBlockDisplay(block: RawBlockDisplay): ReviewBlockDisplay {
  return {
    type: block.type,
    display: block.display,
    ...(block.blockId ? { blockId: block.blockId } : {}),
  };
}
