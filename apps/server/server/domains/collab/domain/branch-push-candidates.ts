/** Builds whole-content candidate batches with optional manifest membership companions. */
import { randomUUID } from "node:crypto";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type CandidateBatch,
} from "./branch-push-contracts.js";
import { manifestMembershipRowDocumentId } from "./manifest-membership-journal.js";

type CandidateSource = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

export function buildWholeBranchCandidates(input: {
  source: CandidateSource;
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
  const selected = new Set(input.journalIds);
  if (selected.size === 0) throw new Error("selective_push_requires_rows");
  const rows = input.source.rows.filter((row) => selected.has(row.id));
  if (rows.length !== selected.size) {
    throw new BranchPushCommitConflictError(input.source.branch.branchId);
  }
  return {
    candidates: [
      {
        branchId: input.source.branch.branchId,
        documentId: input.source.branch.documentId,
        rows,
        kind: "content",
        materialization: "selected_rows",
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
  pushedByUserId?: UserId;
  resetPolicy?: "auto";
}): CandidateBatch {
  const manifestRows = input.manifest.rows.filter(
    (row) => manifestMembershipRowDocumentId(row) === input.manifestEntryDocumentId,
  );
  return {
    candidates: [
      {
        branchId: input.content.branch.branchId,
        documentId: input.content.branch.documentId,
        rows: input.content.rows,
        kind: "content",
        materialization: "whole",
      },
      ...(manifestRows.length > 0
        ? [
            {
              branchId: input.manifest.branch.branchId,
              documentId: input.manifest.branch.documentId,
              rows: manifestRows,
              kind: "manifest" as const,
              materialization: "selected_rows" as const,
            },
          ]
        : []),
    ],
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
    ...(input.resetPolicy ? { resetPolicy: input.resetPolicy } : {}),
  };
}
