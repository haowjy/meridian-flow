/** Builds the candidate batches a publication stages: whole-branch, or the rows a review selected. */
import { randomUUID } from "node:crypto";
import type { UserId } from "@meridian/contracts/runtime";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type CandidateBatch,
  type PublicationPayloads,
} from "./branch-push-contracts.js";
import type { BranchSnapshot } from "./branch-store.js";

type CandidateSource = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

export function buildWholeBranchCandidates(input: {
  sources: readonly CandidateSource[];
  payloads?: PublicationPayloads;
  pushedByUserId?: UserId;
}): CandidateBatch {
  return {
    ...(input.payloads ? { payloads: input.payloads } : {}),
    candidates: input.sources.map((source) => ({
      branchId: source.branch.branchId,
      documentId: source.branch.documentId,
      rows: source.rows,
      materialization: "whole" as const,
    })),
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}

/** One branch's selected rows, fenced by the live revision the selection was made against. */
export function buildSelectedRowCandidates(input: {
  source: CandidateSource;
  journalIds: readonly number[];
  expectedLiveRevision: string;
  payloads?: PublicationPayloads;
  pushedByUserId?: UserId;
}): CandidateBatch {
  const selected = new Set(input.journalIds);
  if (selected.size === 0) throw new Error("selective_push_requires_rows");
  const rows = input.source.rows.filter((row) => selected.has(row.id));
  if (rows.length !== selected.size) {
    throw new BranchPushCommitConflictError(input.source.branch.branchId);
  }
  return {
    ...(input.payloads ? { payloads: input.payloads } : {}),
    candidates: [
      {
        branchId: input.source.branch.branchId,
        documentId: input.source.branch.documentId,
        rows,
        materialization: "selected_rows",
      },
    ],
    receiptId: randomUUID(),
    expectedLiveRevision: input.expectedLiveRevision,
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}
