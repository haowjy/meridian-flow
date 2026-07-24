/** Builds candidate batches for whole, selective, and companion branch pushes. */
import { randomUUID } from "node:crypto";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type CandidateBatch,
} from "./branch-push-contracts.js";

type CandidateSource = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

type CandidateBatchBuildResult =
  | { kind: "batch"; batch: CandidateBatch }
  | { kind: "no_active_rows"; branch: BranchSnapshot };

export function buildWholeBranchCandidates(input: {
  source: CandidateSource;
  conflictPolicy: "refuse" | "apply_and_trail";
  resetPolicy?: "auto";
  pushedByUserId?: UserId;
}): CandidateBatch {
  return {
    candidates: [
      {
        branchId: input.source.branch.branchId,
        documentId: input.source.branch.documentId,
        rows: input.source.rows,
        kind: "content",
        materialization: "whole",
        conflictPolicy: input.conflictPolicy,
        sweepPolicy: "project",
        noticePolicy: "required",
      },
    ],
    receiptId: randomUUID(),
    ...(input.resetPolicy ? { resetPolicy: input.resetPolicy } : {}),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}

export function buildSelectedRowCandidates(input: {
  source: CandidateSource;
  journalIds: readonly number[];
  pushedByUserId?: UserId;
}): CandidateBatch {
  const selected = selectedRows(input.source, input.journalIds, "selective_push_requires_rows");
  return {
    candidates: [
      {
        branchId: input.source.branch.branchId,
        documentId: input.source.branch.documentId,
        rows: selected,
        kind: "content",
        materialization: "selected_rows",
        conflictPolicy: "refuse",
        sweepPolicy: "none",
        noticePolicy: "best_effort",
      },
    ],
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}

export function buildCompanionCandidates(input: {
  content: CandidateSource;
  manifest: CandidateSource;
  manifestEntryDocumentId: DocumentId;
  contentJournalIds?: readonly number[];
  conflictPolicy: "refuse" | "apply_and_trail";
  pushedByUserId?: UserId;
}): CandidateBatchBuildResult {
  let contentRows = input.content.rows;
  if (input.contentJournalIds) {
    const selected = new Set(input.contentJournalIds);
    contentRows = input.content.rows.filter((row) => selected.has(row.id));
    if (contentRows.length === 0) {
      return { kind: "no_active_rows", branch: input.content.branch };
    }
    if (contentRows.length !== selected.size) {
      throw new BranchPushCommitConflictError(input.content.branch.branchId);
    }
  }
  const manifestRows = input.manifest.rows.filter(
    (row) => manifestMembershipRowDocumentId(row) === input.manifestEntryDocumentId,
  );
  return {
    kind: "batch",
    batch: {
      candidates: [
        {
          branchId: input.content.branch.branchId,
          documentId: input.content.branch.documentId,
          rows: contentRows,
          kind: "content",
          materialization: input.contentJournalIds ? "selected_rows" : "whole",
          conflictPolicy: input.conflictPolicy,
          sweepPolicy: "project",
          noticePolicy: "best_effort",
        },
        ...(manifestRows.length > 0
          ? [
              {
                branchId: input.manifest.branch.branchId,
                documentId: input.manifest.branch.documentId,
                rows: manifestRows,
                kind: "manifest" as const,
                materialization: "selected_rows" as const,
                conflictPolicy: "refuse" as const,
                sweepPolicy: "none" as const,
                noticePolicy: "best_effort" as const,
              },
            ]
          : []),
      ],
      receiptId: randomUUID(),
      ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
    },
  };
}

function selectedRows(
  source: CandidateSource,
  journalIds: readonly number[],
  emptySelectionError: string,
): BranchJournalRow[] {
  const selected = new Set(journalIds);
  if (selected.size === 0) throw new Error(emptySelectionError);
  const rows = source.rows.filter((row) => selected.has(row.id));
  if (rows.length !== selected.size) {
    throw new BranchPushCommitConflictError(source.branch.branchId);
  }
  return rows;
}

function manifestMembershipRowDocumentId(row: BranchJournalRow): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}
