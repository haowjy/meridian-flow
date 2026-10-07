/** Groups the complete draft difference into attributed, dependency-closed review classes. */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { assignReviewClasses } from "./branch-review-closure.js";
import {
  type ClockRange,
  type DraftOperationContributionFlags,
  type DraftUpdateAttributionIndex,
  deleteSetRanges,
  type IndexedDraftUpdate,
  type IndexedOperation,
  indexDraftUpdates,
  type OperationClockRange,
} from "./draft-review-attribution.js";
import { hunkSpans, operationSemanticFields } from "./draft-review-presentation.js";
import type {
  DraftReviewDeletedSpanInternal,
  DraftReviewDiagnostic,
  DraftReviewHunkInternal,
  DraftReviewOperationContribution,
  DraftReviewOperationInternal,
  PhysicalSourceUpdateId,
  SourceUpdateId,
} from "./draft-review-types.js";

export type { ClockRange, IndexedDraftUpdate } from "./draft-review-attribution.js";

type OperationGraphHunk = {
  raw: {
    insertedRanges: readonly ClockRange[];
    deletedRanges: readonly ClockRange[];
    insertedText: string;
    deletedText: string;
    blockKey: string;
    blockIndex: number;
  };
  review: DraftReviewHunkInternal;
};

type DraftReviewOperationGraph = {
  hunks: DraftReviewHunkInternal[];
  operations: DraftReviewOperationInternal[];
  diagnostics: DraftReviewDiagnostic[];
};

type WriterGroup = {
  operationId: string | null;
  sourceUpdateIds: Set<SourceUpdateId>;
  physicalSourceUpdateIds: Set<PhysicalSourceUpdateId>;
  contribution: DraftOperationContributionFlags;
  actorUserId: string;
  hunkIndexes: Set<number>;
  lastBlockKey: string;
  lastBlockIndex: number;
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
 * and cover the hunk's inserted ranges exactly once after writer operation id
 * remapping. Deletions stay widget-level on DraftReviewHunkInternal.deletedText.
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
  deletedSpans: DraftReviewDeletedSpanInternal[];
  insertedAttribution: OperationClockRange[];
};

function groupOperationsForHunks(
  attributedHunks: readonly AttributedOperationGraphHunk[],
  attribution: DraftUpdateAttributionIndex,
  updates: readonly IndexedDraftUpdate[],
  baseDeletedRanges: readonly ClockRange[],
): DraftReviewOperationGraph {
  const writerGroups: WriterGroup[] = [];
  const writerOperationIdsByHunk = new Map<number, Set<string>>();
  const contributionByOperationId = new Map<string, DraftOperationContributionFlags>();

  for (const [hunkIndex, hunk] of attributedHunks.entries()) {
    const hunkContributions = attribution.operationContributionsForRanges({
      insertedRanges: hunk.raw.insertedRanges,
      deletedRanges: hunk.raw.deletedRanges,
    });
    for (const [operationId, contribution] of hunkContributions) {
      mergeContribution(contributionByOperationId, operationId, contribution);
    }
    const writerOperations = hunk.operationIds
      .map((operationId) => attribution.byOperationId.get(operationId))
      .filter((operation): operation is IndexedOperation => operation?.kind === "writer");
    for (const [actorUserId, operations] of groupWriterOperationsByActor(writerOperations)) {
      let group = writerGroups.at(-1);
      if (!group || !canJoinWriterGroup(group, hunk.raw, actorUserId)) {
        group = {
          operationId: null,
          sourceUpdateIds: new Set(),
          physicalSourceUpdateIds: new Set(),
          contribution: { inserted: false, deleted: false },
          actorUserId,
          hunkIndexes: new Set(),
          lastBlockKey: hunk.raw.blockKey,
          lastBlockIndex: hunk.raw.blockIndex,
        };
        writerGroups.push(group);
      }
      for (const operation of operations) {
        for (const updateId of operation.sourceUpdateIds) group.sourceUpdateIds.add(updateId);
        for (const updateId of operation.physicalSourceUpdateIds) {
          group.physicalSourceUpdateIds.add(updateId);
        }
        const contribution = hunkContributions.get(operation.operationId);
        if (contribution) mergeContributionInto(group.contribution, contribution);
      }
      group.hunkIndexes.add(hunkIndex);
      group.lastBlockKey = hunk.raw.blockKey;
      group.lastBlockIndex = hunk.raw.blockIndex;
    }
  }

  for (const group of writerGroups)
    group.operationId = stableWriterOperationId(group.sourceUpdateIds);

  const writerOperationIdRemapByHunk = new Map<number, Map<string, string>>();
  for (const [hunkIndex] of attributedHunks.entries()) {
    for (const group of writerGroups) {
      if (!group.hunkIndexes.has(hunkIndex) || !group.operationId) continue;
      const ids = writerOperationIdsByHunk.get(hunkIndex) ?? new Set<string>();
      ids.add(group.operationId);
      writerOperationIdsByHunk.set(hunkIndex, ids);
      const rawIds = writerOperationIdRemapByHunk.get(hunkIndex) ?? new Map<string, string>();
      for (const updateId of group.sourceUpdateIds) rawIds.set(String(updateId), group.operationId);
      writerOperationIdRemapByHunk.set(hunkIndex, rawIds);
    }
  }

  const hunks = attributedHunks.map((hunk, hunkIndex) => {
    const agentOperationIds = hunk.operationIds.filter(
      (operationId) => attribution.byOperationId.get(operationId)?.kind !== "writer",
    );
    const writerRemap = writerOperationIdRemapByHunk.get(hunkIndex) ?? new Map<string, string>();
    const operationIds = [
      ...agentOperationIds,
      ...(writerOperationIdsByHunk.get(hunkIndex) ?? []),
    ].sort(operationSort);
    if (hunk.review.kind === "block") {
      return {
        ...hunk.review,
        operationIds,
        ...(!hunk.complete ? { unclassified: true } : {}),
        ...(attribution.hasInterleavedEdits(hunk.raw.insertedRanges)
          ? { mergeArtifact: true }
          : {}),
      } satisfies DraftReviewHunkInternal;
    }
    return {
      ...hunk.review,
      operationIds,
      ...(!hunk.complete ? { unclassified: true, insertedText: hunk.raw.insertedText } : {}),
      ...(attribution.hasInterleavedEdits(hunk.raw.insertedRanges) ? { mergeArtifact: true } : {}),
      ...(hunk.raw.deletedText ? { deletedSpans: hunk.deletedSpans } : {}),
      spans: hunkSpans(hunk.insertedAttribution, writerRemap),
    } satisfies DraftReviewHunkInternal;
  });

  const hunkCounts = new Map<string, number>();
  for (const hunk of hunks) {
    for (const operationId of hunk.operationIds) {
      hunkCounts.set(operationId, (hunkCounts.get(operationId) ?? 0) + 1);
    }
  }

  const agentOperations = [...hunkCounts.entries()]
    .flatMap(([operationId, hunkCount]) => {
      const operation = attribution.byOperationId.get(operationId);
      if (!operation || operation.kind === "writer") return [];
      return [
        {
          operationId: operation.operationId,
          sourceUpdateIds: operation.sourceUpdateIds,
          closureUpdateIds: operation.physicalSourceUpdateIds,
          ...(operation.actorTurnId ? { actorTurnId: operation.actorTurnId } : {}),
          kind: "agent" as const,
          contribution: operationContribution(contributionByOperationId.get(operation.operationId)),
          ...operationSemanticFields(operation.operationId, hunks, attributedHunks),
          hunkCount,
        },
      ];
    })
    .sort((a, b) => operationSort(a.operationId, b.operationId));
  const writerOperations = writerGroups.map(
    (group) =>
      ({
        operationId: group.operationId ?? stableWriterOperationId(group.sourceUpdateIds),
        sourceUpdateIds: [...group.sourceUpdateIds].sort((a, b) => a - b),
        closureUpdateIds: [...group.physicalSourceUpdateIds].sort((a, b) => a - b),
        actorUserId: group.actorUserId,
        kind: "writer",
        contribution: operationContribution(group.contribution),
        ...operationSemanticFields(
          group.operationId ?? stableWriterOperationId(group.sourceUpdateIds),
          hunks,
          attributedHunks,
        ),
        hunkCount: group.hunkIndexes.size,
      }) satisfies Omit<DraftReviewOperationInternal, "closureClassId">,
  );
  const operations = [...agentOperations, ...writerOperations].sort((a, b) =>
    operationSort(a.operationId, b.operationId),
  );
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

function stableWriterOperationId(sourceUpdateIds: ReadonlySet<SourceUpdateId>): string {
  const sorted = [...sourceUpdateIds].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const hash = createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 10);
  return `writer:${min}-${hash}`;
}

function mergeContribution(
  contributions: Map<string, DraftOperationContributionFlags>,
  operationId: string,
  contribution: DraftOperationContributionFlags,
): void {
  const current = contributions.get(operationId) ?? { inserted: false, deleted: false };
  mergeContributionInto(current, contribution);
  contributions.set(operationId, current);
}

function mergeContributionInto(
  target: DraftOperationContributionFlags,
  contribution: DraftOperationContributionFlags,
): void {
  target.inserted ||= contribution.inserted;
  target.deleted ||= contribution.deleted;
}

function operationContribution(
  contribution: DraftOperationContributionFlags | undefined,
): DraftReviewOperationContribution {
  if (!contribution) return "edited";
  if (contribution.inserted && contribution.deleted) return "rewrote";
  if (contribution.inserted) return "added";
  if (contribution.deleted) return "removed";
  return "edited";
}

function groupWriterOperationsByActor(
  operations: readonly IndexedOperation[],
): Map<string, IndexedOperation[]> {
  const byActor = new Map<string, IndexedOperation[]>();
  for (const operation of operations) {
    if (!operation.actorUserId) continue;
    byActor.set(operation.actorUserId, [...(byActor.get(operation.actorUserId) ?? []), operation]);
  }
  return byActor;
}

function canJoinWriterGroup(
  group: WriterGroup,
  hunk: { blockKey: string; blockIndex: number },
  actorUserId: string,
): boolean {
  if (group.actorUserId !== actorUserId) return false;
  return group.lastBlockKey === hunk.blockKey || hunk.blockIndex <= group.lastBlockIndex + 1;
}

function operationSort(left: string, right: string): number {
  const leftWriter = left.startsWith("writer:");
  const rightWriter = right.startsWith("writer:");
  if (leftWriter && rightWriter) return writerSortKey(left).localeCompare(writerSortKey(right));
  if (leftWriter !== rightWriter) return leftWriter ? 1 : -1;
  return left.localeCompare(right);
}

function writerSortKey(operationId: string): string {
  const match = /^writer:(\d+)-/.exec(operationId);
  return `${String(match ? Number(match[1]) : Number.MAX_SAFE_INTEGER).padStart(12, "0")}:${operationId}`;
}
