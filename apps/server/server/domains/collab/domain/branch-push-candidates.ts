/** Builds the candidate batches an Apply stages: whole-draft, or the rows a review selected. */
import { randomUUID } from "node:crypto";
import type { UserId } from "@meridian/contracts/runtime";
import {
  type ApplyPayloads,
  BranchPushCommitConflictError,
  type CandidateBatch,
} from "./branch-push-contracts.js";
import type { DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot } from "./draft-store.js";

type CandidateSource = {
  documentDraft: DraftSnapshot;
  rows: DraftJournalRow[];
};

export function buildWholeDraftCandidates(input: {
  sources: readonly CandidateSource[];
  payloads?: ApplyPayloads;
  pushedByUserId?: UserId;
}): CandidateBatch {
  return {
    ...(input.payloads ? { payloads: input.payloads } : {}),
    candidates: input.sources.map((source) => ({
      draftId: source.documentDraft.draftId,
      documentId: source.documentDraft.documentId,
      rows: source.rows,
      materialization: "whole" as const,
    })),
    receiptId: randomUUID(),
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}

/** One draft's selected rows, fenced by the live revision the selection was made against. */
export function buildSelectedRowCandidates(input: {
  source: CandidateSource;
  journalIds: readonly number[];
  expectedLiveRevision: string;
  payloads?: ApplyPayloads;
  pushedByUserId?: UserId;
}): CandidateBatch {
  const selected = new Set(input.journalIds);
  if (selected.size === 0) throw new Error("selective_push_requires_rows");
  const rows = input.source.rows.filter((row) => selected.has(row.id));
  if (rows.length !== selected.size) {
    throw new BranchPushCommitConflictError(input.source.documentDraft.draftId);
  }
  return {
    ...(input.payloads ? { payloads: input.payloads } : {}),
    candidates: [
      {
        draftId: input.source.documentDraft.draftId,
        documentId: input.source.documentDraft.documentId,
        rows,
        materialization: "selected_rows",
      },
    ],
    receiptId: randomUUID(),
    expectedLiveRevision: input.expectedLiveRevision,
    ...(input.pushedByUserId ? { pushedByUserId: input.pushedByUserId } : {}),
  };
}
