/** Groups the complete draft difference into attributed, dependency-closed review classes. */

import type { ReviewDeletedSpan, ReviewHunk } from "@meridian/contracts/drafts";
import * as Y from "yjs";
import { assignReviewClasses } from "./branch-review-closure.js";
import {
  type ClockRange,
  type DraftUpdateAttributionIndex,
  deleteSetRanges,
  type IndexedDraftUpdate,
  indexDraftUpdates,
  type OperationClockRange,
} from "./draft-review-attribution.js";
import { hunkSpans, operationSemanticFields } from "./draft-review-presentation.js";
import type { DraftReviewDiagnostic, DraftReviewOperationInternal } from "./draft-review-types.js";

export type { ClockRange, IndexedDraftUpdate } from "./draft-review-attribution.js";

type OperationGraphHunk = {
  raw: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
    insertedText: string;
    deletedText: string;
  };
  review: ReviewHunk;
};

type DraftReviewOperationGraph = {
  hunks: ReviewHunk[];
  operations: DraftReviewOperationInternal[];
  diagnostics: DraftReviewDiagnostic[];
};

/**
 * Builds the logical operation graph used by inline draft review.
 *
 * Rows have three roles:
 * - sourceUpdateIds: logical rows displayed as the operation's authoring source.
 * - physical rows: source rows plus restorative/delete rows that currently carry
 *   or reverse that logical operation while replaying the draft journal.
 * - closureUpdateIds: physical rows that currently carry or reverse the
 *   logical operation.
 *
 * Invariant: a review class joins physical-row/visible-hunk overlap and Yjs
 * dependencies, and every class member carries the same closed row set.
 *
 * Span invariant: hunk spans are inserted-text-only, ordered, non-overlapping,
 * and cover the hunk's inserted ranges exactly once without changing source
 * identity. Deletions stay widget-level on ReviewHunk.deletedText.
 */
export function computeDraftReviewOperations(input: {
  baseDoc: Y.Doc;
  updates: readonly IndexedDraftUpdate[];
  hunks: readonly OperationGraphHunk[];
}): DraftReviewOperationGraph {
  const attribution = indexDraftUpdates({ baseDoc: input.baseDoc, updates: input.updates });
  const attributedHunks = input.hunks.map((hunk) => {
    const coverage = attribution.attributeRanges(hunk.raw);
    const complete =
      coverage.complete &&
      (!hunk.raw.insertedText || hunk.raw.insertedRanges.length > 0) &&
      (!hunk.raw.deletedText || hunk.raw.deletedRanges.length > 0);
    return { ...hunk, ...coverage, complete };
  });
  return groupOperationsForHunks(
    attributedHunks,
    attribution,
    input.updates,
    deleteSetRanges(Y.decodeUpdate(Y.encodeStateAsUpdate(input.baseDoc)).ds),
  );
}

type AttributedOperationGraphHunk = OperationGraphHunk & {
  operationIds: string[];
  complete: boolean;
  deletedSpans: ReviewDeletedSpan[];
  insertedAttribution: OperationClockRange[];
};

function groupOperationsForHunks(
  attributedHunks: readonly AttributedOperationGraphHunk[],
  attribution: DraftUpdateAttributionIndex,
  updates: readonly IndexedDraftUpdate[],
  baseDeletedRanges: readonly ClockRange[],
): DraftReviewOperationGraph {
  const hunks = attributedHunks.map((hunk) => {
    const attributionFields = {
      operationIds: [...hunk.operationIds].sort(operationSort),
      ...(!hunk.complete ? { unclassified: true } : {}),
      ...(attribution.hasInterleavedEdits(hunk.raw.insertedRanges) ? { mergeArtifact: true } : {}),
    };
    if (hunk.review.kind === "block")
      return { ...hunk.review, ...attributionFields } satisfies ReviewHunk;
    return {
      ...hunk.review,
      ...attributionFields,
      ...(!hunk.complete ? { insertedText: hunk.raw.insertedText } : {}),
      ...(hunk.raw.deletedText ? { deletedSpans: hunk.deletedSpans } : {}),
      spans: hunkSpans(hunk.insertedAttribution),
    } satisfies ReviewHunk;
  });

  const visibleOperationIds = new Set(hunks.flatMap((hunk) => hunk.operationIds));
  const operations = [...visibleOperationIds]
    .flatMap((operationId) => {
      const operation = attribution.byOperationId.get(operationId);
      if (!operation) return [];
      return [
        {
          operationId: operation.operationId,
          sourceUpdateIds: operation.sourceUpdateIds,
          closureUpdateIds: operation.physicalSourceUpdateIds,
          ...(operation.actorTurnId ? { actorTurnId: operation.actorTurnId } : {}),
          kind: operation.kind,
          ...(operation.actorUserId ? { actorUserId: operation.actorUserId } : {}),
          ...operationSemanticFields(operation.operationId, hunks, attributedHunks),
        },
      ];
    })
    .sort((a, b) => operationSort(a.operationId, b.operationId));
  const classified = assignReviewClasses({ hunks, operations, updates, baseDeletedRanges });
  const unclassifiedOperationIds = new Set(
    hunks.filter((hunk) => hunk.unclassified).flatMap((hunk) => hunk.operationIds),
  );
  const incompleteClasses = new Set(
    classified
      .filter((op) => unclassifiedOperationIds.has(op.operationId))
      .map((op) => op.closureClassId),
  );
  return {
    hunks,
    operations: classified.map((operation) => ({
      ...operation,
      ...(incompleteClasses.has(operation.closureClassId) ? { canApplyOrDiscard: false } : {}),
    })),
    diagnostics: hunks
      .filter((hunk) => hunk.unclassified)
      .map((hunk) => ({ code: "unattributed_hunk", hunkId: hunk.hunkId })),
  };
}

function operationSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}
