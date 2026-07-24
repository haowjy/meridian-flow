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
}): CandidateBatch {
  const contentRows = input.contentJournalIds
    ? selectedRows(input.content, input.contentJournalIds, "selective_push_requires_rows")
    : input.content.rows;
  const manifestRows = input.manifest.rows.filter(
    (row) => manifestMembershipRowDocumentId(row) === input.manifestEntryDocumentId,
  );
  return {
    candidates: [
      {
        branchId: input.content.branch.branchId,
        documentId: input.content.branch.documentId,
        rows: contentRows,
        kind: "content",
        materialization: input.contentJournalIds ? "selected_rows" : "whole",
        conflictPolicy: input.conflictPolicy,
        sweepPolicy: "project",
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
            },
          ]
        : []),
    ],
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
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
